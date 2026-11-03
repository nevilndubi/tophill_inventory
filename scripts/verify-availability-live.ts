import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { BookingPolicyService } from '../apps/api/src/booking/booking-policy.service';
import { AvailabilityService } from '../apps/api/src/booking/availability.service';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
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

type CapturedQuery = { parameters: unknown[]; sql: string };
type ExplainNode = { 'Index Name'?: string; Plans?: ExplainNode[] };
type ExplainDocument = { 'Execution Time': number; Plan: ExplainNode; 'Planning Time': number };

const indexesFrom = (node: ExplainNode, values = new Set<string>()): Set<string> => {
  if (node['Index Name']) values.add(node['Index Name']);
  for (const child of node.Plans ?? []) indexesFrom(child, values);
  return values;
};

const roundedFuture = (now: Date, minutes: number): Date => {
  const value = new Date(now.getTime() + minutes * 60_000);
  value.setUTCSeconds(0, 0);
  if (value <= now) value.setUTCMinutes(value.getUTCMinutes() + 1);
  return value;
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
      `ephemeral/task-5.2-availability-${suffix}`,
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable empty-parent Neon branch ready (${branch.id}); credentials captured.`);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const protectedHosts = [
      hostname(getNeonConnectionStringCaptured(projectId, 'main', true)),
      hostname(getNeonConnectionStringCaptured(projectId, 'staging', true)),
    ].join(',');
    const environment = {
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
    runQuietly(['prisma:migrate:deploy'], environment);
    const integrationPlaceholder = 'postgresql://test:test@127.0.0.1:5432/test';
    runQuietly(['test:integration'], {
      ...environment,
      DATABASE_URL: integrationPlaceholder,
      DIRECT_URL: integrationPlaceholder,
    });
    console.log('Guarded database integration suite passed on the disposable branch.');
    runQuietly(['db:seed'], environment);
    console.log('Complete migration chain and guarded seed applied.');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pooled, max: 12 }) });
    const user = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'STAFF' },
    });
    const actor: AuthenticatedUser = {
      department: user.department,
      email: 'redacted',
      fullName: user.fullName,
      id: user.id,
      isActive: true,
      role: user.role,
    };
    const reference = await prisma.machine.findFirstOrThrow({
      select: { categoryId: true, departmentId: true, locationId: true },
      where: { deletedAt: null },
    });
    const clock = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) throw new Error('Database clock proof failed safely');

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO machines (
        id, asset_tag, name, category_id, manufacturer, model, serial_number,
        department_id, location_id, condition, retired_on, is_bookable,
        allow_booking_when_needs_service, requires_approval, buffer_minutes
      )
      SELECT gen_random_uuid(), 'HM-7' || lpad(series::text, 5, '0'),
        'Task52 fixture ' || lpad(series::text, 4, '0'), $1::uuid,
        'Task52 manufacturer', 'Availability fixture', 'TASK52-' || lpad(series::text, 5, '0'),
        $2::uuid, $3::uuid,
        CASE
          WHEN series <= 2400 THEN 'OPERATIONAL'::machine_condition
          WHEN series <= 2700 THEN 'NEEDS_SERVICE'::machine_condition
          WHEN series <= 2850 THEN 'UNDER_MAINTENANCE'::machine_condition
          WHEN series <= 2940 THEN 'OUT_OF_SERVICE'::machine_condition
          ELSE 'RETIRED'::machine_condition
        END,
        CASE WHEN series > 2940 THEN CURRENT_DATE ELSE NULL END,
        true, CASE WHEN series BETWEEN 2401 AND 2700 THEN true ELSE false END,
        (series % 3 = 0), CASE WHEN series % 4 = 0 THEN 15 ELSE 0 END
      FROM generate_series(1, 3000) series
      `,
      reference.categoryId,
      reference.departmentId,
      reference.locationId,
    );
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO usage_sessions (id, machine_id, user_id, started_at, expected_end_at, purpose)
      SELECT gen_random_uuid(), m.id, $1::uuid, $2::timestamptz - interval '30 minutes',
        CASE WHEN row_number() OVER (ORDER BY m.asset_tag) % 3 = 0
          THEN $2::timestamptz - interval '5 minutes'
          ELSE $2::timestamptz + interval '3 hours' END,
        'Availability performance proof'
      FROM machines m
      WHERE m.name LIKE 'Task52 fixture %'
      ORDER BY m.asset_tag LIMIT 450
      `,
      actor.id,
      now,
    );
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO bookings (
        id, machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose
      )
      SELECT gen_random_uuid(), m.id, $1::uuid,
        $2::timestamptz + interval '2 hours', $2::timestamptz + interval '3 hours',
        $2::timestamptz + interval '3 hours 15 minutes',
        CASE WHEN row_number() OVER (ORDER BY m.asset_tag) % 3 = 0
          THEN 'PENDING'::booking_status ELSE 'CONFIRMED'::booking_status END,
        'Availability performance proof'
      FROM machines m
      WHERE m.name LIKE 'Task52 fixture %'
      ORDER BY m.asset_tag OFFSET 450 LIMIT 600
      `,
      actor.id,
      now,
    );
    console.log(
      'Realistic fixture loaded (machines=3000, open_sessions=450, active_bookings=600).',
    );

    const captured: CapturedQuery[] = [];
    const countedPrisma = {
      $transaction: async (callback: (transaction: unknown) => unknown, options: unknown) =>
        prisma!.$transaction(
          async (transaction) =>
            callback({
              appSetting: transaction.appSetting,
              $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => {
                captured.push({ parameters, sql });
                return transaction.$queryRawUnsafe(sql, ...parameters);
              },
            }),
          options as never,
        ),
    } as unknown as PrismaService;
    const policy = new BookingPolicyService(countedPrisma);
    const service = new AvailabilityService(countedPrisma, policy);

    const start = roundedFuture(now, 120);
    const end = new Date(start.getTime() + 60 * 60_000);
    const machine = await prisma.machine.findFirstOrThrow({
      select: { id: true },
      where: { assetTag: 'HM-702000' },
    });

    const timings: Record<string, number> = {};
    const timed = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      captured.length = 0;
      const began = performance.now();
      const result = await operation();
      timings[label] = Number((performance.now() - began).toFixed(2));
      if (captured.length !== 1) throw new Error(`${label} query-count proof failed safely`);
      return result;
    };

    const detail7 = await timed('detail_7d', () =>
      service.detail(actor, machine.id, {
        from: start.toISOString(),
        to: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
      }),
    );
    const detailQuery = captured[0];
    if (!detailQuery) throw new Error('Detail query capture failed safely');
    await timed('detail_62d', () =>
      service.detail(actor, machine.id, {
        from: start.toISOString(),
        to: new Date(start.getTime() + 62 * 86_400_000).toISOString(),
      }),
    );
    const search = async (filters: { category_id?: string; department_id?: string } = {}) =>
      service.search(actor, {
        ...filters,
        end: end.toISOString(),
        page: 1,
        page_size: 100,
        start: start.toISOString(),
      });
    const unfiltered = await timed('search_unfiltered', () => search());
    const searchQuery = captured[0];
    if (!searchQuery) throw new Error('Search query capture failed safely');
    await timed('search_department', () => search({ department_id: reference.departmentId }));
    await timed('search_category', () => search({ category_id: reference.categoryId }));

    const consistencyCandidates = unfiltered.items.slice(0, 30);
    if (consistencyCandidates.length !== 30) {
      throw new Error('Thirty-machine consistency fixture was not available');
    }
    for (const candidate of consistencyCandidates) {
      const detail = await service.detail(actor, candidate.id, {
        from: start.toISOString(),
        to: end.toISOString(),
      });
      if (!detail.available_for_entire_range) {
        throw new Error('Detail/search consistency proof failed safely');
      }
    }

    const explain = async (query: CapturedQuery): Promise<ExplainDocument> => {
      const rows = await prisma!.$queryRawUnsafe<Array<{ 'QUERY PLAN': ExplainDocument[] }>>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        ...query.parameters,
      );
      const plan = rows[0]?.['QUERY PLAN'][0];
      if (!plan) throw new Error('EXPLAIN proof returned no plan');
      return plan;
    };
    const detailPlan = await explain(detailQuery);
    const searchPlan = await explain(searchQuery);

    const boundaryMachine = await prisma.machine.findFirstOrThrow({
      where: { assetTag: 'HM-702000' },
    });
    await prisma.booking.deleteMany({ where: { machineId: boundaryMachine.id } });
    const blockStart = roundedFuture(now, 240);
    const blockEnd = new Date(blockStart.getTime() + 30 * 60_000);
    const blockedUntil = new Date(blockEnd.getTime() + 15 * 60_000);
    await prisma.booking.create({
      data: {
        blockedUntil,
        endsAt: blockEnd,
        machineId: boundaryMachine.id,
        purpose: 'Boundary proof',
        requestedByUserId: actor.id,
        startsAt: blockStart,
        status: 'CONFIRMED',
      },
    });
    for (const status of ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] as const) {
      await prisma.booking.updateMany({
        data: { status },
        where: { machineId: boundaryMachine.id },
      });
      const activeDetail = await service.detail(actor, boundaryMachine.id, {
        from: blockStart.toISOString(),
        to: blockEnd.toISOString(),
      });
      if (
        !activeDetail.blocks.some((block) => block.type === 'BOOKING' && block.status === status)
      ) {
        throw new Error(`Active booking status proof failed safely (${status})`);
      }
    }
    await prisma.booking.updateMany({
      data: { status: 'CONFIRMED' },
      where: { machineId: boundaryMachine.id },
    });
    const exactBoundary = await service.detail(actor, boundaryMachine.id, {
      from: blockedUntil.toISOString(),
      to: new Date(blockedUntil.getTime() + 15 * 60_000).toISOString(),
    });
    if (!exactBoundary.available_for_entire_range) {
      throw new Error('Exact blocked-until adjacency proof failed safely');
    }
    const detailBoundary = await service.detail(actor, boundaryMachine.id, {
      from: new Date(blockedUntil.getTime() - 1).toISOString(),
      to: new Date(blockedUntil.getTime() + 60_000).toISOString(),
    });
    if (!detailBoundary.blocks.some((block) => block.type === 'BOOKING')) {
      throw new Error('One-millisecond overlap proof failed safely');
    }

    for (const status of ['CANCELLED', 'REJECTED', 'COMPLETED', 'NO_SHOW'] as const) {
      await prisma.booking.create({
        data: {
          blockedUntil: new Date(blockEnd.getTime() + 60_000),
          endsAt: blockEnd,
          machineId: boundaryMachine.id,
          purpose: 'Inactive status proof',
          requestedByUserId: actor.id,
          startsAt: blockStart,
          status,
        },
      });
    }
    const inactiveStatusDetail = await service.detail(actor, boundaryMachine.id, {
      from: blockStart.toISOString(),
      to: blockEnd.toISOString(),
    });
    if (inactiveStatusDetail.blocks.filter((block) => block.type === 'BOOKING').length !== 1) {
      throw new Error('Inactive booking status proof failed safely');
    }

    const missingEndMachine = await prisma.machine.findFirstOrThrow({
      where: { assetTag: 'HM-700003' },
    });
    await prisma.usageSession.updateMany({
      data: { expectedEndAt: null },
      where: { machineId: missingEndMachine.id, endedAt: null },
    });
    const near = await service.detail(actor, missingEndMachine.id, {
      from: start.toISOString(),
      to: end.toISOString(),
    });
    const week = await service.detail(actor, missingEndMachine.id, {
      from: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
      to: new Date(end.getTime() + 7 * 86_400_000).toISOString(),
    });
    const overdueMachine = await prisma.machine.findFirstOrThrow({
      where: { assetTag: 'HM-700006' },
    });
    const overdue = await service.detail(actor, overdueMachine.id, {
      from: start.toISOString(),
      to: end.toISOString(),
    });
    if (
      !near.blocks.some((block) => block.type === 'USAGE' && block.estimated) ||
      !overdue.blocks.some((block) => block.type === 'USAGE' && block.estimated) ||
      week.available_for_entire_range !== true
    ) {
      throw new Error('Estimated overdue-session horizon proof failed safely');
    }

    const conditionTags = ['HM-702701', 'HM-702851', 'HM-702941'] as const;
    for (const assetTag of conditionTags) {
      const conditioned = await prisma.machine.findFirstOrThrow({ where: { assetTag } });
      const detail = await service.detail(actor, conditioned.id, {
        from: start.toISOString(),
        to: end.toISOString(),
      });
      if (detail.available_for_entire_range || !detail.reasons.includes('CONDITION_NOT_BOOKABLE')) {
        throw new Error('Condition blocking proof failed safely');
      }
    }

    console.log(
      JSON.stringify(
        {
          boundaries: {
            active_statuses_block: true,
            adjacent_at_blocked_until_free: true,
            inactive_statuses_ignored: true,
            one_millisecond_inside_busy: true,
            open_session_missing_end_estimated: true,
            overdue_session_estimated_horizon: true,
            pending_confirmed_in_progress_block: true,
          },
          consistency: {
            candidates_checked: consistencyCandidates.length,
            long_detail_available: detail7.available_for_entire_range,
            search_total: unfiltered.meta.total,
          },
          detail_plan: {
            database_ms: detailPlan['Execution Time'],
            indexes: [...indexesFrom(detailPlan.Plan)].sort(),
          },
          fixture: { active_bookings: 600, machines: 3000, open_sessions: 450 },
          query_count_per_endpoint: 2,
          search_plan: {
            database_ms: searchPlan['Execution Time'],
            indexes: [...indexesFrom(searchPlan.Plan)].sort(),
          },
          server_ms: timings,
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
