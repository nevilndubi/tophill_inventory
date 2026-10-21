import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ApiEnvironment } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { DATABASE_HEALTH_TIMEOUT_MS } from './prisma.constants';

type DatabaseError = Error & { code?: string };

const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Database operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<ApiEnvironment, true>) {
    const adapter = new PrismaPg({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      connectionTimeoutMillis: DATABASE_HEALTH_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      max: 10,
    });

    super({ adapter });
  }

  onModuleInit(): void {
    // A database outage must be visible through readiness without blocking API boot.
    void this.$connect()
      .then(() => this.logger.log('Database connection established'))
      .catch((error: DatabaseError) =>
        this.logger.error(
          { code: error.code ?? 'UNKNOWN', name: error.name },
          'Database connection failed; readiness is down',
        ),
      );
  }

  async ping(timeoutMs = DATABASE_HEALTH_TIMEOUT_MS): Promise<boolean> {
    try {
      await withTimeout(this.$queryRawUnsafe('SELECT 1'), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await withTimeout(this.$disconnect(), DATABASE_HEALTH_TIMEOUT_MS);
      this.logger.log('Database connection closed gracefully');
    } catch {
      this.logger.warn('Database graceful close timed out');
    }
  }
}
