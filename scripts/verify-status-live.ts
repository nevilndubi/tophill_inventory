import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { StatusService } from '../apps/api/src/status/status.service';
import type { StatusBoardQuery } from '../packages/shared/src/display-status';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const suppliedBranchId = process.env.TASK43_PROOF_BRANCH_ID?.trim();
const suppliedBranchName = process.env.TASK43_PROOF_BRANCH_NAME?.trim();
const suppliedDirectHost = process.env.TASK43_PROOF_DIRECT_HOST?.trim();
const usesSuppliedBranch = Boolean(suppliedBranchId && suppliedBranchName && suppliedDirectHost);

const connectionForHost = (source: string, host: string): string => {
  const url = new URL(source);
  url.hostname = host;
  return url.toString();
};
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
    throw new Error(
      `pnpm ${args[0] ?? ''} failed safely: ${redactDatabaseUrls(result.stderr.trim())}`,
    );
  }
  return output ? result.stdout.trim() : '';
};

type CapturedQuery = { parameters: unknown[]; sql: string };
type ExplainNode = {
  'Index Name'?: string;
  Plans?: ExplainNode[];
  [key: string]: unknown;
};
type ExplainDocument = {
  'Execution Time': number;
  Plan: ExplainNode;
  'Planning Time': number;
};

