import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { config as loadEnvironment } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { chromium, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

type JsonRecord = Record<string, unknown>;
type ApiResult = { body: JsonRecord; status: number };
type ManagedProcess = ChildProcess & { exitCode: number | null };

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

loadEnvironment({ path: 'apps/api/.env.task-2.1.local', quiet: true });

const requireEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required proof configuration: ${name}`);
  return value;
};

const runCaptured = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return result.stdout.trim();
};

const runQuietly = (command: string, args: string[], environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync(command, args, {
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed`);
};

const findProject = (): { ref: string } => {
  const output = JSON.parse(
    runCaptured('supabase', [
      'projects',
      'list',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ]),
  ) as JsonRecord;
  const projects = Array.isArray(output.projects) ? output.projects : [];
  const project = projects.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as JsonRecord).name === 'tophill-inventory',
  ) as JsonRecord | undefined;
  if (typeof project?.ref !== 'string') throw new Error('Supabase project not found');
  return { ref: project.ref };
};

const getSupabaseKeys = (projectRef: string): { publishable: string; secret: string } => {
  const output = JSON.parse(
    runCaptured('supabase', [
      'projects',
      'api-keys',
      '--project-ref',
      projectRef,
      '--reveal',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ]),
  ) as unknown;
  const response = typeof output === 'object' && output !== null ? (output as JsonRecord) : {};
  const keys = Array.isArray(output)
    ? output
    : Array.isArray(response.keys)
      ? response.keys
      : Array.isArray(response.api_keys)
        ? response.api_keys
        : [];
  const valueFor = (type: string): string | undefined => {
    const record = keys.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as JsonRecord).type === type,
    ) as JsonRecord | undefined;
    return typeof record?.api_key === 'string' ? record.api_key : undefined;
  };
  const publishable = valueFor('publishable');
  const secret = valueFor('secret');
  if (!publishable || !secret) throw new Error('Current Supabase API keys were not found');
  return { publishable, secret };
};

const startProcess = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): ManagedProcess =>
  spawn(command, args, {
    cwd,
    env: environment,
    stdio: 'ignore',
  }) as ManagedProcess;

const stopProcess = async (process: ManagedProcess | undefined): Promise<void> => {
  if (!process || process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
};

const waitForHttp = async (url: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Local application did not become ready');
};

const apiRequest = async (
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<ApiResult> => {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`http://127.0.0.1:3001/api/v1${path}`, { ...init, headers });
  const parsed: unknown = await response.json();
  return {
    body: typeof parsed === 'object' && parsed !== null ? (parsed as JsonRecord) : {},
    status: response.status,
  };
};

const dataFrom = (result: ApiResult): JsonRecord => {
  if (result.status < 200 || result.status >= 300) throw new Error('API request failed');
  if (typeof result.body.data !== 'object' || result.body.data === null) {
    throw new Error('API response had no data');
  }
  return result.body.data as JsonRecord;
};

const errorCodeFrom = (result: ApiResult): string | undefined => {
  const error = result.body.error;
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as JsonRecord).code === 'string'
    ? ((error as JsonRecord).code as string)
    : undefined;
};

const maskIdentityText = async (page: Page): Promise<void> => {
  await page.locator('body').evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent) {
        node.textContent = node.textContent.replace(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
          '[identity masked]',
        );
      }
      node = walker.nextNode();
    }
  });
};

