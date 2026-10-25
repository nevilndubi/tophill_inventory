import { RequestMethod, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
import type { ApiEnvironment } from '../config/env';
import { configureSwagger } from '../swagger/configure-swagger';

export const configureApplication = (app: INestApplication): void => {
  const config = app.get<ConfigService<ApiEnvironment, true>>(ConfigService);
  const webOrigin = config.get('WEB_ORIGIN', { infer: true });

  app.use(json({ limit: '16kb' }));
  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, requestOrigin === undefined || requestOrigin === webOrigin);
    },
  });
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    configureSwagger(app);
  }
};