const collectIndexes = (node: ExplainNode, indexes = new Set<string>()): Set<string> => {
  if (typeof node['Index Name'] === 'string') indexes.add(node['Index Name']);
  for (const child of node.Plans ?? []) collectIndexes(child, indexes);
  return indexes;
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

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
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
        `ephemeral/task-4.3-status-${suffix}`,
        new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      );
    }
    console.log(`Disposable Neon branch ready (${branch.id}); credentials remained captured.`);
    const suppliedPooledHost = suppliedDirectHost;
    const suppliedUnpooledHost = suppliedDirectHost?.replace(/-pooler(?=\.)/u, '');
    const direct = usesSuppliedBranch
      ? connectionForHost(process.env.DIRECT_URL!, suppliedUnpooledHost!)
      : getNeonConnectionStringCaptured(projectId, branch.id, false);
    const pooled = usesSuppliedBranch
      ? connectionForHost(process.env.DATABASE_URL!, suppliedPooledHost!)
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
    if (process.env.TASK43_SKIP_MIGRATE !== 'true') {
      runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    }
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Migration chain and guarded seed passed on the disposable branch.');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pooled, max: 10 }) });
    const user = await prisma.user.findFirstOrThrow({
      include: { department: { select: { code: true, id: true, name: true } } },
      where: { role: 'STAFF' },
    });
    const actor = actorFrom(user);
    const reference = await prisma.machine.findFirstOrThrow({
      select: { categoryId: true, departmentId: true, locationId: true },
      where: { deletedAt: null },
    });

    await prisma.$transaction([
      prisma.booking.deleteMany({
        where: { machine: { name: { startsWith: 'Task43 fixture ' } } },
      }),
      prisma.usageSession.deleteMany({
        where: { machine: { name: { startsWith: 'Task43 fixture ' } } },
      }),
      prisma.machine.deleteMany({ where: { name: { startsWith: 'Task43 fixture ' } } }),
    ]);

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO machines (
          id, asset_tag, name, category_id, manufacturer, model, serial_number,
          department_id, location_id, condition, retired_on,
          allow_booking_when_needs_service, next_service_due_at, deleted_at
        )
        SELECT
          gen_random_uuid(),
          'HM-8' || lpad(series::text, 5, '0'),
          'Task43 fixture ' || lpad(series::text, 3, '0'),
          $1::uuid,
          'Task43 Manufacturer',
          'Status fixture',
          'TASK43-' || lpad(series::text, 4, '0'),
          $2::uuid,
          $3::uuid,
          CASE
            WHEN series <= 330 THEN 'OPERATIONAL'::machine_condition
            WHEN series <= 374 THEN 'NEEDS_SERVICE'::machine_condition
            WHEN series <= 409 THEN 'UNDER_MAINTENANCE'::machine_condition
            WHEN series <= 427 THEN 'OUT_OF_SERVICE'::machine_condition
            ELSE 'RETIRED'::machine_condition
          END,
          CASE WHEN series BETWEEN 428 AND 441 THEN CURRENT_DATE ELSE NULL END,
          CASE WHEN series BETWEEN 331 AND 374 THEN true ELSE false END,
          CASE WHEN series % 10 = 0 OR series BETWEEN 428 AND 440
            THEN statement_timestamp() - interval '1 day' ELSE NULL END,
          CASE WHEN series = 441 THEN statement_timestamp() ELSE NULL END
        FROM generate_series(1, 441) series
      `,
      reference.categoryId,
      reference.departmentId,
      reference.locationId,
    );
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO usage_sessions (
          id, machine_id, user_id, started_at, expected_end_at, purpose
        )
        SELECT
          gen_random_uuid(), m.id, $1::uuid,
          statement_timestamp() - interval '2 hours',
          CASE WHEN m.asset_tag = 'HM-800265'
            THEN statement_timestamp() - interval '1 hour'
            ELSE statement_timestamp() + interval '1 hour' END,
          'Task 4.3 status proof'
        FROM machines m
        WHERE m.asset_tag BETWEEN 'HM-800265' AND 'HM-800330'
           OR m.asset_tag IN ('HM-800332', 'HM-800375', 'HM-800410', 'HM-800428')
      `,
      actor.id,
    );
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO bookings (
          id, machine_id, requested_by_user_id, starts_at, ends_at,
          blocked_until, status, purpose
        )
        SELECT
          gen_random_uuid(), m.id, $1::uuid,
          statement_timestamp() + interval '1 day' + row_number() OVER (ORDER BY m.asset_tag) * interval '1 second',
          statement_timestamp() + interval '1 day 1 hour' + row_number() OVER (ORDER BY m.asset_tag) * interval '1 second',
          statement_timestamp() + interval '1 day 1 hour' + row_number() OVER (ORDER BY m.asset_tag) * interval '1 second',
          'CONFIRMED'::booking_status,
          'Task 4.3 next-booking proof'
        FROM machines m
        WHERE m.name LIKE 'Task43 fixture %' AND m.deleted_at IS NULL
      `,
      actor.id,
    );
    console.log('Performance fixture loaded: active_registry_total=500 plus one hidden row.');

    const captured: CapturedQuery[] = [];
    const countedPrisma = {
      $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => {
        captured.push({ parameters, sql });
        return prisma!.$queryRawUnsafe(sql, ...parameters);
      },
    } as unknown as PrismaService;
    const service = new StatusService(countedPrisma);

    const priorityProofs = [
      ['HM-800001', 'AVAILABLE_OK'],
      ['HM-800331', 'AVAILABLE_NEEDS_SERVICE'],
      ['HM-800265', 'IN_USE'],
      ['HM-800332', 'IN_USE'],
      ['HM-800375', 'UNDER_MAINTENANCE'],
      ['HM-800410', 'OUT_OF_SERVICE'],
      ['HM-800428', 'RETIRED'],
    ] as const;
    for (const [assetTag, expected] of priorityProofs) {
      const machine = await prisma.machine.findUniqueOrThrow({ where: { assetTag } });
      const status = await service.get(actor, machine.id);
      if (status.display_status !== expected) {
        throw new Error(`Priority proof failed safely for ${expected}`);
      }
      if (expected === 'RETIRED' && status.service_due) {
        throw new Error('Retired machine incorrectly reported service due');
      }
    }
    const hidden = await prisma.machine.findUniqueOrThrow({ where: { assetTag: 'HM-800441' } });
    try {
      await service.get(actor, hidden.id);
      throw new Error('Soft-deleted machine was visible');
    } catch (error: unknown) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('response' in error) ||
        (error.response as { code?: string }).code !== 'MACHINE_NOT_FOUND'
      ) {
        throw error;
      }
    }
    console.log(
      'Priority proof: all seven conflicts passed; deleted_hidden=true retired_visible=true.',
    );

    const allItems = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await service.board(actor, {
        order: 'asc',
        page,
        page_size: 200,
        sort: 'asset_tag',
      });
      allItems.push(...result.items);
    }
    const seeded = await prisma.machine.findMany({
      select: { id: true },
      where: { deletedAt: null, name: { not: { startsWith: 'Task43 fixture ' } } },
    });
    const boardById = new Map(allItems.map((item) => [item.id, item]));
    for (const machine of seeded) {
      const detail = await service.get(actor, machine.id);
      const boardItem = boardById.get(machine.id);
      if (!boardItem) throw new Error('Seeded machine missing from board');
      const { as_of: detailAsOf, ...detailComparable } = detail;
      const { as_of: boardAsOf, ...boardComparable } = boardItem;
      if (
        !detailAsOf ||
        !boardAsOf ||
        JSON.stringify(detailComparable) !== JSON.stringify(boardComparable)
      ) {
        throw new Error('Detail and board status disagree');
      }
    }
    console.log(`Detail/board parity proof: seeded_machines=${seeded.length} mismatches=0.`);

    const benchmark = async (label: string, query: StatusBoardQuery) => {
      captured.length = 0;
      const started = performance.now();
      const result = await service.board(actor, query);
      const elapsed = performance.now() - started;
      if (captured.length !== 1) throw new Error(`${label} used ${captured.length} queries`);
      console.log(
        `Board benchmark ${label}: queries=1 server_ms=${elapsed.toFixed(2)} returned=${result.items.length} total=${result.total}.`,
      );
      return { capture: captured[0]!, elapsed, result };
    };

    const defaults = await benchmark('default_page_50', {
      order: 'asc',
      page: 1,
      page_size: 50,
      sort: 'asset_tag',
    });
    await benchmark('page_200', {
      order: 'asc',
      page: 1,
      page_size: 200,
      sort: 'asset_tag',
    });
    await benchmark('trigram_search', {
      order: 'asc',
      page: 1,
      page_size: 50,
      q: 'Task43 fixture 120',
      sort: 'asset_tag',
    });
    await benchmark('status_filter', {
      order: 'asc',
      page: 1,
      page_size: 50,
      sort: 'status',
      status: ['IN_USE'],
    });
    const statusTotal = Object.values(defaults.result.counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (statusTotal !== 500 || defaults.result.total !== 500) {
      throw new Error('Board counts do not describe the complete active registry');
    }
    console.log(`Seeded/fixture display counts: ${JSON.stringify(defaults.result.counts)}.`);

    const explainRows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': ExplainDocument[] }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${defaults.capture.sql}`,
      ...defaults.capture.parameters,
    );
    const document = explainRows[0]?.['QUERY PLAN'][0];
    if (!document) throw new Error('EXPLAIN returned no plan');
    const indexes = [...collectIndexes(document.Plan)].sort();
    console.log(`EXPLAIN indexes observed: ${indexes.join(',') || 'none'}.`);
    if (!indexes.some((index) => index.startsWith('bookings_'))) {
      throw new Error('Principal board plan did not use an existing booking index');
    }
    console.log(
      `EXPLAIN: planning_ms=${document['Planning Time'].toFixed(2)} database_ms=${document['Execution Time'].toFixed(2)} indexes=${indexes.join(',')}.`,
    );
    console.log(
      `Rough 5,000-machine linear estimate: database_ms=${(document['Execution Time'] * 10).toFixed(2)}; caching/realtime remain deferred.`,
    );
    if (defaults.elapsed > 150) {
      console.log(
        'Performance note: default board exceeded the 150 ms target; no index added speculatively.',
      );
    }

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
    if (!diff.includes('No difference detected')) throw new Error('Prisma drift output unexpected');
    console.log('Prisma migrate diff: No difference detected.');
  } finally {
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
    `[task-4.3-live] ${redactDatabaseUrls(error instanceof Error ? error.message : 'Unknown failure')}`,
  );
  process.exitCode = 1;
});
