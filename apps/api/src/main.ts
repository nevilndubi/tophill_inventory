import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { APP_NAME } from '@app/shared';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApplication } from './bootstrap/configure-application';
import type { ApiEnvironment } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApplication(app);

  const config = app.get<ConfigService<ApiEnvironment, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const logger = app.get(Logger);

  await app.listen(port);
  logger.log(`${APP_NAME} API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
