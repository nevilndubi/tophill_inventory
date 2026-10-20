import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { ZodValidationPipe } from './common/validation/zod-validation.pipe';
import { env } from './config/env';
import { HealthModule } from './health/health.module';
import { pinoHttpOptions } from './logging/pino.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      ignoreEnvFile: true,
      isGlobal: true,
      validate: () => env,
    }),
    LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }),
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
