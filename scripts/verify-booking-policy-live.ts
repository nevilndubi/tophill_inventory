import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const redactDatabaseUrls = (value: string): string =>
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
      `pnpm ${args[0] ?? ''} failed safely: ${redactDatabaseUrls(result.stderr || result.stdout)}`,
    );
  }
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let pool: Pool | undefined;
  try {
    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/gu, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'dev',
      `ephemeral/task-5.1-booking-policy-${suffix}`,
      new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable Neon branch ready (${branch.id}); credentials remained captured.`);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const migrationEnvironment = { ...process.env, DATABASE_URL: pooled, DIRECT_URL: direct };
    runQuietly(['prisma:migrate:deploy'], migrationEnvironment);
    console.log('Complete migration chain applied on the disposable branch.');

    const placeholder = 'postgresql://test:test@127.0.0.1:5432/test';
    runQuietly(['test:integration'], {
      ...process.env,
      DATABASE_URL: placeholder,
      DIRECT_URL: placeholder,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
    });
    console.log('Guarded database integration suite passed on the disposable branch.');

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
      migrationEnvironment,
    );
    console.log('Prisma migration diff reported no pending schema changes.');

    pool = new Pool({ connectionString: pooled, max: 2 });
    const defaults = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM app_settings
       WHERE key = ANY($1::text[])
         AND jsonb_typeof(value) = 'number'`,
      [
        [
          'booking.max_duration_minutes',
          'booking.min_duration_minutes',
          'booking.min_lead_minutes',
          'booking.max_advance_days',
          'booking.default_buffer_minutes',
          'booking.no_show_grace_minutes',
          'checkout.adhoc_guard_minutes',
        ],
      ],
    );
    if (defaults.rows[0]?.count !== '7') {
      throw new Error('Booking policy defaults were not all present as JSON numbers');
    }
    console.log('All seven booking-policy defaults are present as JSON numbers.');
  } finally {
    await pool?.end();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
  }
};

void main();
