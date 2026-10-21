import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type LivenessStatus = {
  status: 'ok';
  timestamp: string;
};

type ReadinessStatus = {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
};

@Injectable()
export class HealthService {
  constructor(
    private readonly database: PrismaService,
    private readonly redis: RedisService,
  ) {}

  getLiveness(): LivenessStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadinessStatus> {
    const [databaseIsReady, redisIsReady] = await Promise.all([
      this.database.ping(),
      this.redis.ping(),
    ]);

    const status = !databaseIsReady ? 'down' : redisIsReady ? 'ok' : 'degraded';

    return {
      ...this.getLiveness(),
      checks: {
        database: databaseIsReady ? 'up' : 'down',
        redis: redisIsReady ? 'up' : 'down',
      },
      status,
    };
  }
}
