import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_NAME } from '@app/shared';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3001;

  await app.listen(port);
  Logger.log(`${APP_NAME} API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
