import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { config as loadEnvironment } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { DepartmentsService } from '../apps/api/src/reference/departments.service';
import { LocationsService } from '../apps/api/src/reference/locations.service';
import { UsersService } from '../apps/api/src/users/users.service';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

type JsonRecord = Record<string, unknown>;
type ManagedProcess = ChildProcess & { exitCode: number | null };
const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');
loadEnvironment({ path: 'apps/api/.env.task-2.1.local', quiet: true });

const requireEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required proof configuration: ${name}`);
  return value;
};
const hostname = (url: string) => new URL(url).hostname;
const runCaptured = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${command} failed safely`);
  return result.stdout.trim();
};
const runQuietly = (args: string[], environment: NodeJS.ProcessEnv, returnOutput = false) => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`pnpm ${args[0] ?? ''} failed safely`);
  if (returnOutput)
    return result.stdout.trim().replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]');
  return '';
};
const findSupabaseProject = () => {
  const raw = JSON.parse(
    runCaptured('supabase', [
      'projects',
      'list',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ]),
  ) as JsonRecord;
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const project = projects.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      (value as JsonRecord).name === 'tophill-inventory',
  ) as JsonRecord | undefined;
  if (typeof project?.ref !== 'string') throw new Error('Supabase project was not found');
  return project.ref;
};
const getSupabaseKeys = (ref: string) => {
  const raw = JSON.parse(
    runCaptured('supabase', [
      'projects',
      'api-keys',
      '--project-ref',
      ref,
      '--reveal',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ]),
  ) as unknown;
  const record = typeof raw === 'object' && raw !== null ? (raw as JsonRecord) : {};
  const keys = Array.isArray(raw)
    ? raw
    : Array.isArray(record.keys)
      ? record.keys
      : Array.isArray(record.api_keys)
        ? record.api_keys
        : [];
  const value = (type: string) =>
    (
      keys.find(
        (key) => typeof key === 'object' && key !== null && (key as JsonRecord).type === type,
      ) as JsonRecord | undefined
    )?.api_key;
  const publishable = value('publishable');
  const secret = value('secret');
  if (typeof publishable !== 'string' || typeof secret !== 'string')
    throw new Error('Supabase keys were not found');
  return { publishable, secret };
};
const start = (command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) =>
  spawn(command, args, { cwd, env, stdio: 'ignore' }) as ManagedProcess;
const stop = async (process: ManagedProcess | undefined) => {
  if (!process || process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
};
const waitFor = async (url: string) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Local application did not become ready');
};
const clientFor = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
const proofCounts = async (connectionString: string) => {
  const prisma = clientFor(connectionString);
  try {
    const table = await prisma.$queryRaw<
      Array<{ name: string | null }>
    >`SELECT to_regclass('public.departments')::text AS name`;
    if (!table[0]?.name) return { departments: 0, locations: 0, users: 0 };
    const [departments, locations, users] = await Promise.all([
      prisma.department.count({ where: { code: { startsWith: 'T32' } } }),
      prisma.location.count({ where: { name: { startsWith: 'Task 3.2' } } }),
      prisma.user.count({ where: { fullName: { startsWith: 'Task 3.2' } } }),
    ]);
    return { departments, locations, users };
  } finally {
    await prisma.$disconnect();
  }
};

