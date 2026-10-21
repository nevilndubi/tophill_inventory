import { describe, expect, it } from '@jest/globals';
import { assertSafeSeedEnvironment } from '../../../prisma/seed-safety';

const devUrl =
  'postgresql://seed:secret@ep-dev-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

const safeEnvironment = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: devUrl,
  SEED_ALLOWED_BRANCH: 'dev',
  SEED_ALLOWED_HOST: 'ep-dev-pooler.us-east-2.aws.neon.tech',
  SEED_PROTECTED_HOSTS:
    'ep-main-pooler.us-east-2.aws.neon.tech,ep-staging-pooler.us-east-2.aws.neon.tech',
});

describe('seed safety guard', () => {
  it('accepts an explicitly matched development target', () => {
    expect(assertSafeSeedEnvironment(safeEnvironment()).branch).toBe('dev');
  });

  it.each(['main', 'staging'])('rejects protected branch %s', (branch) => {
    expect(() =>
      assertSafeSeedEnvironment({ ...safeEnvironment(), SEED_ALLOWED_BRANCH: branch }),
    ).toThrow(/main and staging are forbidden/);
  });

  it('rejects a protected database host even when the branch label is safe', () => {
    expect(() =>
      assertSafeSeedEnvironment({
        ...safeEnvironment(),
        DATABASE_URL:
          'postgresql://seed:secret@ep-main-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
        SEED_ALLOWED_HOST: 'ep-main-pooler.us-east-2.aws.neon.tech',
      }),
    ).toThrow(/protected main or staging database host/);
  });

  it('rejects mismatched host confirmation and CI execution', () => {
    expect(() =>
      assertSafeSeedEnvironment({
        ...safeEnvironment(),
        SEED_ALLOWED_HOST: 'ep-other-pooler.us-east-2.aws.neon.tech',
      }),
    ).toThrow(/does not match/);

    expect(() => assertSafeSeedEnvironment({ ...safeEnvironment(), CI: 'true' })).toThrow(
      /disabled in CI/,
    );
  });
});
