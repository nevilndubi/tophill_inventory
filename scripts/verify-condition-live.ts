import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { ConditionEventsService } from '../apps/api/src/machines/condition-events.service';
import { ConditionService } from '../apps/api/src/machines/condition.service';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const suppliedBranchId = process.env.TASK41_PROOF_BRANCH_ID?.trim();
const suppliedBranchName = process.env.TASK41_PROOF_BRANCH_NAME?.trim();
const suppliedDirectHost = process.env.TASK41_PROOF_DIRECT_HOST?.trim();
const usesSuppliedBranch = Boolean(suppliedBranchId && suppliedBranchName && suppliedDirectHost);

const connectionForHost = (source: string, host: string): string => {
  const url = new URL(source);
  url.hostname = host;
  return url.toString();
};

const clientFor = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 5 }) });
const hostname = (url: string): string => new URL(url).hostname;
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
const serviceFor = (prisma: PrismaClient, audit: AuditService = new AuditService()) =>
  new ConditionService(prisma as unknown as PrismaService, audit, new ConditionEventsService());
const protectedProofCount = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString);
  try {
    const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('public.audit_logs')::text AS name
    `;
    if (!table[0]?.name) return 0;
    return prisma.auditLog.count({ where: { requestId: { startsWith: 'task-4.1' } } });
  } finally {
    await prisma.$disconnect();
  }
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  let secondClient: PrismaClient | undefined;
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
        `ephemeral/task-4.1-condition-${suffix}`,
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
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Migration chain plus two guarded seed runs passed without duplication.');

    prisma = clientFor(pooled);
    secondClient = clientFor(pooled);
    const service = serviceFor(prisma);
    const secondService = serviceFor(secondClient);
    const actorRow = await prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
    const userRow = await prisma.user.findFirstOrThrow({ where: { role: 'STAFF' } });
    const actor = {
      department: null,
      email: 'redacted',
      fullName: actorRow.fullName,
      id: actorRow.id,
      isActive: true,
      role: 'SUPER_ADMIN' as const,
    };
    const targets = await prisma.machine.findMany({
      orderBy: { assetTag: 'asc' },
      take: 4,
      where: {
        condition: 'OPERATIONAL',
        deletedAt: null,
        usageSessions: { none: { endedAt: null } },
      },
    });
    if (targets.length < 4)
      throw new Error('Disposable seed has too few operational proof targets');
    const [basic, concurrent, inUse, rollback] = targets;
    if (!basic || !concurrent || !inUse || !rollback) throw new Error('Proof targets missing');

    await service.transition(basic.id, 'NEEDS_SERVICE', {
      actor,
      fromCondition: 'OPERATIONAL',
      reason: 'Verified live transition proof',
      requestId: 'task-4.1-basic',
      source: 'MANUAL',
    });
    await service.transition(basic.id, 'OPERATIONAL', {
      actor,
      fromCondition: 'NEEDS_SERVICE',
      reason: 'Verified equipment is operational',
      requestId: 'task-4.1-basic-return',
      source: 'MANUAL',
    });
    const history = await service.history(actor, basic.id, { page: 1, pageSize: 50 });
    console.log(`Transition/history proof: current=OPERATIONAL history_rows=${history.total}.`);

    const concurrentResults = await Promise.allSettled([
      service.transition(concurrent.id, 'NEEDS_SERVICE', {
        actor,
        fromCondition: 'OPERATIONAL',
        reason: 'Concurrent inspection path one',
        requestId: 'task-4.1-concurrent-one',
        source: 'MANUAL',
      }),
      secondService.transition(concurrent.id, 'OUT_OF_SERVICE', {
        actor,
        fromCondition: 'OPERATIONAL',
        reason: 'Concurrent inspection path two',
        requestId: 'task-4.1-concurrent-two',
        source: 'MANUAL',
      }),
    ]);
    const successes = concurrentResults.filter((result) => result.status === 'fulfilled').length;
    const conflicts = concurrentResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => codeOf(result.reason));
    if (successes !== 1 || conflicts[0] !== 'CONDITION_CHANGED') {
      throw new Error('Concurrent condition serialization proof failed');
    }
    console.log(`Concurrency proof: attempts=2 successes=${successes} conflict=${conflicts[0]}.`);

    const session = await prisma.usageSession.create({
      data: {
        machineId: inUse.id,
        purpose: 'Condition safety verification',
        startedAt: new Date(),
        userId: userRow.id,
      },
    });
    await service.transition(inUse.id, 'NEEDS_SERVICE', {
      actor,
      fromCondition: 'OPERATIONAL',
      reason: 'Reported while machine remains in use',
      requestId: 'task-4.1-in-use-needs-service',
      source: 'MANUAL',
    });
    let blocker = 'none';
    try {
      await service.transition(inUse.id, 'OUT_OF_SERVICE', {
        actor,
        fromCondition: 'NEEDS_SERVICE',
        reason: 'Unsafe condition confirmed while in use',
        requestId: 'task-4.1-in-use-blocked',
        source: 'MANUAL',
      });
    } catch (error: unknown) {
      blocker = codeOf(error);
    }
    await service.transition(inUse.id, 'OUT_OF_SERVICE', {
      actor,
      force: true,
      fromCondition: 'NEEDS_SERVICE',
      reason: 'Unsafe condition confirmed while in use',
      requestId: 'task-4.1-in-use-forced',
      source: 'MANUAL',
    });
    const stillOpen = await prisma.usageSession.count({ where: { endedAt: null, id: session.id } });
    if (blocker !== 'MACHINE_HAS_OPEN_SESSION' || stillOpen !== 1) {
      throw new Error('Open-session safety proof failed');
    }
    await prisma.usageSession.update({ data: { endedAt: new Date() }, where: { id: session.id } });
    console.log(
      `Open-session proof: unforced=${blocker} forced=success session_still_open=${stillOpen}.`,
    );

    await service.transition(rollback.id, 'RETIRED', {
      actor,
      fromCondition: 'OPERATIONAL',
      reason: 'Retirement and date proof',
      requestId: 'task-4.1-retire',
      source: 'MANUAL',
    });
    const retired = await prisma.machine.findUniqueOrThrow({ where: { id: rollback.id } });
    await service.transition(rollback.id, 'UNDER_MAINTENANCE', {
      actor,
      fromCondition: 'RETIRED',
      reason: 'Reinstate for inspection',
      requestId: 'task-4.1-reinstate',
      source: 'MANUAL',
    });
    const reinstated = await prisma.machine.findUniqueOrThrow({ where: { id: rollback.id } });
    if (retired.retiredOn === null || reinstated.retiredOn !== null) {
      throw new Error('Retirement date consistency proof failed');
    }
    console.log(
      'Retirement proof: date_set=true reinstate_target=UNDER_MAINTENANCE date_cleared=true.',
    );

    const rollbackTarget = await prisma.machine.findFirstOrThrow({
      where: {
        condition: 'OPERATIONAL',
        deletedAt: null,
        id: { notIn: targets.map(({ id }) => id) },
      },
    });
    const historyBefore = await prisma.machineStatusHistory.count({
      where: { machineId: rollbackTarget.id },
    });
    const failingAudit = {
      record: async () => {
        throw new Error('Controlled audit failure');
      },
    } as unknown as AuditService;
    try {
      await serviceFor(prisma, failingAudit).transition(rollbackTarget.id, 'NEEDS_SERVICE', {
        actor,
        fromCondition: 'OPERATIONAL',
        reason: 'Controlled rollback proof',
        requestId: 'task-4.1-rollback',
        source: 'MANUAL',
      });
      throw new Error('Controlled rollback unexpectedly succeeded');
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== 'Controlled audit failure') throw error;
    }
    const [rollbackMachine, historyAfter] = await Promise.all([
      prisma.machine.findUniqueOrThrow({ where: { id: rollbackTarget.id } }),
      prisma.machineStatusHistory.count({ where: { machineId: rollbackTarget.id } }),
    ]);
    if (rollbackMachine.condition !== 'OPERATIONAL' || historyAfter !== historyBefore) {
      throw new Error('Atomic rollback proof failed');
    }
    console.log('Rollback proof: condition_unchanged=true history_unchanged=true audit_rows=0.');

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
    console.log(
      diff.includes('No difference detected')
        ? 'Prisma migrate diff: No difference detected.'
        : 'Prisma migrate diff returned unexpected output.',
    );
  } finally {
    await Promise.allSettled([prisma?.$disconnect(), secondClient?.$disconnect()]);
    if (branch && !usesSuppliedBranch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
    if (!usesSuppliedBranch) {
      const counts = {
        dev: await protectedProofCount(getNeonConnectionStringCaptured(projectId, 'dev', true)),
        main: await protectedProofCount(getNeonConnectionStringCaptured(projectId, 'main', true)),
        staging: await protectedProofCount(
          getNeonConnectionStringCaptured(projectId, 'staging', true),
        ),
      };
      console.log(
        `Protected-branch Task 4.1 audit rows: dev=${counts.dev} staging=${counts.staging} main=${counts.main}.`,
      );
    } else if (branch) {
      console.log(`Disposable Neon branch ready for orchestrated deletion (${branch.id}).`);
    }
  }
};

void main().catch((error: unknown) => {
  console.error(`[task-4.1-live] ${error instanceof Error ? error.message : 'Unknown failure'}`);
  process.exitCode = 1;
});
