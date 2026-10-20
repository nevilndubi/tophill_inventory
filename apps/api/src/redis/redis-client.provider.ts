import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { ApiEnvironment } from '../config/env';
import {
  REDIS_CLIENT,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_HEALTH_TIMEOUT_MS,
  REDIS_MAX_RETRY_DELAY_MS,
} from './redis.constants';

const retryDelay = (attempt: number): number =>
  Math.min(100 * 2 ** Math.min(Math.max(attempt - 1, 0), 10), REDIS_MAX_RETRY_DELAY_MS);

export const redisClientProvider: Provider<Redis> = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiEnvironment, true>) => {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    const usesTls = new URL(redisUrl).protocol === 'rediss:';

    return new Redis(redisUrl, {
      commandTimeout: REDIS_HEALTH_TIMEOUT_MS,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: retryDelay,
      tls: usesTls ? {} : undefined,
    });
  },
};