const countIdentityOnProtectedBranch = async (
  branchName: 'dev' | 'main' | 'staging',
  identityId: string,
): Promise<number> => {
  const connection = getNeonConnectionStringCaptured(projectId, branchName, true);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connection }) });
  try {
    const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('public.users')::text AS name
    `;
    if (table[0]?.name === null || table.length === 0) return 0;
    return await prisma.user.count({ where: { supabaseUserId: identityId } });
  } finally {
    await prisma.$disconnect();
  }
};

const main = async (): Promise<void> => {
  let stage = 'initialization';
  let branch: NeonBranch | undefined;
  let proofIdentityId: string | undefined;
  let adminSupabase: SupabaseClient | undefined;
  let apiProcess: ManagedProcess | undefined;
  let webProcess: ManagedProcess | undefined;
  let prisma: PrismaClient | undefined;
  let identityDeleted = false;
  let branchDeleted = false;

  try {
    stage = 'capturing provider configuration';
    const { ref } = findProject();
    const { publishable, secret } = getSupabaseKeys(ref);
    const supabaseUrl = `https://${ref}.supabase.co`;
    const testEmail = requireEnvironment('SUPABASE_AUTH_TEST_EMAIL');
    const testPassword = requireEnvironment('SUPABASE_AUTH_TEST_PASSWORD');
    const bootstrapEmail = requireEnvironment('BOOTSTRAP_SUPER_ADMIN_EMAIL');
    if (testEmail.toLowerCase() !== bootstrapEmail.toLowerCase()) {
      throw new Error('The live proof identity does not match the configured bootstrap identity');
    }

    stage = 'creating disposable database branch';
    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/g, '')
      .slice(0, 12);
    const branchName = `ci/task-2.5-users-${suffix}`;
    branch = createNeonBranchSafely(
      projectId,
      'main',
      branchName,
      new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
    );
    const databaseUrl = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const directUrl = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const apiEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      BOOTSTRAP_SUPER_ADMIN_EMAIL: bootstrapEmail,
      DATABASE_URL: databaseUrl,
      DIRECT_URL: directUrl,
      NODE_ENV: 'development',
      PORT: '3001',
      REDIS_URL: 'redis://127.0.0.1:63999',
      SUPABASE_SECRET_KEY: secret,
      SUPABASE_URL: supabaseUrl,
      WEB_ORIGIN: 'http://localhost:3000',
    };
    const webEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      API_BASE_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    };

    stage = 'applying migrations and building applications';
    runQuietly('pnpm', ['prisma:migrate:deploy'], apiEnvironment);
    runQuietly('pnpm', ['--filter', '@app/shared', 'build'], apiEnvironment);
    runQuietly('pnpm', ['--filter', '@app/api', 'build'], apiEnvironment);
    runQuietly('pnpm', ['--filter', '@app/web', 'build'], webEnvironment);

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    adminSupabase = createClient(supabaseUrl, secret, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const browserSupabase = createClient(supabaseUrl, publishable, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });

    stage = 'starting local applications';
    apiProcess = startProcess('node', ['apps/api/dist/main.js'], apiEnvironment);
    webProcess = startProcess(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', '3000'],
      webEnvironment,
      'apps/web',
    );
    await Promise.all([
      waitForHttp('http://127.0.0.1:3001/health/ready'),
      waitForHttp('http://127.0.0.1:3000/login'),
    ]);

    stage = 'proving first-administrator bootstrap';
    const actorSignIn = await browserSupabase.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    const actorToken = actorSignIn.data.session?.access_token;
    if (actorSignIn.error || !actorToken) throw new Error('Proof identity sign-in failed');

    const firstMe = await apiRequest('/me', actorToken);
    if (firstMe.status < 200 || firstMe.status >= 300) {
      stage = `first-administrator bootstrap (HTTP ${firstMe.status}, ${errorCodeFrom(firstMe) ?? 'unknown'})`;
    }
    const firstUser = dataFrom(firstMe);
    if (firstUser.role !== 'SUPER_ADMIN' || typeof firstUser.id !== 'string') {
      throw new Error('Bootstrap did not create the expected role');
    }
    const actorUserId = firstUser.id;
    const firstAdminCount = await prisma.user.count({
      where: { isSeedData: false, role: 'SUPER_ADMIN' },
    });
    const repeatMe = await apiRequest('/me', actorToken);
    const repeatUser = dataFrom(repeatMe);
    const repeatAdminCount = await prisma.user.count({
      where: { isSeedData: false, role: 'SUPER_ADMIN' },
    });
    if (repeatUser.id !== actorUserId || firstAdminCount !== 1 || repeatAdminCount !== 1) {
      throw new Error('Bootstrap idempotency proof failed');
    }

    stage = 'creating non-delivered invitation proof';
    const separator = testEmail.lastIndexOf('@');
    if (separator <= 0) throw new Error('Proof identity address is invalid');
    const proofEmail = `${testEmail.slice(0, separator)}+task25-${suffix}${testEmail.slice(separator)}`;
    const generated = await adminSupabase.auth.admin.generateLink({
      email: proofEmail,
      options: {
        data: { full_name: 'Task 2.5 Proof User' },
        redirectTo: 'http://localhost:3000/auth/confirm',
      },
      type: 'invite',
    });
    const tokenHash = generated.data.properties?.hashed_token;
    proofIdentityId = generated.data.user?.id;
    if (generated.error || !proofIdentityId || !tokenHash) {
      throw new Error('Non-delivered invitation generation failed');
    }

    const department = await prisma.department.upsert({
      create: { code: 'T25', name: 'Task 2.5 Proof Department' },
      update: {},
      where: { code: 'T25' },
    });
    const proofUser = await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          email: proofEmail.toLowerCase(),
          fullName: 'Task 2.5 Proof User',
          isActive: true,
          isSeedData: false,
          role: 'ADMIN',
          supabaseUserId: proofIdentityId,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: 'user.invited',
          actorUserId,
          after: { departmentId: null, isActive: true, role: 'ADMIN' },
          entityId: user.id,
          entityType: 'user',
          requestId: 'task-2.5-live-proof',
        },
      });
      return user;
    });
    const linkedIdentityCount = await prisma.user.count({
      where: { isSeedData: false, supabaseUserId: proofIdentityId },
    });
    if (linkedIdentityCount !== 1) throw new Error('Invitation mapping was not unique');

    stage = 'launching invitation browser';
    const proofPassword = `Proof-${randomBytes(18).toString('base64url')}!9`;
    const browser = await chromium.launch({ headless: true });
    let acceptedPath = '';
    let forbiddenPath = '';
    let page: Page | undefined;
    try {
      page = await browser.newPage({ viewport: { height: 900, width: 1280 } });
      const confirmUrl = new URL('http://localhost:3000/auth/confirm');
      confirmUrl.searchParams.set('token_hash', tokenHash);
      confirmUrl.searchParams.set('type', 'invite');
      confirmUrl.searchParams.set('returnTo', '/admin');
      stage = 'opening invitation confirmation';
      await page.goto(confirmUrl.toString());
      stage = `loading set-password form at ${new URL(page.url()).pathname}`;
      await page.getByLabel('Password', { exact: true }).fill(proofPassword);
      await page.getByLabel('Confirm password').fill(proofPassword);
      stage = 'submitting invitation password';
      await page.getByRole('button', { name: 'Set password and continue' }).click();
      stage = `waiting for invited app session from ${new URL(page.url()).pathname}`;
      await page.waitForURL((url) => ['/admin', '/temporarily-unavailable'].includes(url.pathname));
      let adminLoaded = false;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const currentPath = new URL(page.url()).pathname;
        stage = `loading invited admin UI at ${currentPath}, attempt ${attempt}`;
        if (currentPath === '/temporarily-unavailable') {
          await page.getByRole('button', { name: 'Retry' }).click();
          await page.waitForTimeout(1_000);
          continue;
        }
        try {
          await page.getByRole('heading', { name: 'Users and access' }).waitFor({ timeout: 5_000 });
          adminLoaded = true;
          break;
        } catch {
          await page.waitForTimeout(1_000);
        }
      }
      if (!adminLoaded) throw new Error('Invited admin UI remained unavailable');
      acceptedPath = new URL(page.url()).pathname;

      mkdirSync('apps/web/.artifacts/task-2.5', { recursive: true });
      for (const width of [360, 768, 1280]) {
        stage = `capturing loaded user management at ${width}px`;
        await page.setViewportSize({ height: 900, width });
        await page.reload();
        await page.getByRole('heading', { name: 'Users and access' }).waitFor();
        await page.getByText('Page 1 of 1 · 2 users', { exact: true }).waitFor();
        await maskIdentityText(page);
        await page.screenshot({
          fullPage: true,
          path: `apps/web/.artifacts/task-2.5/users-${width}.png`,
        });
      }

      stage = 'proving immediate authorization changes';
      const targetSignIn = await browserSupabase.auth.signInWithPassword({
        email: proofEmail,
        password: proofPassword,
      });
      const targetToken = targetSignIn.data.session?.access_token;
      if (targetSignIn.error || !targetToken) throw new Error('Invited identity sign-in failed');

      const forbiddenUpdate = await apiRequest(`/users/${actorUserId}`, targetToken, {
        body: JSON.stringify({ fullName: 'Blocked Update' }),
        method: 'PATCH',
      });
      const updated = await apiRequest(`/users/${proofUser.id}`, actorToken, {
        body: JSON.stringify({ departmentId: department.id, role: 'STAFF' }),
        method: 'PATCH',
      });
      const updatedData = dataFrom(updated);
      const nextRequest = await apiRequest('/me', targetToken);
      const nextUser = dataFrom(nextRequest);
      if (
        forbiddenUpdate.status !== 403 ||
        errorCodeFrom(forbiddenUpdate) !== 'SUPER_ADMIN_PROTECTED' ||
        updatedData.role !== 'STAFF' ||
        nextUser.role !== 'STAFF' ||
        typeof nextUser.department !== 'object' ||
        nextUser.department === null
      ) {
        throw new Error('Immediate authorization proof failed');
      }

      await page.goto('http://localhost:3000/admin');
      await page.waitForURL('**/forbidden');
      await page.getByRole('heading', { name: 'You cannot open this area' }).waitFor();
      if ((await page.getByText('Administration', { exact: true }).count()) !== 0) {
        throw new Error('Role-aware navigation still exposed administration');
      }
      forbiddenPath = new URL(page.url()).pathname;

      const auditCount = await prisma.auditLog.count({
        where: {
          actorUserId,
          entityId: proofUser.id,
          action: { in: ['user.invited', 'user.role_changed', 'user.department_changed'] },
        },
      });
      if (auditCount !== 3) throw new Error('Expected audit records were not committed');

      const safeEvidence = {
        bootstrap: {
          firstCallStatus: firstMe.status,
          repeatCallStatus: repeatMe.status,
          role: firstUser.role,
          sameUserId: repeatUser.id === actorUserId,
          superAdminRowsAfterFirstCall: firstAdminCount,
          superAdminRowsAfterRepeatCall: repeatAdminCount,
          userId: actorUserId,
        },
        invitation: {
          acceptedPath,
          identityId: proofIdentityId,
          linkedNonSeedRows: linkedIdentityCount,
          localUserId: proofUser.id,
          passwordSet: true,
          sentEmail: false,
        },
        authorization: {
          auditRows: auditCount,
          forbiddenAdminOperationCode: errorCodeFrom(forbiddenUpdate),
          forbiddenAdminOperationStatus: forbiddenUpdate.status,
          forbiddenPath,
          nextRequestDepartmentId: department.id,
          nextRequestRole: nextUser.role,
        },
        responsive: {
          screenshots: [360, 768, 1280].map(
            (width) => `apps/web/.artifacts/task-2.5/users-${width}.png`,
          ),
        },
      };

      stage = 'signing out proof session';
      await browserSupabase.auth.signOut();
      stage = 'deleting temporary Supabase identity';
      const identityCleanup = await adminSupabase.auth.admin.deleteUser(proofIdentityId);
      if (identityCleanup.error) throw new Error('Proof identity cleanup failed');
      identityDeleted = true;
      stage = 'stopping local applications';
      await stopProcess(webProcess);
      webProcess = undefined;
      await stopProcess(apiProcess);
      apiProcess = undefined;
      await prisma.$disconnect();
      prisma = undefined;

      stage = 'checking protected Neon dev branch';
      const devRows = await countIdentityOnProtectedBranch('dev', proofIdentityId);
      stage = 'checking protected Neon main branch';
      const mainRows = await countIdentityOnProtectedBranch('main', proofIdentityId);
      stage = 'checking protected Neon staging branch';
      const stagingRows = await countIdentityOnProtectedBranch('staging', proofIdentityId);
      const protectedBranchRows = { dev: devRows, main: mainRows, staging: stagingRows };
      if (Object.values(protectedBranchRows).some((count) => count !== 0)) {
        throw new Error('Proof identity appeared on a protected branch');
      }
      stage = 'deleting disposable Neon branch';
      deleteNeonBranchSafely(projectId, branch.id);
      branchDeleted = true;

      console.log(
        JSON.stringify(
          {
            ...safeEvidence,
            cleanup: {
              disposableBranchDeleted: branchDeleted,
              proofIdentityDeleted: identityDeleted,
              protectedBranchRows,
            },
            disposableBranch: { id: branch.id, name: branch.name },
          },
          null,
          2,
        ),
      );
    } catch (error: unknown) {
      if (page) {
        stage = `${stage} (final path ${new URL(page.url()).pathname})`;
        mkdirSync('apps/web/.artifacts/task-2.5', { recursive: true });
        await maskIdentityText(page).catch(() => undefined);
        await page
          .screenshot({
            fullPage: true,
            path: 'apps/web/.artifacts/task-2.5/failure-masked.png',
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await browser.close();
    }
  } catch {
    process.stderr.write(
      `[user-management-live-proof] failed during ${stage}; secrets suppressed.\n`,
    );
    process.exitCode = 1;
  } finally {
    await stopProcess(webProcess);
    await stopProcess(apiProcess);
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    if (adminSupabase && proofIdentityId && !identityDeleted) {
      await adminSupabase.auth.admin.deleteUser(proofIdentityId);
    }
    if (branch && !branchDeleted) {
      try {
        deleteNeonBranchSafely(projectId, branch.id);
        branchDeleted = true;
      } catch {
        process.stderr.write(
          `[user-management-live-proof] cleanup requires attention for disposable branch ${branch.id}.\n`,
        );
      }
    }
  }
};

void main();