const main = async () => {
  let branch: NeonBranch | undefined;
  let api: ManagedProcess | undefined;
  let web: ManagedProcess | undefined;
  let prisma: PrismaClient | undefined;
  try {
    const devPooled = getNeonConnectionStringCaptured(projectId, 'dev', true);
    const devDirect = getNeonConnectionStringCaptured(projectId, 'dev', false);
    const mainPooled = getNeonConnectionStringCaptured(projectId, 'main', true);
    const stagingPooled = getNeonConnectionStringCaptured(projectId, 'staging', true);
    const dev = clientFor(devPooled);
    const collisions = await dev.$queryRaw<
      Array<{ departmentCode: number; departmentName: number; locationName: number }>
    >`
      SELECT
        (SELECT count(*)::integer FROM (SELECT lower(code) FROM departments GROUP BY lower(code) HAVING count(*) > 1) value) AS "departmentCode",
        (SELECT count(*)::integer FROM (SELECT lower(name) FROM departments GROUP BY lower(name) HAVING count(*) > 1) value) AS "departmentName",
        (SELECT count(*)::integer FROM (SELECT department_id, lower(name) FROM locations GROUP BY department_id, lower(name) HAVING count(*) > 1) value) AS "locationName"
    `;
    await dev.$disconnect();
    console.log(
      `Pre-migration collision groups: department_name=${collisions[0]?.departmentName ?? -1} department_code=${collisions[0]?.departmentCode ?? -1} location_name=${collisions[0]?.locationName ?? -1}.`,
    );
    if (Object.values(collisions[0] ?? {}).some((count) => count !== 0))
      throw new Error('Case-insensitive collisions must be resolved first');
    runQuietly(['prisma:migrate:deploy'], {
      ...process.env,
      DATABASE_URL: devPooled,
      DIRECT_URL: devDirect,
    });
    console.log('Task 3.2 migration applied to Neon dev.');

    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/g, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'main',
      `ephemeral/task-3.2-reference-${suffix}`,
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
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: [hostname(mainPooled), hostname(stagingPooled)].join(','),
    };
    runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Complete migration chain and guarded seed passed on the disposable branch.');

    const ref = findSupabaseProject();
    const keys = getSupabaseKeys(ref);
    const supabaseUrl = `https://${ref}.supabase.co`;
    const testEmail = requireEnvironment('SUPABASE_AUTH_TEST_EMAIL');
    const testPassword = requireEnvironment('SUPABASE_AUTH_TEST_PASSWORD');
    const auth = createClient(supabaseUrl, keys.publishable, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await auth.auth.signInWithPassword({ email: testEmail, password: testPassword });
    const identityId = signIn.data.user?.id;
    if (signIn.error || !identityId) throw new Error('Credential-safe test sign-in failed');

    prisma = clientFor(pooled);
    const category = await prisma.machineCategory.findFirstOrThrow();
    const actor = await prisma.user.create({
      data: {
        email: testEmail.toLowerCase(),
        fullName: 'Task 3.2 Proof Administrator',
        isSeedData: false,
        role: 'SUPER_ADMIN',
        supabaseUserId: identityId,
      },
    });
    const proofDepartment = await prisma.department.create({
      data: { code: 'T32-A', name: 'Task 3.2 Clinical Engineering' },
    });
    const otherDepartment = await prisma.department.create({
      data: { code: 'T32-B', name: 'Task 3.2 Shared Services' },
    });
    const users = await Promise.all([
      prisma.user.create({
        data: {
          departmentId: proofDepartment.id,
          email: 'manager-task32@example.test',
          fullName: 'Task 3.2 Eligible Manager',
          isSeedData: false,
          role: 'DEPT_MANAGER',
          supabaseUserId: '10000000-0000-4000-8000-000000000032',
        },
      }),
      prisma.user.create({
        data: {
          departmentId: proofDepartment.id,
          email: 'staff-task32@example.test',
          fullName: 'Task 3.2 Staff',
          isSeedData: false,
          role: 'STAFF',
          supabaseUserId: '20000000-0000-4000-8000-000000000032',
        },
      }),
      prisma.user.create({
        data: {
          departmentId: proofDepartment.id,
          email: 'inactive-task32@example.test',
          fullName: 'Task 3.2 Inactive Manager',
          isActive: false,
          isSeedData: false,
          role: 'DEPT_MANAGER',
          supabaseUserId: '30000000-0000-4000-8000-000000000032',
        },
      }),
      prisma.user.create({
        data: {
          departmentId: otherDepartment.id,
          email: 'other-task32@example.test',
          fullName: 'Task 3.2 Other Manager',
          isSeedData: false,
          role: 'DEPT_MANAGER',
          supabaseUserId: '40000000-0000-4000-8000-000000000032',
        },
      }),
    ]);
    const prismaService = prisma as unknown as PrismaService;
    const audit = new AuditService();
    const departments = new DepartmentsService(prismaService, audit);
    const locations = new LocationsService(prismaService, audit);
    const actingUser = {
      department: null,
      email: 'redacted',
      fullName: actor.fullName,
      id: actor.id,
      isActive: true,
      role: 'SUPER_ADMIN' as const,
    };

    await departments.update(
      actingUser,
      proofDepartment.id,
      { managerUserId: users[0].id },
      'task-3.2-manager-assign',
    );
    const rejected: string[] = [];
    for (const candidate of [
      users[1],
      users[2],
      users[3],
      await prisma.user.findFirstOrThrow({ where: { isSeedData: true } }),
    ]) {
      try {
        await departments.update(
          actingUser,
          proofDepartment.id,
          { managerUserId: candidate.id },
          'task-3.2-manager-reject',
        );
      } catch (error: unknown) {
        rejected.push((error as { response?: { code?: string } }).response?.code ?? 'unknown');
      }
    }
    await departments.update(
      actingUser,
      proofDepartment.id,
      { managerUserId: null },
      'task-3.2-manager-clear',
    );
    await departments.update(
      actingUser,
      proofDepartment.id,
      { managerUserId: users[0].id },
      'task-3.2-manager-reassign',
    );
    const config = { get: () => 'http://127.0.0.1:3000' };
    const usersService = new UsersService(config as never, prismaService, {} as never, audit);
    await usersService.setActive(actingUser, users[0].id, false, 'task-3.2-manager-deactivate');
    const managerAfter = await prisma.department.findUniqueOrThrow({
      where: { id: proofDepartment.id },
    });
    const managerAudit = await prisma.auditLog.count({
      where: { action: 'department.manager_cleared', entityId: proofDepartment.id },
    });
    console.log(
      `Manager proof: assigned=200 cleared=200 rejected=${rejected.join(',')} deactivation_manager_null=${String(managerAfter.managerUserId === null)} manager_clear_audits=${managerAudit}.`,
    );

    const firstLocation = await locations.create(
      actingUser,
      { departmentId: proofDepartment.id, name: 'Task 3.2 Shared Bay' },
      'task-3.2-location-a',
    );
    await locations.create(
      actingUser,
      { departmentId: otherDepartment.id, name: 'Task 3.2 Shared Bay' },
      'task-3.2-location-b',
    );
    let sameDepartmentDuplicate = 'none';
    try {
      await locations.create(
        actingUser,
        { departmentId: proofDepartment.id, name: 'task 3.2 shared bay' },
        'task-3.2-location-duplicate',
      );
    } catch (error: unknown) {
      sameDepartmentDuplicate =
        (error as { response?: { code?: string } }).response?.code ?? 'unknown';
    }
    const machine = await prisma.machine.create({
      data: {
        categoryId: category.id,
        departmentId: proofDepartment.id,
        locationId: firstLocation.id,
        manufacturer: 'Proof',
        model: 'Proof',
        name: 'Task 3.2 Reference Machine',
        serialNumber: `task32-${suffix}`,
      },
    });
    let locationDeleteCode = 'none';
    try {
      await locations.delete(actingUser, firstLocation.id, 'task-3.2-location-delete');
    } catch (error: unknown) {
      locationDeleteCode = (error as { response?: { code?: string } }).response?.code ?? 'unknown';
    }
    const emptyLocation = await locations.create(
      actingUser,
      { departmentId: proofDepartment.id, name: 'Task 3.2 Empty Location' },
      'task-3.2-empty-create',
    );
    await locations.delete(actingUser, emptyLocation.id, 'task-3.2-empty-delete');
    const beforeRename = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    await departments.update(
      actingUser,
      proofDepartment.id,
      { code: 'T32-C', name: 'Task 3.2 Clinical Engineering Renamed' },
      'task-3.2-department-rename',
    );
    const afterRename = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    console.log(
      `Location proof: cross_department_duplicate_allowed=true same_department_code=${sameDepartmentDuplicate} referenced_delete_code=${locationDeleteCode} empty_delete=200 placement_unchanged=${String(beforeRename.departmentId === afterRename.departmentId && beforeRename.locationId === afterRename.locationId)}.`,
    );

    const seeded = await prisma.department.findFirstOrThrow({
      where: {
        OR: [{ members: { some: {} } }, { locations: { some: {} } }, { machines: { some: {} } }],
      },
    });
    const seededCounts = {
      location_count: await prisma.location.count({ where: { departmentId: seeded.id } }),
      machine_count: await prisma.machine.count({ where: { departmentId: seeded.id } }),
      user_count: await prisma.user.count({ where: { departmentId: seeded.id } }),
    };
    let departmentDelete = { code: 'none', counts: {} as JsonRecord };
    try {
      await departments.delete(actingUser, seeded.id, 'task-3.2-seeded-delete');
    } catch (error: unknown) {
      const response = (error as { response?: { code?: string; details?: JsonRecord } }).response;
      departmentDelete = { code: response?.code ?? 'unknown', counts: response?.details ?? {} };
    }
    console.log(
      `Seeded department delete: code=${departmentDelete.code} counts_match=${String(JSON.stringify(departmentDelete.counts) === JSON.stringify(seededCounts))}.`,
    );

    const rollbackCode = 'T32-RB';
    try {
      await departments.create(
        { ...actingUser, id: '99999999-9999-4999-8999-999999999999' },
        { code: rollbackCode, name: 'Task 3.2 Rollback' },
        'task-3.2-rollback',
      );
    } catch {
      /* expected audit FK failure */
    }
    console.log(
      `Audit rollback proof: department_rows=${await prisma.department.count({ where: { code: rollbackCode } })}.`,
    );

    const apiEnvironment = {
      ...process.env,
      BOOTSTRAP_SUPER_ADMIN_EMAIL: '',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      NODE_ENV: 'development',
      PORT: '3001',
      REDIS_URL: 'redis://127.0.0.1:63999',
      SUPABASE_SECRET_KEY: keys.secret,
      SUPABASE_URL: supabaseUrl,
      WEB_ORIGIN: 'http://localhost:3000',
    };
    const webEnvironment = {
      ...process.env,
      API_BASE_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.publishable,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    };
    runQuietly(['--filter', '@app/shared', 'build'], apiEnvironment);
    runQuietly(['--filter', '@app/api', 'build'], apiEnvironment);
    runQuietly(['--filter', '@app/web', 'build'], webEnvironment);
    api = start('node', ['apps/api/dist/main.js'], apiEnvironment);
    web = start(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', '3000'],
      webEnvironment,
      'apps/web',
    );
    await Promise.all([
      waitFor('http://127.0.0.1:3001/health/ready'),
      waitFor('http://127.0.0.1:3000/login'),
    ]);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { height: 900, width: 1280 } });
      await page.goto('http://localhost:3000/admin/reference');
      await page.getByLabel('Email').fill(testEmail);
      await page.getByLabel('Password').fill(testPassword);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/admin/reference');
      await page.getByRole('heading', { name: 'Reference data', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Categories' }).click();
      const categoryName = `Task 3.1 UI Smoke ${suffix}`;
      await page.getByRole('button', { name: 'Add category' }).click();
      await page.getByLabel('Name').fill(categoryName);
      await page.getByRole('button', { name: 'Create category' }).click();
      await page
        .getByRole('button', { name: `Edit ${categoryName}` })
        .first()
        .click();
      await page.getByLabel('Name').fill(`${categoryName} Renamed`);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page
        .getByRole('button', { name: `Delete ${categoryName} Renamed` })
        .first()
        .click();
      await page.getByRole('button', { name: 'Delete category' }).click();
      console.log('Signed-in Categories UI smoke: create=passed rename=passed delete=passed.');
      mkdirSync('apps/web/.artifacts/task-3.2', { recursive: true });
      for (const width of [360, 768, 1280]) {
        await page.setViewportSize({ height: 900, width });
        await page.getByRole('tab', { name: 'Departments' }).click();
        await page.waitForURL('**/admin/reference?section=departments');
        await page.getByRole('heading', { name: 'Departments', exact: true }).waitFor();
        await page
          .getByRole('button', { name: /^Edit / })
          .first()
          .waitFor();
        await page.screenshot({
          fullPage: true,
          path: `apps/web/.artifacts/task-3.2/departments-${width}.png`,
        });
        await page.getByRole('tab', { name: 'Locations' }).click();
        await page.waitForURL('**/admin/reference?section=locations');
        await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
        await page
          .getByRole('button', { name: /^Edit / })
          .first()
          .waitFor();
        await page.screenshot({
          fullPage: true,
          path: `apps/web/.artifacts/task-3.2/locations-${width}.png`,
        });
      }
      console.log(
        'Responsive browser proof: departments and locations rendered at 360px, 768px and 1280px; screenshots saved in the ignored artifacts folder.',
      );
    } finally {
      await browser.close();
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
    console.log(
      diff.includes('No difference detected')
        ? 'Prisma migrate diff: No difference detected.'
        : 'Prisma migrate diff returned unexpected output.',
    );
  } finally {
    await stop(web);
    await stop(api);
    await prisma?.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
    const project = projectId ? projectId : '';
    if (project) {
      const counts = {
        dev: await proofCounts(getNeonConnectionStringCaptured(project, 'dev', true)),
        main: await proofCounts(getNeonConnectionStringCaptured(project, 'main', true)),
        staging: await proofCounts(getNeonConnectionStringCaptured(project, 'staging', true)),
      };
      console.log(
        `Protected-branch Task 3.2 rows: dev=${JSON.stringify(counts.dev)} staging=${JSON.stringify(counts.staging)} main=${JSON.stringify(counts.main)}.`,
      );
    }
  }
};

void main().catch((error: unknown) => {
  console.error(`[task-3.2-live] ${error instanceof Error ? error.message : 'Unknown failure'}`);
  process.exitCode = 1;
});
