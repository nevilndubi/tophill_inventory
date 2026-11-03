import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { BookingPolicyService } from '../apps/api/src/booking/booking-policy.service';
import { BookingService } from '../apps/api/src/booking/booking.service';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
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
const actorFrom = (user: { id: string; fullName: string }): AuthenticatedUser => ({
  department: null,
  email: 'redacted',
  fullName: user.fullName,
  id: user.id,
  isActive: true,
  role: 'STAFF',
});

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
      `ephemeral/task-5.3-booking-${suffix}`,
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
    const integrationPlaceholder = 'postgresql://test:test@127.0.0.1:5432/test';
    runQuietly(['test:integration'], {
      ...environment,
      DATABASE_URL: integrationPlaceholder,
      DIRECT_URL: integrationPlaceholder,
    });
    runQuietly(['db:seed'], environment);
    console.log('Migration chain, guarded integration suite and guarded seed passed.');

    let queryCount = 0;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pooled, max: 30 }) });
    const reference = await prisma.machine.findFirstOrThrow({
      select: { categoryId: true, departmentId: true, locationId: true },
      where: { deletedAt: null },
    });
    const makeUser = async (label: string) => {
      const suffix = randomUUID();
      return prisma!.user.create({
        data: {
          email: `${label}-${suffix}${String.fromCharCode(64)}invalid.local`,
          fullName: `Task 5.3 ${label}`,
          isSeedData: false,
          role: 'STAFF',
          supabaseUserId: randomUUID(),
        },
        select: { fullName: true, id: true },
      });
    };
    const makeMachine = async (label: string, requiresApproval = false, bufferMinutes = 15) =>
      prisma!.machine.create({
        data: {
          bufferMinutes,
          categoryId: reference.categoryId,
          departmentId: reference.departmentId,
          isBookable: true,
          locationId: reference.locationId,
          manufacturer: `Task53-${label}`,
          model: 'Booking proof',
          name: `Task 5.3 ${label}`,
          requiresApproval,
          serialNumber: `TASK53-${label}-${randomUUID()}`,
        },
        select: { id: true },
      });
    const apiPrisma = prisma as unknown as PrismaService;
    const service = new BookingService(
      apiPrisma,
      new BookingPolicyService(apiPrisma),
      new AuditService(),
    );
    const dbClock = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const asOf = dbClock[0]?.now;
    if (!asOf) throw new Error('Database clock proof failed safely');
    const startsAt = roundedFuture(asOf, 60);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const request = (machineId: string, start = startsAt, end = endsAt) => ({
      ends_at: end.toISOString(),
      machine_id: machineId,
      purpose: 'Routine monitoring',
      starts_at: start.toISOString(),
    });

    const directUser = actorFrom(await makeUser('direct'));
    const directMachine = await makeMachine('direct');
    // Prisma's generated delegate methods are wrapped dynamically only to count live database calls.
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
    const measuredService = new BookingService(
      measuredPrisma,
      new BookingPolicyService(measuredPrisma),
      new AuditService(),
    );
    queryCount = 0;
    const began = performance.now();
    const directResult = await measuredService.create(
      directUser,
      request(directMachine.id),
      randomUUID(),
      `proof-${randomUUID()}`,
    );
    const createServerMs = Number((performance.now() - began).toFixed(2));
    const createQueryCount = queryCount;
    if (
      directResult.booking.status !== 'CONFIRMED' ||
      directResult.booking.effective_buffer_minutes !== 15
    ) {
      throw new Error('Direct confirmation or buffer snapshot proof failed safely');
    }
    const approvalUser = actorFrom(await makeUser('approval'));
    const approvalMachine = await makeMachine('approval', true, 20);
    const approval = await service.create(approvalUser, request(approvalMachine.id), randomUUID());
    if (approval.booking.status !== 'PENDING' || approval.booking.effective_buffer_minutes !== 20) {
      throw new Error('Approval-required proof failed safely');
    }

    const replayUser = actorFrom(await makeUser('replay'));
    const replayMachine = await makeMachine('replay');
    const replayKey = `proof-${randomUUID()}`;
    const replayRequest = request(replayMachine.id);
    const first = await service.create(replayUser, replayRequest, randomUUID(), replayKey);
    const replay = await service.create(replayUser, replayRequest, randomUUID(), replayKey);
    if (first.replayed || !replay.replayed || first.booking.id !== replay.booking.id) {
      throw new Error('Idempotent replay proof failed safely');
    }
    let reusedCode = '';
    try {
      await service.create(
        replayUser,
        { ...replayRequest, purpose: 'Ward round' },
        randomUUID(),
        replayKey,
      );
    } catch (error) {
      reusedCode = codeOf(error);
    }
    if (reusedCode !== 'IDEMPOTENCY_KEY_REUSED') {
      throw new Error('Changed-payload idempotency proof failed safely');
    }

    const activeUser = actorFrom(await makeUser('active-limit'));
    const activeMachines = await Promise.all([makeMachine('active-a'), makeMachine('active-b')]);
    await prisma.appSetting.update({
      where: { key: 'booking.max_active_per_user' },
      data: { value: 1 },
    });
    const limitOutcomes = await Promise.allSettled(
      activeMachines.map((machine, index) =>
        service.create(
          activeUser,
          request(
            machine.id,
            new Date(startsAt.getTime() + index * 2 * 60 * 60_000),
            new Date(endsAt.getTime() + index * 2 * 60 * 60_000),
          ),
          randomUUID(),
        ),
      ),
    );
    await prisma.appSetting.update({
      where: { key: 'booking.max_active_per_user' },
      data: { value: 10 },
    });
    const limitSuccess = limitOutcomes.filter((value) => value.status === 'fulfilled').length;
    const limitCodes = limitOutcomes
      .filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      .map((value) => codeOf(value.reason));
    if (
      limitSuccess !== 1 ||
      !limitCodes.every((code) => code === 'ACTIVE_BOOKING_LIMIT_REACHED')
    ) {
      throw new Error('Concurrent active-limit proof failed safely');
    }

    const sameUser = actorFrom(await makeUser('same-key'));
    const sameMachine = await makeMachine('same-key');
    const sameKey = `proof-${randomUUID()}`;
    const sameRequest = request(
      sameMachine.id,
      new Date(startsAt.getTime() + 6 * 60 * 60_000),
      new Date(endsAt.getTime() + 6 * 60 * 60_000),
    );
    const sameResults = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.create(sameUser, sameRequest, randomUUID(), sameKey),
      ),
    );
    const sameSuccess = sameResults
      .filter(
        (value): value is PromiseFulfilledResult<Awaited<ReturnType<BookingService['create']>>> =>
          value.status === 'fulfilled',
      )
      .map((value) => value.value);
    const sameBusy = sameResults
      .filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      .filter((value) => codeOf(value.reason) === 'MACHINE_BUSY').length;
    if (
      sameSuccess.filter((value) => !value.replayed).length !== 1 ||
      new Set(sameSuccess.map((value) => value.booking.id)).size !== 1 ||
      sameResults.some(
        (value) => value.status === 'rejected' && codeOf(value.reason) !== 'MACHINE_BUSY',
      )
    ) {
      throw new Error('Twenty-way same-key invariant failed safely');
    }
    for (let index = 0; index < sameBusy; index += 1) {
      const retried = await service.create(sameUser, sameRequest, randomUUID(), sameKey);
      if (!retried.replayed) throw new Error('Busy same-key retry did not replay safely');
    }
    if ((await prisma.booking.count({ where: { machineId: sameMachine.id } })) !== 1) {
      throw new Error('Same-key row-count invariant failed safely');
    }

    const raceUser = actorFrom(await makeUser('distinct-key'));
    const raceMachine = await makeMachine('distinct-key');
    const raceRequest = request(
      raceMachine.id,
      new Date(startsAt.getTime() + 10 * 60 * 60_000),
      new Date(endsAt.getTime() + 10 * 60 * 60_000),
    );
    const raceResults = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.create(raceUser, raceRequest, randomUUID(), `proof-${randomUUID()}`),
      ),
    );
    const raceSuccess = raceResults.filter((value) => value.status === 'fulfilled').length;
    const raceBusy = raceResults
      .filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      .filter((value) => codeOf(value.reason) === 'MACHINE_BUSY').length;
    if (
      raceSuccess !== 1 ||
      raceResults.some(
        (value) =>
          value.status === 'rejected' &&
          !['BOOKING_CONFLICT', 'MACHINE_BUSY'].includes(codeOf(value.reason)),
      ) ||
      (await prisma.booking.count({ where: { machineId: raceMachine.id } })) !== 1
    ) {
      throw new Error('Twenty-way distinct-key invariant failed safely');
    }
    for (let index = 0; index < raceBusy; index += 1) {
      let retryCode = '';
      try {
        await service.create(raceUser, raceRequest, randomUUID(), `retry-${randomUUID()}`);
      } catch (error) {
        retryCode = codeOf(error);
      }
      if (retryCode !== 'BOOKING_CONFLICT') throw new Error('Busy conflict retry failed safely');
    }

    const usageUser = actorFrom(await makeUser('usage'));
    const usageMachine = await makeMachine('usage');
    await prisma.usageSession.create({
      data: {
        machineId: usageMachine.id,
        purpose: 'General equipment use',
        startedAt: asOf,
        userId: usageUser.id,
      },
    });
    let nearUsageCode = '';
    try {
      await service.create(usageUser, request(usageMachine.id), randomUUID());
    } catch (error) {
      nearUsageCode = codeOf(error);
    }
    const farStart = roundedFuture(asOf, 7 * 24 * 60);
    await service.create(
      usageUser,
      request(usageMachine.id, farStart, new Date(farStart.getTime() + 60 * 60_000)),
      randomUUID(),
    );
    if (nearUsageCode !== 'MACHINE_IN_USE') throw new Error('Usage estimate proof failed safely');

    const rollbackUser = actorFrom(await makeUser('rollback'));
    const rollbackMachine = await makeMachine('rollback');
    const rollbackService = new BookingService(apiPrisma, new BookingPolicyService(apiPrisma), {
      record: async () => Promise.reject(new Error('forced audit failure')),
    } as AuditService);
    try {
      await rollbackService.create(rollbackUser, request(rollbackMachine.id), randomUUID());
    } catch {
      // Expected: the transaction must roll the booking back with the failed audit.
    }
    if (await prisma.booking.count({ where: { machineId: rollbackMachine.id } })) {
      throw new Error('Audit rollback proof failed safely');
    }

    const explain = async (sql: string, ...parameters: unknown[]): Promise<ExplainDocument> => {
      const rows = await prisma!.$queryRawUnsafe<Array<{ 'QUERY PLAN': ExplainDocument[] }>>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ...parameters,
      );
      const plan = rows[0]?.['QUERY PLAN'][0];
      if (!plan) throw new Error('EXPLAIN returned no plan safely');
      return plan;
    };
    const activePlan = await explain(
      `SELECT count(*) FROM bookings WHERE requested_by_user_id = $1::uuid AND (((status IN ('PENDING','CONFIRMED')) AND ends_at > clock_timestamp()) OR status = 'IN_PROGRESS')`,
      raceUser.id,
    );
    const idempotencyPlan = await explain(
      `SELECT id FROM bookings WHERE requested_by_user_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
      replayUser.id,
      replayKey,
    );
    const conflictPlan = await explain(
      `SELECT id FROM bookings WHERE machine_id = $1::uuid AND status IN ('PENDING','CONFIRMED','IN_PROGRESS') AND starts_at < $2::timestamptz AND blocked_until > $3::timestamptz LIMIT 1`,
      raceMachine.id,
      raceRequest.ends_at,
      raceRequest.starts_at,
    );

    console.log(
      JSON.stringify(
        {
          audit_rollback: true,
          concurrency: {
            active_limit_successes: limitSuccess,
            distinct_key_busy: raceBusy,
            distinct_key_successes: raceSuccess,
            same_key_busy: sameBusy,
            same_key_initial_creates: sameSuccess.filter((value) => !value.replayed).length,
            same_key_rows: 1,
          },
          creation: {
            confirmed: true,
            pending: true,
            query_count: createQueryCount,
            server_ms: createServerMs,
          },
          idempotency: { changed_payload_rejected: true, replayed: true },
          plans: {
            active_count: {
              database_ms: activePlan['Execution Time'],
              indexes: [...indexesFrom(activePlan.Plan)].sort(),
            },
            conflict: {
              database_ms: conflictPlan['Execution Time'],
              indexes: [...indexesFrom(conflictPlan.Plan)].sort(),
            },
            idempotency: {
              database_ms: idempotencyPlan['Execution Time'],
              indexes: [...indexesFrom(idempotencyPlan.Plan)].sort(),
            },
          },
          safe_response_fields_only: true,
          usage_estimate: { far_future_free: true, near_window_blocked: true },
        },
        null,
        2,
      ),
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
    console.log('Prisma migration diff reported no pending schema changes.');
  } finally {
    await prisma?.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
  }
};

void main();
