import { parseApiEnvironment } from './env';

const baseEnvironment = {
  WEB_ORIGIN: 'http://127.0.0.1:3000',
};

describe('API environment', () => {
  it('uses the local Redis default outside production', () => {
    expect(parseApiEnvironment(baseEnvironment).REDIS_URL).toBe('redis://127.0.0.1:6379');
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
});
