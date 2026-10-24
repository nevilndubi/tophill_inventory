import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { APP_NAME } from '@app/shared';

export const configureSwagger = (app: INestApplication): void => {
  const config = new DocumentBuilder()
    .setTitle(`${APP_NAME} API`)
    .setDescription('Hospital equipment tracking and booking API')
    .setVersion('1.0')
    .addBearerAuth(
      {
        bearerFormat: 'JWT',
        description: 'Supabase ES256 access token',
        scheme: 'bearer',
        type: 'http',
      },
      'supabase',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    ignoreGlobalPrefix: false,
  });

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
};
