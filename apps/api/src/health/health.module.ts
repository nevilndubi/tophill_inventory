import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  imports: [PrismaModule, RedisModule],
  providers: [HealthService],
})
export class HealthModule {}
