import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_NAME } from '@app/shared';
import { AppModule } from './app.module';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  await app.listen(env.PORT);
  Logger.log(`${APP_NAME} API listening on port ${env.PORT}`, 'Bootstrap');
}

void bootstrap();
