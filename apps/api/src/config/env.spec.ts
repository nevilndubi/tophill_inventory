import { parseApiEnvironment } from './env';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/tophill_test',
  DIRECT_URL: 'postgresql://test:test@127.0.0.1:5432/tophill_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test_server_only',
  SUPABASE_URL: 'https://example.supabase.co',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
};

describe('API environment', () => {
  it('uses the local Redis default outside production', () => {
    expect(parseApiEnvironment(baseEnvironment).REDIS_URL).toBe('redis://127.0.0.1:6379');
  });

  it('defaults the bounded database readiness timeout and validates overrides', () => {
    expect(parseApiEnvironment(baseEnvironment).READINESS_DB_TIMEOUT_MS).toBe(3000);
    expect(
      parseApiEnvironment({ ...baseEnvironment, READINESS_DB_TIMEOUT_MS: '7500' })
        .READINESS_DB_TIMEOUT_MS,
    ).toBe(7500);
    expect(() =>
      parseApiEnvironment({ ...baseEnvironment, READINESS_DB_TIMEOUT_MS: '10001' }),
    ).toThrow('READINESS_DB_TIMEOUT_MS: Too big');
  });

  it('requires an explicit TLS Redis URL in production', () => {
    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
      }),
    ).toThrow('REDIS_URL: must be explicitly configured with a rediss:// URL in production');

    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        REDIS_URL: 'redis://redis.example.test:6379',
      }),
    ).toThrow('REDIS_URL: must be explicitly configured with a rediss:// URL in production');
  });

  it('accepts a TLS Redis URL in production', () => {
    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        REDIS_URL: 'rediss://redis.example.test:6380',
      }).REDIS_URL,
    ).toBe('rediss://redis.example.test:6380');
  });

  it('reports both missing database URLs together', () => {
    expect(() =>
      parseApiEnvironment({
        WEB_ORIGIN: baseEnvironment.WEB_ORIGIN,
      }),
    ).toThrow(/DATABASE_URL: is required[\s\S]*DIRECT_URL: is required/);
  });

  it('rejects non-Postgres database URLs', () => {
    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        DATABASE_URL: 'https://database.example.test',
        DIRECT_URL: 'redis://127.0.0.1:6379',
      }),
    ).toThrow(/DATABASE_URL: must use the postgres:\/\/ or postgresql:\/\/ protocol/);
  });

  it('derives the issuer and JWKS URL from the project URL', () => {
    const environment = parseApiEnvironment({
      ...baseEnvironment,
      SUPABASE_URL: 'https://example.supabase.co/',
    });

    expect(environment.SUPABASE_URL).toBe('https://example.supabase.co');
    expect(environment.SUPABASE_JWT_ISSUER).toBe('https://example.supabase.co/auth/v1');
    expect(environment.SUPABASE_JWKS_URL).toBe(
      'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    );
  });

  it('rejects legacy server keys and inconsistent JWT endpoints', () => {
    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        SUPABASE_SECRET_KEY: 'legacy-service-role-key',
      }),
    ).toThrow('SUPABASE_SECRET_KEY: must be a modern sb_secret_ key');

    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        SUPABASE_JWT_ISSUER: 'https://other.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://other.supabase.co/auth/v1/.well-known/jwks.json',
      }),
    ).toThrow(/SUPABASE_JWT_ISSUER: must match SUPABASE_URL\/auth\/v1/);
  });

  it('normalizes the optional bootstrap email and rejects reserved seed addresses', () => {
    expect(
      parseApiEnvironment({
        ...baseEnvironment,
        BOOTSTRAP_SUPER_ADMIN_EMAIL: 'First.Admin@Hospital.Test',
      }).BOOTSTRAP_SUPER_ADMIN_EMAIL,
    ).toBe('first.admin@hospital.test');

    expect(() =>
      parseApiEnvironment({
        ...baseEnvironment,
        BOOTSTRAP_SUPER_ADMIN_EMAIL: 'seed@example.invalid',
      }),
    ).toThrow('BOOTSTRAP_SUPER_ADMIN_EMAIL: must not use a reserved .invalid address');
  });
});
