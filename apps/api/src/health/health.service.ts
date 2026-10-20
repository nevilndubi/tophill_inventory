import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

type LivenessStatus = {
  status: 'ok';
  timestamp: string;
};

type ReadinessStatus = {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    database: 'not_configured';
    redis: 'up' | 'down';
  };
};

@Injectable()
export class HealthService {
  constructor(private readonly redis: RedisService) {}

  getLiveness(): LivenessStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadinessStatus> {
    const redisIsReady = await this.redis.ping();

    return {
      ...this.getLiveness(),
      checks: {
        database: 'not_configured',
        redis: redisIsReady ? 'up' : 'down',
      },
      status: redisIsReady ? 'ok' : 'degraded',
    };
  }
}
