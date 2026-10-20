import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_HEALTH_TIMEOUT_MS } from './redis.constants';

type RedisError = Error & { code?: string };

const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  onModuleInit(): void {
    this.registerLifecycleLogs();

    // Connection happens in the background so Redis can never block API startup.
    void this.client.connect().catch(() => undefined);
  }

  async ping(timeoutMs = REDIS_HEALTH_TIMEOUT_MS): Promise<boolean> {
    try {
      return (await withTimeout(this.client.ping(), timeoutMs)) === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') {
      try {
        await withTimeout(this.client.quit(), REDIS_HEALTH_TIMEOUT_MS);
        this.logger.log('Redis connection closed gracefully');
        return;
      } catch {
        this.logger.warn('Redis graceful close timed out; disconnecting immediately');
      }
    }

    this.client.disconnect();
  }

  private registerLifecycleLogs(): void {
    this.client.on('connect', () => this.logger.log('Redis connection established'));
    this.client.on('ready', () => this.logger.log('Redis connection ready'));
    this.client.on('reconnecting', (delay: number) =>
      this.logger.warn({ delayMs: delay }, 'Redis reconnect scheduled'),
    );
    this.client.on('error', (error: RedisError) =>
      this.logger.error(
        { code: error.code ?? 'UNKNOWN', name: error.name },
        'Redis connection error; API remains available',
      ),
    );
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
  }
}
