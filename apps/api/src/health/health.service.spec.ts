import { jest } from '@jest/globals';
import { HealthService } from './health.service';
import type { RedisService } from '../redis/redis.service';

describe('HealthService', () => {
  const redis = {
    ping: jest.fn(),
  } as unknown as RedisService;
  const service = new HealthService(redis);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an ok liveness result with an ISO timestamp', () => {
    const result = service.getLiveness();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('reports ready when Redis responds', async () => {
    jest.mocked(redis.ping).mockResolvedValue(true);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: {
        database: 'not_configured',
        redis: 'up',
      },
      status: 'ok',
    });
  });

  it('degrades readiness when Redis is unavailable', async () => {
    jest.mocked(redis.ping).mockResolvedValue(false);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: {
        database: 'not_configured',
        redis: 'down',
      },
      status: 'degraded',
    });
  });
});
