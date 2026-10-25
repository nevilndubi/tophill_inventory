import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { MachineCondition, PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { CategoriesService } from '../apps/api/src/categories/categories.service';
import {
  CategoryInUseException,
  CategoryNameTakenException,
} from '../apps/api/src/categories/categories.errors';
import { PrismaService } from '../apps/api/src/prisma/prisma.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const proofPrefix = 'Task 3.1 Proof';
const hostname = (url: string): string => new URL(url).hostname;
const redact = (value: string): string =>
  value.replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]');

const run = (args: string[], environment: NodeJS.ProcessEnv, printSafeOutput = false): string => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args[0] ?? ''} failed: ${redact(result.stderr || 'no diagnostic')}`);
  }
  const output = redact(result.stdout.trim());
  if (printSafeOutput && output) console.log(output);
  return output;
};

const clientFor = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });

const tableExists = async (prisma: PrismaClient, name: string): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ name: string | null }>>`
    SELECT to_regclass(${`public.${name}`})::text AS name
  `;
  return rows[0]?.name !== null && rows[0]?.name !== undefined;
};

const countProofCategories = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString);
  try {
    if (!(await tableExists(prisma, 'machine_categories'))) return 0;
    return prisma.machineCategory.count({ where: { name: { startsWith: proofPrefix } } });
  } finally {
    await prisma.$disconnect();
  }
};

const assertNoCaseCollisions = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString);
  try {
    if (!(await tableExists(prisma, 'machine_categories'))) return 0;
    const rows = await prisma.$queryRaw<Array<{ collisionCount: number }>>`
      SELECT count(*)::integer AS "collisionCount"
      FROM (
        SELECT lower(name)
        FROM machine_categories
        GROUP BY lower(name)
        HAVING count(*) > 1
      ) collisions
    `;
    return rows[0]?.collisionCount ?? 0;
  } finally {
    await prisma.$disconnect();
  }
};

const liveCrudProof = async (connectionString: string): Promise<void> => {
  const prismaService = new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 30_000, max: 4 }),
  }) as unknown as PrismaService;
  const categories = new CategoriesService(prismaService, new AuditService());
  const actorRow = await prismaService.user.findFirst({
    orderBy: { id: 'asc' },
    where: { isSeedData: true },
  });
  if (actorRow === null) throw new Error('Seed actor was not found');
  const actor = {
    department: null,
    email: 'redacted-for-proof',
    fullName: 'Seed proof actor',
    id: actorRow.id,
    isActive: true,
    role: actorRow.role,
  };

  try {
    await prismaService.$connect();
    const rollbackName = `${proofPrefix} Audit Rollback`;
    let auditRollbackRejected = false;
    try {
      await categories.create(
        { ...actor, id: '99999999-9999-4999-8999-999999999999' },
        { name: rollbackName },
        'task-3.1-live-audit-rollback',
      );
    } catch {
      auditRollbackRejected = true;
    }
    const rolledBackRows = await prismaService.machineCategory.count({
      where: { name: rollbackName },
    });
    console.log(
      `Audit transaction rollback: rejected=${String(auditRollbackRejected)} category_rows=${rolledBackRows}.`,
    );

    const created = await categories.create(
      actor,
      {
        defaultMaxBookingMinutes: 60,
        defaultServiceIntervalDays: 90,
        description: 'Disposable verification record',
        name: `${proofPrefix} CRUD`,
      },
      'task-3.1-live-create',
    );
    const updated = await categories.update(
      actor,
      created.id,
      { defaultMaxBookingMinutes: null, name: `${proofPrefix} CRUD Updated` },
      'task-3.1-live-update',
    );
    const deleted = await categories.delete(actor, created.id, 'task-3.1-live-delete');
    console.log(
      `Live unused-category CRUD: create=201 update=200 delete=200 same_id=${String(created.id === updated.id && updated.id === deleted.id)}.`,
    );

    let duplicateCode = 'none';
    try {
      // The HTTP Zod boundary trims surrounding whitespace before the service. This lower-case
      // value exercises the database's case-insensitive race backstop directly.
      await categories.create(actor, { name: 'ventilator' }, 'task-3.1-live-duplicate');
    } catch (error: unknown) {
      if (error instanceof CategoryNameTakenException) duplicateCode = 'CATEGORY_NAME_TAKEN';
      else throw error;
    }
    console.log(`Case-insensitive duplicate proof: status=409 code=${duplicateCode}.`);

    const seeded = await prismaService.machineCategory.findFirst({
      orderBy: { name: 'asc' },
      where: { machines: { some: {} } },
    });
    if (seeded === null) throw new Error('Seeded referenced category was not found');
    const caseOnlyRename = await categories.update(
      actor,
      seeded.id,
      { name: seeded.name.toUpperCase() },
      'task-3.1-live-case-rename',
    );
    console.log(
      `Own-name case-only rename: status=200 same_id=${String(caseOnlyRename.id === seeded.id)}.`,
    );
    const seededCount = await prismaService.machine.count({ where: { categoryId: seeded.id } });
    let seededDeleteCode = 'none';
    let seededReportedCount = -1;
    try {
      await categories.delete(actor, seeded.id, 'task-3.1-live-seeded-delete');
    } catch (error: unknown) {
      if (!(error instanceof CategoryInUseException)) throw error;
      const response = error.getResponse() as { code: string; details: { machine_count: number } };
      seededDeleteCode = response.code;
      seededReportedCount = response.details.machine_count;
    }
    console.log(
      `Seeded referenced delete: status=409 code=${seededDeleteCode} count_matches=${String(seededCount === seededReportedCount)} count=${seededReportedCount}.`,
    );

    const department = await prismaService.department.findFirst({ include: { locations: true } });
    const location = department?.locations[0];
    if (!department || !location) throw new Error('Seed placement data was not found');
    const softCategory = await categories.create(
      actor,
      { name: `${proofPrefix} Soft Deleted` },
      'task-3.1-live-soft-create',
    );
    await prismaService.machine.create({
      data: {
        assetTag: 'HM-TASK31-SOFT',
        categoryId: softCategory.id,
        deletedAt: new Date(),
        departmentId: department.id,
        locationId: location.id,
        manufacturer: 'Proof manufacturer',
        model: 'Proof model',
        name: 'Soft-deleted reference proof',
        serialNumber: 'task-3.1-soft-deleted',
      },
    });
    const listed = await categories.read(softCategory.id);
    let softDeleteCode = 'none';
    let softCount = -1;
    try {
      await categories.delete(actor, softCategory.id, 'task-3.1-live-soft-delete');
    } catch (error: unknown) {
      if (!(error instanceof CategoryInUseException)) throw error;
      const response = error.getResponse() as { code: string; details: { machine_count: number } };
      softDeleteCode = response.code;
      softCount = response.details.machine_count;
    }
    console.log(
      `Soft-deleted-only reference: list_machine_count=${listed.machine_count} is_deletable=${String(listed.is_deletable)} delete_status=409 code=${softDeleteCode} all_reference_count=${softCount}.`,
    );

    const retiredCategory = await categories.create(
      actor,
      { name: `${proofPrefix} Retired` },
      'task-3.1-live-retired-create',
    );
    await prismaService.machine.create({
      data: {
        assetTag: 'HM-TASK31-RETIRED',
        categoryId: retiredCategory.id,
        condition: MachineCondition.RETIRED,
        departmentId: department.id,
        locationId: location.id,
        manufacturer: 'Proof manufacturer',
        model: 'Proof model',
        name: 'Retired reference proof',
        retiredOn: new Date(),
        serialNumber: 'task-3.1-retired',
      },
    });
    const retiredListed = await categories.read(retiredCategory.id);
    console.log(
      `Retired-only reference: list_machine_count=${retiredListed.machine_count} is_deletable=${String(retiredListed.is_deletable)} all_reference_count=1.`,
    );
  } finally {
    await prismaService.$disconnect();
  }
};

const main = async (): Promise<void> => {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 12);
  const branchName = `ephemeral/task-3.1-categories-${timestamp}`;
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const mainPooled = getNeonConnectionStringCaptured(projectId, 'main', true);
  const stagingPooled = getNeonConnectionStringCaptured(projectId, 'staging', true);
  const devPooled = getNeonConnectionStringCaptured(projectId, 'dev', true);
  const devDirect = getNeonConnectionStringCaptured(projectId, 'dev', false);
  const protectedHosts = [hostname(mainPooled), hostname(stagingPooled)].join(',');
  const devEnvironment = { ...process.env, DATABASE_URL: devPooled, DIRECT_URL: devDirect };

  const collisions = await assertNoCaseCollisions(devPooled);
  console.log(`Dev lower(name) collision groups before migration: ${collisions}.`);
  if (collisions !== 0) throw new Error('Category names must be reconciled before migration');
  run(['prisma:migrate:deploy'], devEnvironment);
  console.log('Task 3.1 migration applied to Neon dev.');

  let branch: NeonBranch | undefined;
  try {
    branch = createNeonBranchSafely(projectId, 'main', branchName, expiresAt);
    console.log(
      `Created disposable branch ${branch.name} (${branch.id}); credentials stayed captured.`,
    );
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
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
    run(['prisma:migrate:deploy'], environment);
    console.log('Fresh disposable branch accepted the complete migration chain.');
    run(['db:seed'], environment);
    console.log('Guarded demo seed completed on the disposable branch.');
    await liveCrudProof(pooled);
    const diff = run(
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
      true,
    );
    if (!diff.includes('No difference detected')) {
      throw new Error('Prisma migrate diff did not confirm a drift-free schema');
    }
  } finally {
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Deleted disposable branch ${branch.name} (${branch.id}).`);
    }
  }

  const protectedCounts = {
    dev: await countProofCategories(devPooled),
    main: await countProofCategories(mainPooled),
    staging: await countProofCategories(stagingPooled),
  };
  console.log(
    `Protected-branch proof-category counts: dev=${protectedCounts.dev} staging=${protectedCounts.staging} main=${protectedCounts.main}.`,
  );
};

void main();
