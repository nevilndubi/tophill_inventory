import type { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { ApiEnvironment } from '../config/env';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const createService = (): PrismaService => {
    const config = {
      get: jest.fn((key: keyof ApiEnvironment) =>
        key === 'READINESS_DB_TIMEOUT_MS'
          ? 3000
          : 'postgresql://test:test@127.0.0.1:5432/tophill_test',
      ),
    } as unknown as ConfigService<ApiEnvironment, true>;

    return new PrismaService(config);
  };

  it('connects in the background during module initialization', async () => {
    const service = createService();
    const connect = jest.spyOn(service, '$connect').mockResolvedValue();

    service.onModuleInit();
    await Promise.resolve();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reports a successful bounded database ping', async () => {
    const service = createService();
    jest.spyOn(service, '$queryRawUnsafe').mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ping()).resolves.toBe(true);
  });

  it('returns false when a database ping exceeds its timeout', async () => {
    const service = createService();
    jest.spyOn(service, '$queryRawUnsafe').mockReturnValue(new Promise(() => undefined) as never);

    await expect(service.ping(10)).resolves.toBe(false);
  });

  it('uses the validated readiness timeout when no override is supplied', async () => {
    jest.useFakeTimers();
    const service = createService();
    jest.spyOn(service, '$queryRawUnsafe').mockReturnValue(new Promise(() => undefined) as never);

    const result = service.ping();
    await jest.advanceTimersByTimeAsync(2999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    jest.useRealTimers();
  });

  it('disconnects during application shutdown', async () => {
    const service = createService();
    const disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue();

    await service.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
