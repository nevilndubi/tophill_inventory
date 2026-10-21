import { spawnSync } from 'node:child_process';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
} from './neon-safe-cli';

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const hostname = (url: string): string => new URL(url).hostname;

const run = (args: string[], environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync('pnpm', args, {
    env: environment,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} exited ${result.status ?? 1}`);
};

const main = (): void => {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 12);
  const branchName = `ci/task-1.7-seed-${timestamp}`;
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const protectedMain = getNeonConnectionStringCaptured(projectId, 'main', true);
  const protectedStaging = getNeonConnectionStringCaptured(projectId, 'staging', true);
  const devPooled = getNeonConnectionStringCaptured(projectId, 'dev', true);
  const devDirect = getNeonConnectionStringCaptured(projectId, 'dev', false);
  const protectedHosts = [hostname(protectedMain), hostname(protectedStaging)].join(',');
  const branch = createNeonBranchSafely(projectId, 'main', branchName, expiresAt);
  console.log(
    `Created disposable Neon branch ${branch.name} (${branch.id}); credentials remained captured.`,
  );

  try {
    const disposablePooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const disposableDirect = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const disposableEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: disposablePooled,
      DIRECT_URL: disposableDirect,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: disposablePooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(disposablePooled),
      SEED_PROTECTED_HOSTS: protectedHosts,
    };

    run(['prisma:migrate:deploy'], disposableEnvironment);
    run(['db:seed'], disposableEnvironment);
    run(['db:seed'], disposableEnvironment);
    run(['db:index-review'], disposableEnvironment);
    run(['test:integration'], {
      ...disposableEnvironment,
      DATABASE_URL: devPooled,
      DIRECT_URL: devDirect,
    });
    run(
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
      disposableEnvironment,
    );

    const devEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: devPooled,
      DIRECT_URL: devDirect,
      SEED_ALLOWED_BRANCH: 'dev',
      SEED_ALLOWED_HOST: hostname(devPooled),
      SEED_PROTECTED_HOSTS: protectedHosts,
    };
    run(['prisma:migrate:deploy'], devEnvironment);
    run(['db:seed'], devEnvironment);
    run(['db:seed:verify'], devEnvironment);
    run(['exec', 'prisma', 'migrate', 'status', '--config', 'prisma7.config.ts'], devEnvironment);
    run(
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
      devEnvironment,
    );
    console.log(
      'Disposable and dev Neon verification completed without exposing connection values.',
    );
  } finally {
    deleteNeonBranchSafely(projectId, branch.id);
    console.log(`Deleted disposable Neon branch ${branch.name} (${branch.id}).`);
  }
};

main();
