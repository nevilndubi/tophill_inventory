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

  it.each(['main', 'staging'])(
    'rejects protected branch %s without explicit demo approval',
    (branch) => {
      expect(() =>
        assertSafeSeedEnvironment({ ...safeEnvironment(), SEED_ALLOWED_BRANCH: branch }),
      ).toThrow(/main is forbidden and staging requires/);
    },
  );

  it('accepts staging only with the explicit demo approval and exact host confirmation', () => {
    const stagingUrl =
      'postgresql://seed:secret@ep-staging-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

    expect(
      assertSafeSeedEnvironment({
        ...safeEnvironment(),
        DATABASE_URL: stagingUrl,
        SEED_ALLOWED_BRANCH: 'staging',
        SEED_ALLOWED_HOST: 'ep-staging-pooler.us-east-2.aws.neon.tech',
        SEED_ALLOW_STAGING_DEMO: 'true',
        SEED_STAGING_HOST: 'ep-staging-pooler.us-east-2.aws.neon.tech',
      }).branch,
    ).toBe('staging');
  });

  it('rejects staging demo approval when the staging-specific host does not match', () => {
    expect(() =>
      assertSafeSeedEnvironment({
        ...safeEnvironment(),
        DATABASE_URL:
          'postgresql://seed:secret@ep-main-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
        SEED_ALLOWED_BRANCH: 'staging',
        SEED_ALLOWED_HOST: 'ep-main-pooler.us-east-2.aws.neon.tech',
        SEED_ALLOW_STAGING_DEMO: 'true',
        SEED_STAGING_HOST: 'ep-staging-pooler.us-east-2.aws.neon.tech',
      }),
    ).toThrow(/SEED_STAGING_HOST does not match/);
  });

  it('never allows main even when the staging demo flag is present', () => {
    expect(() =>
      assertSafeSeedEnvironment({
        ...safeEnvironment(),
        SEED_ALLOWED_BRANCH: 'main',
        SEED_ALLOW_STAGING_DEMO: 'true',
      }),
    ).toThrow(/main is forbidden/);
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
