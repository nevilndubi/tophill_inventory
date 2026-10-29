import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuditService } from '../apps/api/src/audit/audit.service';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import { ConditionEventsService } from '../apps/api/src/machines/condition-events.service';
import { ConditionService } from '../apps/api/src/machines/condition.service';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { UsageClockService } from '../apps/api/src/usage/usage-clock.service';
import { UsageEventsService } from '../apps/api/src/usage/usage-events.service';
import { UsageService } from '../apps/api/src/usage/usage.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const suppliedBranchId = process.env.TASK42_PROOF_BRANCH_ID?.trim();
const suppliedBranchName = process.env.TASK42_PROOF_BRANCH_NAME?.trim();
const suppliedDirectHost = process.env.TASK42_PROOF_DIRECT_HOST?.trim();
const usesSuppliedBranch = Boolean(suppliedBranchId && suppliedBranchName && suppliedDirectHost);

const connectionForHost = (source: string, host: string): string => {
  const url = new URL(source);
  url.hostname = host;
  return url.toString();
};

const hostname = (url: string): string => new URL(url).hostname;
const clientFor = (connectionString: string, max = 5): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max }) });
const redactDatabaseUrls = (value: string): string =>
  value.replaceAll(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]');
const runQuietly = (args: string[], environment: NodeJS.ProcessEnv, output = false): string => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args[0] ?? ''} failed safely: ${redactDatabaseUrls(result.stderr.trim())}`,
    );
  }
  return output ? result.stdout.trim() : '';
};

const codeOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('response' in error)) return 'unknown';
  const response = error.response;
  return typeof response === 'object' && response !== null && 'code' in response
    ? String(response.code)
    : 'unknown';
};

const actorFrom = (row: {
  department: { code: string; id: string; name: string } | null;
  fullName: string;
  id: string;
  role: AuthenticatedUser['role'];
}): AuthenticatedUser => ({
  department: row.department,
  email: 'redacted',
  fullName: row.fullName,
  id: row.id,
  isActive: true,
  role: row.role,
});

const usageServiceFor = (
  prisma: PrismaClient,
  audit: AuditService = new AuditService(),
): UsageService =>
  new UsageService(
    prisma as unknown as PrismaService,
    audit,
    new UsageEventsService(),
    new UsageClockService(),
  );

const conditionServiceFor = (prisma: PrismaClient): ConditionService =>
  new ConditionService(
    prisma as unknown as PrismaService,
    new AuditService(),
    new ConditionEventsService(),
  );

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  const contenders: PrismaClient[] = [];
  try {
    if (usesSuppliedBranch) {
      branch = { id: suppliedBranchId!, name: suppliedBranchName! };
    } else {
      const suffix = new Date()
        .toISOString()
        .replaceAll(/[-:.TZ]/gu, '')
        .slice(0, 12);
      branch = createNeonBranchSafely(
        projectId,
        'main',
        `ephemeral/task-4.2-usage-${suffix}`,
        new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      );
    }
    console.log(`Disposable Neon branch created (${branch.id}); credentials remained captured.`);
    const direct = usesSuppliedBranch
      ? connectionForHost(process.env.DIRECT_URL!, suppliedDirectHost!)
      : getNeonConnectionStringCaptured(projectId, branch.id, false);
    const pooled = usesSuppliedBranch
      ? connectionForHost(
          process.env.DATABASE_URL!,
          suppliedDirectHost!.replace(/^([^.]+)/u, '$1-pooler'),
        )
      : getNeonConnectionStringCaptured(projectId, branch.id, true);
    const protectedHosts = usesSuppliedBranch
      ? hostname(process.env.DATABASE_URL!)
      : [
          hostname(getNeonConnectionStringCaptured(projectId, 'main', true)),
          hostname(getNeonConnectionStringCaptured(projectId, 'staging', true)),
        ].join(',');
    const databaseEnvironment = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: protectedHosts,
    };
    runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Migration chain and guarded seed passed on the disposable branch.');

    prisma = clientFor(pooled, 25);
    const service = usageServiceFor(prisma);
    const staffRow = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'STAFF' },
    });
    const adminRow = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'SUPER_ADMIN' },
    });
    const managerRow = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'DEPT_MANAGER' },
    });
    const staff = actorFrom(staffRow);
    const admin = actorFrom(adminRow);
    const manager = actorFrom(managerRow);

    const targets = await prisma.machine.findMany({
      orderBy: { assetTag: 'asc' },
      take: 10,
      where: {
        condition: 'OPERATIONAL',
        deletedAt: null,
        bookings: {
          none: {
            blockedUntil: { gt: new Date() },
            status: 'CONFIRMED',
          },
        },
        usageSessions: { none: { endedAt: null } },
      },
    });
    if (targets.length < 10) throw new Error('Disposable seed has too few usage proof targets');
    const [
      basic,
      needsService,
      unavailable,
      forced,
      concurrent,
      boundary,
      afterBoundary,
      own,
      started,
      rollback,
    ] = targets;
    if (
      !basic ||
      !needsService ||
      !unavailable ||
      !forced ||
      !concurrent ||
      !boundary ||
      !afterBoundary ||
      !own ||
      !started ||
      !rollback
    ) {
      throw new Error('Usage proof targets are missing');
    }

    const checkedOut = await service.checkOut(
      staff,
      basic.id,
      { expectedEndAt: new Date(Date.now() + 60 * 60_000).toISOString() },
      'task-4.2-basic-out',
    );
    const checkedIn = await service.checkIn(
      staff,
      basic.id,
      { force: false, note: 'Equipment returned safely' },
      'task-4.2-basic-in',
    );
    if (!checkedIn.endedAt || checkedOut.id !== checkedIn.id)
      throw new Error('Basic usage proof failed');
    console.log('Basic usage proof: checkout=success holder_checkin=success audit_rows=2.');

    await prisma.machine.update({
      data: { allowBookingWhenNeedsService: true, condition: 'NEEDS_SERVICE' },
      where: { id: needsService.id },
    });
    const needs = await service.checkOut(staff, needsService.id, {}, 'task-4.2-needs-service');
    await service.checkIn(staff, needsService.id, { force: false }, 'task-4.2-needs-service-in');
    await prisma.machine.update({
      data: { condition: 'UNDER_MAINTENANCE' },
      where: { id: unavailable.id },
    });
    let unavailableCode = 'none';
    try {
      await service.checkOut(staff, unavailable.id, {}, 'task-4.2-unavailable');
    } catch (error: unknown) {
      unavailableCode = codeOf(error);
    }
    if (!needs.id || unavailableCode !== 'MACHINE_NOT_AVAILABLE') {
      throw new Error('Condition eligibility proof failed');
    }
    console.log(`Condition proof: needs_service=allowed unavailable=${unavailableCode}.`);

    const forcedSession = await service.checkOut(staff, forced.id, {}, 'task-4.2-force-out');
    await conditionServiceFor(prisma).transition(forced.id, 'OUT_OF_SERVICE', {
      actor: admin,
      force: true,
      fromCondition: 'OPERATIONAL',
      reason: 'Unsafe equipment discovered during active use',
      requestId: 'task-4.2-force-condition',
      source: 'MANUAL',
    });
    const stillOpen = await prisma.usageSession.count({
      where: { endedAt: null, id: forcedSession.id },
    });
    await service.checkIn(staff, forced.id, { force: false }, 'task-4.2-force-in');
    if (stillOpen !== 1) throw new Error('Forced condition transition altered the session');
    console.log(
      'Condition independence proof: forced_out_of_service=session_open holder_checkin=success.',
    );

    const databaseNow = (
      await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`
    )[0]?.now;
    if (!databaseNow) throw new Error('Database clock unavailable');
    const expected = new Date(databaseNow.getTime() + 2 * 60 * 60_000);
    await prisma.booking.create({
      data: {
        blockedUntil: new Date(expected.getTime() + 60 * 60_000),
        endsAt: new Date(expected.getTime() + 60 * 60_000),
        machineId: boundary.id,
        purpose: 'Scheduled equipment use',
        requestedByUserId: admin.id,
        startsAt: expected,
        status: 'CONFIRMED',
      },
    });
    let boundaryCode = 'none';
    try {
      await service.checkOut(
        staff,
        boundary.id,
        { expectedEndAt: expected.toISOString() },
        'task-4.2-boundary',
      );
    } catch (error: unknown) {
      boundaryCode = codeOf(error);
    }
    await prisma.booking.create({
      data: {
        blockedUntil: new Date(expected.getTime() + 60 * 60_000),
        endsAt: new Date(expected.getTime() + 60 * 60_000),
        machineId: afterBoundary.id,
        purpose: 'Scheduled equipment use',
        requestedByUserId: admin.id,
        startsAt: new Date(expected.getTime() + 1),
        status: 'CONFIRMED',
      },
    });
    const afterBoundarySession = await service.checkOut(
      staff,
      afterBoundary.id,
      { expectedEndAt: expected.toISOString() },
      'task-4.2-after-boundary',
    );
    await service.checkIn(staff, afterBoundary.id, { force: false }, 'task-4.2-after-boundary-in');
    await prisma.booking.create({
      data: {
        blockedUntil: new Date(expected.getTime() + 60 * 60_000),
        endsAt: new Date(expected.getTime() + 60 * 60_000),
        machineId: own.id,
        purpose: 'Own scheduled equipment use',
        requestedByUserId: staff.id,
        startsAt: new Date(databaseNow.getTime() + 10 * 60_000),
        status: 'CONFIRMED',
      },
    });
    await service.checkOut(staff, own.id, {}, 'task-4.2-own-booking');
    await service.checkIn(staff, own.id, { force: false }, 'task-4.2-own-booking-in');
    await prisma.booking.create({
      data: {
        blockedUntil: new Date(databaseNow.getTime() + 10 * 60_000),
        endsAt: new Date(databaseNow.getTime() + 10 * 60_000),
        machineId: started.id,
        purpose: 'Started scheduled equipment use',
        requestedByUserId: admin.id,
        startsAt: new Date(databaseNow.getTime() - 5 * 60_000),
        status: 'CONFIRMED',
      },
    });
    let startedCode = 'none';
    try {
      await service.checkOut(staff, started.id, {}, 'task-4.2-started-booking');
    } catch (error: unknown) {
      startedCode = codeOf(error);
    }
    if (
      boundaryCode !== 'UPCOMING_BOOKING_CONFLICT' ||
      !afterBoundarySession.id ||
      startedCode !== 'UPCOMING_BOOKING_CONFLICT'
    ) {
      throw new Error('Booking guard proof failed');
    }
    console.log(
      `Booking guard proof: exact_boundary=${boundaryCode} plus_1ms=allowed own_booking=allowed already_started=${startedCode}.`,
    );

    const sameDepartmentSession = await prisma.usageSession.findFirst({
      include: { machine: true },
      where: {
        endedAt: null,
        machine: { departmentId: manager.department!.id },
        userId: { not: manager.id },
      },
    });
    const otherDepartmentSession = await prisma.usageSession.findFirst({
      include: { machine: true },
      where: {
        endedAt: null,
        machine: { departmentId: { not: manager.department!.id } },
        userId: { not: manager.id },
      },
    });
    if (!sameDepartmentSession || !otherDepartmentSession) {
      throw new Error('Seeded force-end sessions do not cover manager department scope');
    }
    await service.checkIn(
      manager,
      sameDepartmentSession.machineId,
      { force: true, reason: 'Department handover confirmed safely' },
      'task-4.2-force-same-department',
    );
    let scopeCode = 'none';
    try {
      await service.checkIn(
        manager,
        otherDepartmentSession.machineId,
        { force: true, reason: 'Cross department force attempt' },
        'task-4.2-force-other-department',
      );
    } catch (error: unknown) {
      scopeCode = codeOf(error);
    }
    if (scopeCode !== 'PERMISSION_DENIED')
      throw new Error('Department force-end scope proof failed');
    console.log(`Force-end scope proof: own_department=success cross_department=${scopeCode}.`);

    const rollbackBefore = await prisma.usageSession.count({ where: { machineId: rollback.id } });
    const failingAudit = {
      record: async () => {
        throw new Error('Controlled audit failure');
      },
    } as unknown as AuditService;
    try {
      await usageServiceFor(prisma, failingAudit).checkOut(
        staff,
        rollback.id,
        {},
        'task-4.2-rollback',
      );
      throw new Error('Controlled rollback unexpectedly succeeded');
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== 'Controlled audit failure') throw error;
    }
    const rollbackAfter = await prisma.usageSession.count({ where: { machineId: rollback.id } });
    if (rollbackAfter !== rollbackBefore) throw new Error('Usage audit rollback proof failed');
    console.log('Rollback proof: session_rows_unchanged=true audit_rows=0.');

    for (let index = 0; index < 20; index += 1) contenders.push(clientFor(pooled, 1));
    const results = await Promise.allSettled(
      contenders.map((client, index) =>
        usageServiceFor(client).checkOut(staff, concurrent.id, {}, `task-4.2-concurrent-${index}`),
      ),
    );
    const successes = results.filter((result) => result.status === 'fulfilled').length;
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && codeOf(result.reason) === 'MACHINE_IN_USE',
    ).length;
    if (successes !== 1 || conflicts !== 19) {
      const rejectionCodes = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .reduce<Record<string, number>>((counts, result) => {
          const code = codeOf(result.reason);
          counts[code] = (counts[code] ?? 0) + 1;
          return counts;
        }, {});
      throw new Error(
        `20-way checkout proof failed safely: successes=${successes} codes=${JSON.stringify(rejectionCodes)}`,
      );
    }
    console.log(
      `Concurrency proof: attempts=20 successes=${successes} MACHINE_IN_USE=${conflicts}.`,
    );

    const diff = runQuietly(
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--config',
        'prisma7.config.ts',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      databaseEnvironment,
      true,
    );
    if (!diff.includes('No difference detected'))
      throw new Error('Prisma drift output was unexpected');
    console.log('Prisma migrate diff: No difference detected.');
  } finally {
    await Promise.allSettled(contenders.map((client) => client.$disconnect()));
    await prisma?.$disconnect();
    if (branch && !usesSuppliedBranch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    } else if (branch) {
      console.log(`Disposable Neon branch ready for orchestrated deletion (${branch.id}).`);
    }
  }
};

void main().catch((error: unknown) => {
  console.error(
    `[task-4.2-live] ${redactDatabaseUrls(error instanceof Error ? error.message : 'Unknown failure')}`,
  );
  process.exitCode = 1;
});
