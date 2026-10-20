import { jest } from '@jest/globals';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

const createClient = (overrides: Partial<Redis> = {}): Redis =>
  ({
    connect: jest.fn(async () => undefined),
    disconnect: jest.fn(),
    on: jest.fn(),
    ping: jest.fn(async () => 'PONG'),
    quit: jest.fn(async () => 'OK' as const),
    status: 'ready',
    ...overrides,
  }) as unknown as Redis;

describe('RedisService', () => {
  it('starts connection work without blocking module initialization', () => {
    const connect = jest.fn(() => new Promise<void>(() => undefined));
    const service = new RedisService(createClient({ connect }));

    expect(service.onModuleInit()).toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reports a successful ping', async () => {
    const service = new RedisService(createClient());

    await expect(service.ping()).resolves.toBe(true);
  });

  it('bounds an unresponsive ping', async () => {
    const ping = jest.fn(() => new Promise<'PONG'>(() => undefined));
    const service = new RedisService(createClient({ ping }));
    const startedAt = Date.now();

    await expect(service.ping(20)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('reports unavailable on a real client connected to an unreachable port', async () => {
    const client = new Redis('redis://127.0.0.1:63999', {
      connectTimeout: 100,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const service = new RedisService(client);

    service.onModuleInit();

    try {
      await expect(service.ping(250)).resolves.toBe(false);
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it('gracefully quits a ready connection', async () => {
    const quit = jest.fn(async () => 'OK' as const);
    const disconnect = jest.fn();
    const service = new RedisService(createClient({ disconnect, quit }));

    await service.onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('immediately disconnects an unavailable connection', async () => {
    const disconnect = jest.fn();
    const service = new RedisService(createClient({ disconnect, status: 'reconnecting' }));

    await service.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
