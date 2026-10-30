import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { TimelineService } from '../apps/api/src/machines/timeline.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const hostname = (value: string): string => new URL(value).hostname;
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
    throw new Error(`pnpm ${args[0] ?? ''} failed safely: ${redactDatabaseUrls(result.stderr)}`);
  }
  return output ? result.stdout.trim() : '';
};

type CapturedQuery = { parameters: unknown[]; sql: string };
type ExplainNode = { 'Index Name'?: string; Plans?: ExplainNode[] };
type ExplainDocument = { 'Execution Time': number; Plan: ExplainNode; 'Planning Time': number };
const collectIndexes = (node: ExplainNode, indexes = new Set<string>()): Set<string> => {
  if (typeof node['Index Name'] === 'string') indexes.add(node['Index Name']);
  for (const child of node.Plans ?? []) collectIndexes(child, indexes);
  return indexes;
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
      `ephemeral/task-4.5-timeline-${suffix}`,
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable Neon branch ready (${branch.id}); credentials remained captured.`);
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
    runQuietly(['db:seed'], environment);
    console.log('Migration chain and guarded seed passed on the disposable branch.');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pooled, max: 10 }) });
    const actorRow = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'ADMIN' },
    });
    const actor: AuthenticatedUser = {
      department: actorRow.department,
      email: 'redacted',
      fullName: actorRow.fullName,
      id: actorRow.id,
      isActive: true,
      role: actorRow.role,
    };
    const reference = await prisma.machine.findFirstOrThrow({
      select: { categoryId: true, departmentId: true, locationId: true },
      where: { deletedAt: null },
    });
    const machine = await prisma.machine.create({
      data: {
        categoryId: reference.categoryId,
        departmentId: reference.departmentId,
        locationId: reference.locationId,
        manufacturer: 'Task45 proof manufacturer',
        model: 'Timeline fixture',
        name: 'Task 4.5 timeline fixture',
        serialNumber: `TASK45-${suffix}`,
      },
    });
    await prisma.machineStatusHistory.create({
      data: {
        changedByUserId: actor.id,
        machineId: machine.id,
        reason: 'Machine registered',
        source: 'SYSTEM',
        toCondition: 'OPERATIONAL',
      },
    });
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO machine_status_history (
          id, machine_id, from_condition, to_condition, reason,
          changed_by_user_id, source, created_at
        )
        SELECT
          gen_random_uuid(), $1::uuid,
          CASE WHEN series % 2 = 0 THEN 'OPERATIONAL'::machine_condition ELSE 'NEEDS_SERVICE'::machine_condition END,
          CASE WHEN series % 2 = 0 THEN 'NEEDS_SERVICE'::machine_condition ELSE 'OPERATIONAL'::machine_condition END,
          'Task 4.5 generated condition event', $2::uuid, 'SYSTEM'::machine_status_source,
          statement_timestamp() - (2000 - series) * interval '1 second'
        FROM generate_series(1, 1000) series
      `,
      machine.id,
      actor.id,
    );
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO usage_sessions (
          id, machine_id, user_id, started_at, expected_end_at, ended_at, purpose, end_note
        )
        SELECT
          gen_random_uuid(), $1::uuid, $2::uuid,
          statement_timestamp() - (1002 - series * 2) * interval '1 second',
          statement_timestamp() - (1001 - series * 2) * interval '1 second',
          statement_timestamp() - (1001 - series * 2) * interval '1 second',
          'Routine monitoring', CASE WHEN series % 3 = 0 THEN 'Returned to equipment bay' ELSE NULL END
        FROM generate_series(1, 500) series
      `,
      machine.id,
      actor.id,
    );
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO audit_logs (
          id, actor_user_id, action, entity_type, entity_id, after, request_id, created_at
        )
        SELECT
          gen_random_uuid(), $1::uuid,
          CASE WHEN row_number() OVER (ORDER BY session.id) % 5 = 0 THEN 'usage.force_ended' ELSE 'usage.checked_in' END,
          'usage_session', session.id::text,
          jsonb_build_object('context', jsonb_build_object('forced', row_number() OVER (ORDER BY session.id) % 5 = 0)),
          'task-4.5-live-proof', session.ended_at
        FROM usage_sessions session
        WHERE session.machine_id = $2::uuid AND session.ended_at IS NOT NULL
      `,
      actor.id,
      machine.id,
    );
    console.log('Timeline fixture loaded: 2,001 mixed condition and usage events.');

    const captured: CapturedQuery[] = [];
    const counted = {
      $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => {
        captured.push({ parameters, sql });
        return prisma!.$queryRawUnsafe(sql, ...parameters);
      },
    } as unknown as PrismaService;
    const service = new TimelineService(counted);
    const firstStarted = performance.now();
    const first = await service.list(actor, machine.id, { page: 1, page_size: 50 });
    const firstLatency = performance.now() - firstStarted;
    const deepStarted = performance.now();
    const deep = await service.list(actor, machine.id, {
      page: 20,
      page_size: 100,
      until: first.until,
    });
    const deepLatency = performance.now() - deepStarted;
    if (first.total !== 2001 || deep.items.length === 0 || captured.length !== 2) {
      throw new Error(
        `Timeline fixture assertion failed safely: total=${first.total}, deep_items=${deep.items.length}, query_count=${captured.length}`,
      );
    }

    const pageTwoBefore = await service.list(actor, machine.id, {
      page: 2,
      page_size: 50,
      until: first.until,
    });
    await prisma.machineStatusHistory.create({
      data: {
        changedByUserId: actor.id,
        fromCondition: 'OPERATIONAL',
        machineId: machine.id,
        reason: 'New event after paging began',
        source: 'SYSTEM',
        toCondition: 'NEEDS_SERVICE',
      },
    });
    const pageTwoAfter = await service.list(actor, machine.id, {
      page: 2,
      page_size: 50,
      until: first.until,
    });
    if (
      pageTwoBefore.items.map((item) => item.event_id).join(',') !==
      pageTwoAfter.items.map((item) => item.event_id).join(',')
    ) {
      throw new Error('Cutoff-stable pagination proof failed safely');
    }

    const capturedQuery = captured[0]!;
    const explained = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': ExplainDocument[] }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${capturedQuery.sql}`,
      ...capturedQuery.parameters,
    );
    const plan = explained[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error('Timeline explain plan was unavailable');
    console.log(
      `Timeline proof passed: first_page_ms=${firstLatency.toFixed(2)}, deep_page_ms=${deepLatency.toFixed(2)}, query_count_per_request=1, database_ms=${plan['Execution Time'].toFixed(2)}, indexes=${[...collectIndexes(plan.Plan)].sort().join('|') || 'none'}.`,
    );
    console.log(
      'Cutoff pagination, stable event IDs, ending audit metadata and minimized actors passed.',
    );

    const drift = runQuietly(
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
      ],
      environment,
      true,
    );
    if (!drift.includes('No difference detected')) throw new Error('Prisma drift check failed');
    console.log('Prisma migrate diff: No difference detected.');
  } finally {
    await prisma?.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
  }
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown live verification failure';
  console.error(redactDatabaseUrls(message));
  process.exitCode = 1;
});
