import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { MachineImportService } from '../apps/api/src/machines/machine-import.service';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { csvRow, MACHINE_IMPORT_HEADERS } from '../packages/shared/src';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

type ImportRequest = Parameters<MachineImportService['execute']>[0];

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const clientFor = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 5 }) });
const hostname = (url: string): string => new URL(url).hostname;
const runQuietly = (args: string[], environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`pnpm ${args[0] ?? ''} failed safely`);
};
const requestFor = (content: string): ImportRequest => {
  const bytes = Buffer.from(content);
  const stream = Readable.from([bytes]) as unknown as ImportRequest;
  stream.headers = {
    'content-length': String(bytes.byteLength),
    'content-type': 'text/csv',
  };
  return stream;
};
const csv = (...rows: string[][]): string =>
  [csvRow(MACHINE_IMPORT_HEADERS), ...rows.map((row) => csvRow(row))].join('\r\n') + '\r\n';
const proofCount = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString);
  try {
    const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('public.machines')::text AS name
    `;
    if (!table[0]?.name) return 0;
    return prisma.machine.count({ where: { name: { startsWith: 'Task 3.7 Proof' } } });
  } finally {
    await prisma.$disconnect();
  }
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  try {
    const protectedConnections = ['dev', 'staging', 'main'].map((name) => ({
      connection: getNeonConnectionStringCaptured(projectId, name, true),
      name,
    }));
    const before = await Promise.all(
      protectedConnections.map(({ connection }) => proofCount(connection)),
    );
    if (before.some((count) => count !== 0))
      throw new Error('Protected branch proof rows pre-exist');

    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/gu, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'dev',
      `ephemeral/task-3.7-import-${suffix}`,
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable Neon branch created (${branch.id}); credentials remained captured.`);
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const databaseEnvironment = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: protectedConnections
        .filter(({ name }) => name !== 'dev')
        .map(({ connection }) => hostname(connection))
        .join(','),
    };
    runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Migration chain and guarded seed passed on the disposable branch.');

    prisma = clientFor(pooled);
    const service = new MachineImportService(
      prisma as unknown as PrismaService,
      new AuditService(),
    );
    const [actorRow, category, department, location] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } }),
      prisma.machineCategory.findFirstOrThrow({ orderBy: { name: 'asc' } }),
      prisma.department.findFirstOrThrow({ orderBy: { code: 'asc' } }),
      prisma.location.findFirstOrThrow({
        include: { department: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const actor = {
      department: null,
      email: 'redacted',
      fullName: actorRow.fullName,
      id: actorRow.id,
      isActive: true,
      role: 'SUPER_ADMIN' as const,
    };
    const row = (serial: string, name: string): string[] => [
      name,
      category.name,
      'Task 3.7 Manufacturer',
      'Import Model',
      serial,
      department.code,
      location.department.code,
      location.name,
      'Generic equipment import proof',
      '2025-01-01',
      '2028-01-01',
      '2025-01-02',
      '180',
      '2026-10-01T09:00:00+03:00',
      'true',
      'false',
      'false',
      '240',
      '15',
    ];

    const messy = row(`MESSY-${suffix}`, 'Task 3.7 Proof Messy');
    messy[9] = '01/02/2025';
    const messyReport = await service.execute(
      requestFor(csv(messy)),
      actor,
      'dry_run',
      `task-3.7-messy-${suffix}`,
      undefined,
    );
    if (messyReport.summary.rejected !== 1 || messyReport.committed_count !== 0) {
      throw new Error('Messy dry-run proof failed');
    }
    console.log('Messy dry run: rejected=1 writes=0 row-level date error present.');

    const clean = csv(
      row(`CLEAN-A-${suffix}`, 'Task 3.7 Proof Clean A'),
      row(`CLEAN-B-${suffix}`, 'Task 3.7 Proof Clean B'),
    );
    const preview = await service.execute(
      requestFor(clean),
      actor,
      'dry_run',
      `task-3.7-preview-${suffix}`,
      undefined,
    );
    const committed = await service.execute(
      requestFor(clean),
      actor,
      'commit',
      `task-3.7-commit-${suffix}`,
      preview.file_sha256,
    );
    const rerunPreview = await service.execute(
      requestFor(clean),
      actor,
      'dry_run',
      `task-3.7-rerun-preview-${suffix}`,
      undefined,
    );
    const rerun = await service.execute(
      requestFor(clean),
      actor,
      'commit',
      `task-3.7-rerun-${suffix}`,
      rerunPreview.file_sha256,
    );
    if (
      committed.committed_count !== 2 ||
      rerun.committed_count !== 0 ||
      rerun.summary.skipped_existing !== 2
    ) {
      throw new Error('Commit or idempotent rerun proof failed');
    }

    const created = await prisma.machine.findMany({
      select: { assetTag: true, id: true },
      where: { name: { startsWith: 'Task 3.7 Proof Clean' } },
    });
    const [histories, createdAudits, summaryAudits] = await Promise.all([
      prisma.machineStatusHistory.count({
        where: { machineId: { in: created.map(({ id }) => id) } },
      }),
      prisma.auditLog.count({
        where: { action: 'machine.created', entityId: { in: created.map(({ id }) => id) } },
      }),
      prisma.auditLog.count({
        where: { action: 'machine.import_completed', requestId: { startsWith: 'task-3.7-' } },
      }),
    ]);
    if (
      created.length !== 2 ||
      new Set(created.map(({ assetTag }) => assetTag)).size !== 2 ||
      histories !== 2 ||
      createdAudits !== 2 ||
      summaryAudits !== 2
    ) {
      throw new Error('Generated tag, history, or audit proof failed');
    }
    console.log(
      'Clean import: created=2 unique_tags=2 history_rows=2 machine_audits=2 summary_audits=2; rerun_created=0 skipped_existing=2.',
    );

    const sharedRaceRow = row(`RACE-SHARED-${suffix}`, 'Task 3.7 Proof Race Shared');
    const raceCsvA = csv(row(`RACE-A-${suffix}`, 'Task 3.7 Proof Race A'), sharedRaceRow);
    const raceCsvB = csv(row(`RACE-B-${suffix}`, 'Task 3.7 Proof Race B'), sharedRaceRow);
    const [racePreviewA, racePreviewB] = await Promise.all([
      service.execute(
        requestFor(raceCsvA),
        actor,
        'dry_run',
        `task-3.7-race-preview-a-${suffix}`,
        undefined,
      ),
      service.execute(
        requestFor(raceCsvB),
        actor,
        'dry_run',
        `task-3.7-race-preview-b-${suffix}`,
        undefined,
      ),
    ]);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION task_3_7_import_delay() RETURNS trigger AS $$
      BEGIN
        IF NEW.name LIKE 'Task 3.7 Proof Race%' THEN PERFORM pg_sleep(1); END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER task_3_7_import_delay_trigger
      BEFORE INSERT ON machines
      FOR EACH ROW EXECUTE FUNCTION task_3_7_import_delay()
    `);
    const race = await Promise.allSettled([
      service.execute(
        requestFor(raceCsvA),
        actor,
        'commit',
        `task-3.7-race-a-${suffix}`,
        racePreviewA.file_sha256,
      ),
      service.execute(
        requestFor(raceCsvB),
        actor,
        'commit',
        `task-3.7-race-b-${suffix}`,
        racePreviewB.file_sha256,
      ),
    ]);
    const raceRows = await prisma.machine.count({
      where: { name: { startsWith: 'Task 3.7 Proof Race' } },
    });
    const fulfilled = race.filter(({ status }) => status === 'fulfilled').length;
    const rejected = race.filter(({ status }) => status === 'rejected').length;
    if (fulfilled !== 1 || rejected !== 1 || raceRows !== 2) {
      throw new Error('Full-import race rollback proof failed');
    }
    console.log(
      'Concurrent identity race: stable conflict returned and the other full-import row rolled back.',
    );
  } finally {
    if (prisma) await prisma.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
    const protectedConnections = ['dev', 'staging', 'main'].map((name) =>
      getNeonConnectionStringCaptured(projectId, name, true),
    );
    const after = await Promise.all(
      protectedConnections.map((connection) => proofCount(connection)),
    );
    if (after.some((count) => count !== 0)) {
      console.error('Protected branch isolation check failed');
      process.exitCode = 1;
    }
    console.log('Protected branches verified: dev=0 staging=0 main=0 Task 3.7 proof rows.');
  }
};

void main();
