import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  imports: [RedisModule],
  providers: [HealthService],
})
export class HealthModule {}
