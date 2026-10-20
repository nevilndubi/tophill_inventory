import { Module } from '@nestjs/common';
import { redisClientProvider } from './redis-client.provider';
import { RedisService } from './redis.service';

@Module({
  exports: [RedisService],
  providers: [redisClientProvider, RedisService],
})
export class RedisModule {}
