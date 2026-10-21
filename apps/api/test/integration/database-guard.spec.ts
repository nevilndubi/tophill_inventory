import { describe, expect, it } from '@jest/globals';
import { assertSafeIntegrationDatabaseEnvironment } from './database-guard';

const ephemeralUrl =
  'postgresql://test:test@ep-integration-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

describe('database integration safety guard', () => {
  it('accepts a dedicated ephemeral Neon branch', () => {
    expect(
      assertSafeIntegrationDatabaseEnvironment({
        INTEGRATION_DATABASE_BRANCH: 'ci/task-1.2-example',
        INTEGRATION_DATABASE_URL: ephemeralUrl,
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/app',
        DIRECT_URL: 'postgresql://test:test@127.0.0.1:5432/app',
      }),
    ).toEqual({ branch: 'ci/task-1.2-example', url: ephemeralUrl });
  });

  it.each(['main', 'staging', 'dev', 'feature/not-dedicated'])(
    'rejects protected or non-ephemeral branch %s',
    (branch) => {
      expect(() =>
        assertSafeIntegrationDatabaseEnvironment({
          INTEGRATION_DATABASE_BRANCH: branch,
          INTEGRATION_DATABASE_URL: ephemeralUrl,
        }),
      ).toThrow('must name a dedicated');
    },
  );

  it.each(['DATABASE_URL', 'DIRECT_URL'] as const)('rejects a URL equal to %s', (variable) => {
    expect(() =>
      assertSafeIntegrationDatabaseEnvironment({
        INTEGRATION_DATABASE_BRANCH: 'test/task-1.2-example',
        INTEGRATION_DATABASE_URL: ephemeralUrl,
        [variable]: ephemeralUrl,
      }),
    ).toThrow('must not equal');
  });

  it('rejects non-Neon targets', () => {
    expect(() =>
      assertSafeIntegrationDatabaseEnvironment({
        INTEGRATION_DATABASE_BRANCH: 'ephemeral/task-1.2-example',
        INTEGRATION_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
      }),
    ).toThrow('must be a PostgreSQL URL for a Neon branch');
  });
});
