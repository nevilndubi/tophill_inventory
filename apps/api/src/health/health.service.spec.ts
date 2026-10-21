import { jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthService } from './health.service';
import type { RedisService } from '../redis/redis.service';

describe('HealthService', () => {
  const database = {
    ping: jest.fn(),
  } as unknown as PrismaService;
  const redis = {
    ping: jest.fn(),
  } as unknown as RedisService;
  const service = new HealthService(database, redis);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an ok liveness result with an ISO timestamp', () => {
    const result = service.getLiveness();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('reports ready when the database and Redis respond', async () => {
    jest.mocked(database.ping).mockResolvedValue(true);
    jest.mocked(redis.ping).mockResolvedValue(true);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: {
        database: 'up',
        redis: 'up',
      },
      status: 'ok',
    });
  });

  it('degrades readiness when Redis is unavailable', async () => {
    jest.mocked(database.ping).mockResolvedValue(true);
    jest.mocked(redis.ping).mockResolvedValue(false);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: {
        database: 'up',
        redis: 'down',
      },
      status: 'degraded',
    });
  });

  it('marks readiness down when the database is unavailable', async () => {
    jest.mocked(database.ping).mockResolvedValue(false);
    jest.mocked(redis.ping).mockResolvedValue(true);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: {
        database: 'down',
        redis: 'up',
      },
      status: 'down',
    });
  });
});
