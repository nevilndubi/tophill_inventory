import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { BookingPolicyService } from '../apps/api/src/booking/booking-policy.service';
import { BookingService } from '../apps/api/src/booking/booking.service';
import { PrismaClient, type Role } from '../apps/api/src/generated/prisma/client';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const hostname = (value: string): string => new URL(value).hostname;
const redact = (value: string): string =>
  value.replaceAll(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]');
const runQuietly = (args: string[], environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args[0] ?? ''} failed safely: ${redact(result.stderr || result.stdout)}`,
    );
  }
};

const roundedFuture = (now: Date, minutes: number): Date => {
  const value = new Date(now.getTime() + minutes * 60_000);
  value.setUTCSeconds(0, 0);
  if (value <= now) value.setUTCMinutes(value.getUTCMinutes() + 1);
  return value;
};
const codeOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('getResponse' in error)) return 'UNEXPECTED';
  const response = (error as { getResponse: () => unknown }).getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    ? String(response.code)
    : 'UNEXPECTED';
};
const expectCode = async (operation: Promise<unknown>, expected: string): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    if (codeOf(error) === expected) return;
    throw new Error(`Expected ${expected}, received ${codeOf(error)}`, { cause: error });
  }
  throw new Error(`Expected ${expected}, operation succeeded`);
};
const isMissingTableError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('meta' in error))
    return false;
  const meta = error.meta;
  if (typeof meta !== 'object' || meta === null || !('driverAdapterError' in meta)) return false;
  const driverError = meta.driverAdapterError;
  if (typeof driverError !== 'object' || driverError === null || !('cause' in driverError))
    return false;
  const cause = driverError.cause;
  return (
    error.code === 'P2010' &&
    typeof cause === 'object' &&
    cause !== null &&
    'originalCode' in cause &&
    cause.originalCode === '42P01'
  );
};

type ExplainNode = { 'Index Name'?: string; Plans?: ExplainNode[] };
type ExplainDocument = { 'Execution Time': number; Plan: ExplainNode };
const indexesFrom = (node: ExplainNode, values = new Set<string>()): Set<string> => {
  if (node['Index Name']) values.add(node['Index Name']);
  for (const child of node.Plans ?? []) indexesFrom(child, values);
  return values;
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  try {
    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/gu, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'main',
      `ephemeral/task-5.4-lifecycle-${suffix}`,
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable empty-parent Neon branch ready (${branch.id}); credentials captured.`);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const environment = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: [
        hostname(getNeonConnectionStringCaptured(projectId, 'main', true)),
        hostname(getNeonConnectionStringCaptured(projectId, 'staging', true)),
      ].join(','),
    };
    runQuietly(['prisma:migrate:deploy'], environment);
    runQuietly(['db:seed'], environment);
    runQuietly(['test:integration'], {
      ...environment,
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
      DIRECT_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    });
    console.log('Migration chain, guarded seed and guarded integration suite passed.');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pooled, max: 30 }) });
    const departments = await prisma.department.findMany({ orderBy: { code: 'asc' }, take: 2 });
    const category = await prisma.machineCategory.findFirstOrThrow();
    if (departments.length < 2) throw new Error('Two proof departments were not available');
    const [departmentA, departmentB] = departments;
    if (!departmentA || !departmentB) throw new Error('Department proof setup failed safely');
    const locations = await prisma.location.findMany({ take: 2 });
    const location = locations[0];
    if (!location) throw new Error('Location proof setup failed safely');

    const makeUser = async (role: Role, departmentId: string | null, label: string) => {
      const suffix = randomUUID();
      return prisma!.user.create({
        data: {
          departmentId,
          email: `${label}-${suffix}${String.fromCharCode(64)}invalid.local`,
          fullName: `Task 5.4 ${label}`,
          isSeedData: false,
          role,
          supabaseUserId: randomUUID(),
        },
        select: {
          department: { select: { code: true, id: true, name: true } },
          fullName: true,
          id: true,
          isActive: true,
          role: true,
        },
      });
    };
    const actorFrom = (value: Awaited<ReturnType<typeof makeUser>>): AuthenticatedUser => ({
      department: value.department,
      email: 'redacted',
      fullName: value.fullName,
      id: value.id,
      isActive: value.isActive,
      role: value.role,
    });
    const makeMachine = async (
      label: string,
      departmentId: string,
      requiresApproval = false,
      bufferMinutes = 15,
    ) =>
      prisma!.machine.create({
        data: {
          bufferMinutes,
          categoryId: category.id,
          departmentId,
          isBookable: true,
          locationId: location.id,
          manufacturer: `Task54-${label}`,
          model: 'Lifecycle proof',
          name: `Task 5.4 ${label}`,
          requiresApproval,
          serialNumber: `TASK54-${label}-${randomUUID()}`,
        },
        select: { id: true },
      });

    const requester = actorFrom(await makeUser('STAFF', departmentA.id, 'requester'));
    const viewer = actorFrom(await makeUser('VIEWER', departmentA.id, 'viewer'));
    const manager = actorFrom(await makeUser('DEPT_MANAGER', departmentA.id, 'manager'));
    const otherManager = actorFrom(await makeUser('DEPT_MANAGER', departmentB.id, 'other-manager'));
    const admin = actorFrom(await makeUser('ADMIN', null, 'admin'));
    const secondAdmin = actorFrom(await makeUser('SUPER_ADMIN', null, 'second-admin'));
    const selfAdmin = actorFrom(await makeUser('ADMIN', departmentA.id, 'self-admin'));
    const apiPrisma = prisma as unknown as PrismaService;
    const service = new BookingService(
      apiPrisma,
      new BookingPolicyService(apiPrisma),
      new AuditService(),
    );
    const clockRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const asOf = clockRows[0]?.now;
    if (!asOf) throw new Error('Database clock proof failed safely');
    const base = roundedFuture(asOf, 180);
    const requestFor = (machineId: string, offsetMinutes = 0, durationMinutes = 60) => {
      const starts = new Date(base.getTime() + offsetMinutes * 60_000);
      const ends = new Date(starts.getTime() + durationMinutes * 60_000);
      return {
        ends_at: ends.toISOString(),
        machine_id: machineId,
        purpose: 'Task54 proof routine monitoring',
        starts_at: starts.toISOString(),
      };
    };

    const directMachine = await makeMachine('direct', departmentA.id);
    const directCreated = await service.create(
      requester,
      requestFor(directMachine.id),
      randomUUID(),
    );
    const requesterList = await service.list(requester, {
      order: 'asc',
      page: 1,
      page_size: 25,
      sort: 'starts_at',
      view: 'mine',
      when: 'all',
    });
    if (!requesterList.items.some((item) => item.id === directCreated.booking.id))
      throw new Error('Requester list proof failed safely');
    const purposeEdited = await service.update(
      requester,
      directCreated.booking.id,
      {
        expected_updated_at: (await service.get(requester, directCreated.booking.id)).updated_at,
        purpose: 'Task54 proof ward round',
      },
      randomUUID(),
    );
    if (purposeEdited.status !== 'CONFIRMED')
      throw new Error('Purpose-only status proof failed safely');

    const approvalMachine = await makeMachine('approval', departmentA.id, true, 20);
    const pending = await service.create(
      requester,
      requestFor(approvalMachine.id, 240),
      randomUUID(),
    );
    if (pending.booking.status !== 'PENDING')
      throw new Error('Pending creation proof failed safely');
    const managed = await service.list(manager, {
      order: 'asc',
      page: 1,
      page_size: 25,
      sort: 'starts_at',
      view: 'managed',
      when: 'all',
    });
    if (!managed.items.some((item) => item.id === pending.booking.id))
      throw new Error('Managed-list proof failed safely');
    const approved = await service.approve(
      manager,
      pending.booking.id,
      { note: 'Capacity verified' },
      randomUUID(),
    );
    if (approved.status !== 'CONFIRMED' || approved.approved_or_decided_by?.id !== manager.id)
      throw new Error('Department approval proof failed safely');

    const selfMachine = await makeMachine('self', departmentA.id, true);
    const selfPending = await service.create(
      selfAdmin,
      requestFor(selfMachine.id, 480),
      randomUUID(),
    );
    await expectCode(
      service.approve(selfAdmin, selfPending.booking.id, {}, randomUUID()),
      'BOOKING_SELF_APPROVAL_DENIED',
    );
    await expectCode(
      service.reject(selfAdmin, selfPending.booking.id, { note: 'Self decision' }, randomUUID()),
      'BOOKING_SELF_APPROVAL_DENIED',
    );
    const fallback = await service.approve(admin, selfPending.booking.id, {}, randomUUID());
    if (fallback.status !== 'CONFIRMED') throw new Error('Fallback approval proof failed safely');

    const crossMachine = await makeMachine('cross', departmentB.id, true);
    const crossBooking = await service.create(
      requester,
      requestFor(crossMachine.id, 720),
      randomUUID(),
    );
    await expectCode(service.get(manager, crossBooking.booking.id), 'BOOKING_NOT_FOUND');
    const globalList = await service.list(admin, {
      order: 'asc',
      page: 1,
      page_size: 100,
      sort: 'created_at',
      view: 'all',
      when: 'all',
    });
    if (!globalList.items.some((item) => item.id === crossBooking.booking.id))
      throw new Error('Global list proof failed safely');
    const crossManaged = await service.list(otherManager, {
      order: 'asc',
      page: 1,
      page_size: 25,
      sort: 'starts_at',
      view: 'managed',
      when: 'all',
    });
    if (!crossManaged.items.some((item) => item.id === crossBooking.booking.id))
      throw new Error('Second-department managed proof failed safely');

    const viewerMachine = await makeMachine('viewer-cancel', departmentA.id);
    const viewerRow = await prisma.booking.create({
      data: {
        blockedUntil: new Date(base.getTime() + 975 * 60_000),
        endsAt: new Date(base.getTime() + 960 * 60_000),
        machineId: viewerMachine.id,
        purpose: 'Task54 proof viewer cancellation',
        requestedByUserId: viewer.id,
        startsAt: new Date(base.getTime() + 900 * 60_000),
        status: 'CONFIRMED',
      },
    });
    const viewerCancelled = await service.cancel(
      viewer,
      viewerRow.id,
      { reason: 'Plans changed' },
      randomUUID(),
    );
    const repeated = await service.cancel(
      viewer,
      viewerRow.id,
      { reason: 'Repeated request' },
      randomUUID(),
    );
    if (
      viewerCancelled.status !== 'CANCELLED' ||
      repeated.cancelled_at !== viewerCancelled.cancelled_at
    )
      throw new Error('Viewer/idempotent cancellation proof failed safely');

    const managerCancelMachine = await makeMachine('manager-cancel', departmentA.id);
    const managerCancel = await service.create(
      requester,
      requestFor(managerCancelMachine.id, 1_000),
      randomUUID(),
    );
    if (
      (
        await service.cancel(
          manager,
          managerCancel.booking.id,
          { reason: 'Operational change' },
          randomUUID(),
        )
      ).status !== 'CANCELLED'
    )
      throw new Error('Manager cancellation proof failed safely');

    const pastMachine = await makeMachine('past', departmentA.id, true);
    const pastRow = await prisma.booking.create({
      data: {
        blockedUntil: new Date(asOf.getTime() - 30 * 60_000),
        endsAt: new Date(asOf.getTime() - 45 * 60_000),
        machineId: pastMachine.id,
        purpose: 'Task54 proof elapsed request',
        requestedByUserId: requester.id,
        startsAt: new Date(asOf.getTime() - 105 * 60_000),
        status: 'PENDING',
      },
    });
    await expectCode(service.approve(admin, pastRow.id, {}, randomUUID()), 'BOOKING_START_PASSED');
    if (
      (await service.reject(admin, pastRow.id, { note: 'Request expired' }, randomUUID()))
        .status !== 'REJECTED'
    )
      throw new Error('Past rejection proof failed safely');

    const boundaryMachine = await makeMachine('boundary', departmentA.id, false, 15);
    const first = await service.create(
      requester,
      requestFor(boundaryMachine.id, 1_200),
      randomUUID(),
    );
    const second = await service.create(
      requester,
      requestFor(boundaryMachine.id, 1_350),
      randomUUID(),
    );
    const secondDto = await service.get(requester, second.booking.id);
    const adjacentStart = new Date(first.booking.blocked_until);
    const adjacentEnd = new Date(adjacentStart.getTime() + 60 * 60_000);
    await prisma.booking.update({
      data: { blockedUntil: new Date(adjacentStart.getTime() + 1) },
      where: { id: first.booking.id },
    });
    await expectCode(
      service.update(
        requester,
        second.booking.id,
        {
          ends_at: adjacentEnd.toISOString(),
          expected_updated_at: secondDto.updated_at,
          starts_at: adjacentStart.toISOString(),
        },
        randomUUID(),
      ),
      'BOOKING_CONFLICT',
    );
    const unchanged = await service.get(requester, second.booking.id);
    if (unchanged.starts_at !== secondDto.starts_at)
      throw new Error('Conflict rollback changed original booking');
    await prisma.booking.update({
      data: { blockedUntil: adjacentStart },
      where: { id: first.booking.id },
    });
    const adjacent = await service.update(
      requester,
      second.booking.id,
      {
        ends_at: adjacentEnd.toISOString(),
        expected_updated_at: unchanged.updated_at,
        starts_at: adjacentStart.toISOString(),
      },
      randomUUID(),
    );
    if (adjacent.starts_at !== adjacentStart.toISOString())
      throw new Error('Exact adjacency proof failed safely');

    const raceMachine = await makeMachine('approval-race', departmentA.id, true);
    const racePending = await service.create(
      requester,
      requestFor(raceMachine.id, 1_600),
      randomUUID(),
    );
    const approvalRace = await Promise.allSettled([
      service.approve(admin, racePending.booking.id, {}, randomUUID()),
      service.approve(secondAdmin, racePending.booking.id, {}, randomUUID()),
    ]);
    const raceSuccesses = approvalRace.filter((result) => result.status === 'fulfilled').length;
    const raceCodes = approvalRace
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => codeOf(result.reason));
    if (
      raceSuccesses !== 1 ||
      raceCodes.some((code) => !['BOOKING_NOT_PENDING', 'MACHINE_BUSY'].includes(code))
    )
      throw new Error('Simultaneous approval invariant failed safely');

    const mixedMachine = await makeMachine('mixed-race', departmentA.id, true);
    const mixedPending = await service.create(
      requester,
      requestFor(mixedMachine.id, 1_800),
      randomUUID(),
    );
    const mixedRace = await Promise.allSettled([
      service.approve(admin, mixedPending.booking.id, {}, randomUUID()),
      service.cancel(requester, mixedPending.booking.id, { reason: 'Plans changed' }, randomUUID()),
    ]);
    const mixedSuccesses = mixedRace.filter((result) => result.status === 'fulfilled').length;
    const mixedCodes = mixedRace
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => codeOf(result.reason));
    if (
      mixedSuccesses < 1 ||
      mixedSuccesses > 2 ||
      mixedCodes.some((code) => !['BOOKING_NOT_PENDING', 'MACHINE_BUSY'].includes(code))
    )
      throw new Error('Approve/cancel race invariant failed safely');
    const finalMixed = await prisma.booking.findUniqueOrThrow({
      where: { id: mixedPending.booking.id },
    });
    if (!['CONFIRMED', 'CANCELLED'].includes(finalMixed.status))
      throw new Error('Mixed race produced invalid terminal state');
    const mixedAuditActions = (
      await prisma.auditLog.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { action: true },
        where: {
          action: { in: ['booking.approved', 'booking.cancelled'] },
          entityId: mixedPending.booking.id,
          entityType: 'booking',
        },
      })
    ).map((row) => row.action);
    const mixedAuditValid =
      (finalMixed.status === 'CONFIRMED' &&
        mixedAuditActions.length === 1 &&
        mixedAuditActions[0] === 'booking.approved') ||
      (finalMixed.status === 'CANCELLED' &&
        (mixedAuditActions.join(',') === 'booking.cancelled' ||
          mixedAuditActions.join(',') === 'booking.approved,booking.cancelled'));
    if (!mixedAuditValid) throw new Error('Mixed race audit ordering was contradictory');

    const rollbackMachine = await makeMachine('rollback', departmentA.id);
    const rollbackBooking = await service.create(
      requester,
      requestFor(rollbackMachine.id, 2_000),
      randomUUID(),
    );
    const rollbackService = new BookingService(apiPrisma, new BookingPolicyService(apiPrisma), {
      record: async () => Promise.reject(new Error('forced audit failure')),
    } as AuditService);
    try {
      await rollbackService.cancel(
        requester,
        rollbackBooking.booking.id,
        { reason: 'Rollback proof' },
        randomUUID(),
      );
    } catch {
      // Expected: transaction rollback is checked below.
    }
    if (
      (await prisma.booking.findUniqueOrThrow({ where: { id: rollbackBooking.booking.id } }))
        .status !== 'CONFIRMED'
    )
      throw new Error('Audit rollback proof failed safely');

    const fixtureRows = Array.from({ length: 1_000 }, (_, index) => {
      const fixtureStart = new Date(asOf.getTime() - (index + 2_000) * 60_000);
      const fixtureEnd = new Date(fixtureStart.getTime() + 30 * 60_000);
      return {
        blockedUntil: fixtureEnd,
        cancelledReason: 'Historical fixture',
        endsAt: fixtureEnd,
        machineId: directMachine.id,
        purpose: 'Task54 proof historical fixture',
        requestedByUserId: requester.id,
        startsAt: fixtureStart,
        status: 'CANCELLED' as const,
      };
    });
    await prisma.booking.createMany({ data: fixtureRows });

    let queryCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instrument = (target: any): any =>
      new Proxy(target, {
        get(value, property) {
          const member = Reflect.get(value, property);
          if (property === '$transaction') {
            return async (callback: (transaction: unknown) => unknown, options: unknown) =>
              member.call(
                value,
                (transaction: unknown) => callback(instrument(transaction)),
                options,
              );
          }
          if (typeof member === 'function') {
            return (...args: unknown[]) => {
              queryCount += 1;
              return member.apply(value, args);
            };
          }
          return typeof member === 'object' && member !== null ? instrument(member) : member;
        },
      });
    const measuredPrisma = instrument(prisma) as PrismaService;
    const measured = new BookingService(
      measuredPrisma,
      new BookingPolicyService(measuredPrisma),
      new AuditService(),
    );
    queryCount = 0;
    const listStarted = performance.now();
    await measured.list(requester, {
      order: 'desc',
      page: 1,
      page_size: 25,
      sort: 'created_at',
      view: 'mine',
      when: 'all',
    });
    const listServerMs = Number((performance.now() - listStarted).toFixed(2));
    const listQueries = queryCount;
    queryCount = 0;
    const detailStarted = performance.now();
    await measured.get(requester, directCreated.booking.id);
    const detailServerMs = Number((performance.now() - detailStarted).toFixed(2));
    const detailQueries = queryCount;

    const explain = async (sql: string, ...parameters: unknown[]): Promise<ExplainDocument> => {
      const rows = await prisma!.$queryRawUnsafe<Array<{ 'QUERY PLAN': ExplainDocument[] }>>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ...parameters,
      );
      const plan = rows[0]?.['QUERY PLAN'][0];
      if (!plan) throw new Error('EXPLAIN returned no plan safely');
      return plan;
    };
    const requesterPlan = await explain(
      'SELECT id FROM bookings WHERE requested_by_user_id = $1::uuid ORDER BY starts_at DESC, id DESC LIMIT 25',
      requester.id,
    );
    const departmentPlan = await explain(
      "SELECT booking.id FROM bookings booking JOIN machines machine ON machine.id = booking.machine_id WHERE machine.department_id = $1::uuid AND booking.status = 'PENDING' ORDER BY booking.starts_at, booking.id LIMIT 25",
      departmentA.id,
    );
    const globalPlan = await explain(
      'SELECT id FROM bookings ORDER BY created_at DESC, id DESC LIMIT 25',
    );
    const auditPlan = await explain(
      "SELECT audit.actor_user_id, audit.created_at, (audit.after #>> '{context,lateCancelled}')::boolean FROM audit_logs audit WHERE audit.entity_type = 'booking' AND audit.entity_id = $1 AND audit.action IN ('booking.cancelled','booking.approved','booking.rejected') ORDER BY audit.created_at, audit.id",
      viewerRow.id,
    );

    runQuietly(
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
      environment,
    );
    console.log(
      JSON.stringify(
        {
          audit_rollback: true,
          concurrency: {
            approval_losers: raceCodes,
            approval_successes: raceSuccesses,
            mixed_final: finalMixed.status,
          },
          lifecycle: {
            adjacency: true,
            fallback_approval: true,
            manager_scope: true,
            past_rejection: true,
            requester_reads: true,
            self_decision_denied: true,
            viewer_cancel: true,
          },
          performance: {
            detail: { query_count: detailQueries, server_ms: detailServerMs },
            list: { query_count: listQueries, server_ms: listServerMs },
            plans: {
              audit_actor: {
                database_ms: auditPlan['Execution Time'],
                indexes: [...indexesFrom(auditPlan.Plan)].sort(),
              },
              department_pending: {
                database_ms: departmentPlan['Execution Time'],
                indexes: [...indexesFrom(departmentPlan.Plan)].sort(),
              },
              global: {
                database_ms: globalPlan['Execution Time'],
                indexes: [...indexesFrom(globalPlan.Plan)].sort(),
              },
              requester: {
                database_ms: requesterPlan['Execution Time'],
                indexes: [...indexesFrom(requesterPlan.Plan)].sort(),
              },
            },
          },
          response_minimization: true,
          schema_drift: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma?.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
  }

  const protectedCounts: Record<string, number> = {};
  for (const protectedBranch of ['main', 'staging', 'dev']) {
    const connection = getNeonConnectionStringCaptured(projectId, protectedBranch, true);
    const protectedClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connection, max: 1 }),
    });
    try {
      try {
        const rows = await protectedClient.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM bookings WHERE purpose LIKE 'Task54 proof%'
        `;
        protectedCounts[protectedBranch] = rows[0]?.count ?? -1;
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
        protectedCounts[protectedBranch] = 0;
      }
    } finally {
      await protectedClient.$disconnect();
    }
  }
  if (Object.values(protectedCounts).some((count) => count !== 0))
    throw new Error('Protected branch proof-row check failed safely');
  console.log(JSON.stringify({ protected_branch_proof_rows: protectedCounts }, null, 2));
};

void main();
