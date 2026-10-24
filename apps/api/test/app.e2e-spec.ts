import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { AuthenticatedOnly } from '../src/authorization/authenticated-only.decorator';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { createZodDto } from '../src/common/validation/zod-dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

class ValidationFixtureDto extends createZodDto(z.object({ name: z.string().min(1) }).strict()) {}

const AUTHORIZATION =
  'Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEifQ.c2lnbmF0dXJl';
const authenticatedUser = {
  department: null,
  email: 'staff@hospital.test',
  fullName: 'Hospital Staff',
  id: '22222222-2222-4222-8222-222222222222',
  isActive: true,
  role: 'STAFF' as const,
};

@Controller('validation-fixture')
@AuthenticatedOnly()
class ValidationFixtureController {
  @Post()
  validate(@Body() body: ValidationFixtureDto): ValidationFixtureDto {
    return body;
  }
}

describe('API bootstrap (e2e)', () => {
  let app: INestApplication;
  const unavailableRedis = {
    ping: jest.fn(async () => false),
  };
  const availableDatabase = {
    ping: jest.fn(async () => true),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ValidationFixtureController],
      imports: [AppModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue(unavailableRedis)
      .overrideProvider(PrismaService)
      .useValue(availableDatabase)
      .overrideProvider(JwtVerifierService)
      .useValue({ verify: jest.fn(async () => ({ subject: 'auth-subject' })) })
      .overrideProvider(UserSessionService)
      .useValue({ resolve: jest.fn(async () => authenticatedUser) })
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness at the root with an envelope and request ID', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toMatchObject({
      data: {
        status: 'ok',
        timestamp: expect.any(String),
      },
    });
  });

  it('serves degraded readiness promptly when Redis is unavailable', async () => {
    const startedAt = Date.now();
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toMatchObject({
      data: {
        checks: {
          database: 'up',
          redis: 'down',
        },
        status: 'degraded',
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(unavailableRedis.ping).toHaveBeenCalled();
    expect(availableDatabase.ping).toHaveBeenCalled();
  });

  it('serves ready status with an in-memory connected Redis stand-in', async () => {
    const connectedRedis = {
      ping: jest.fn(async () => true),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue(connectedRedis)
      .overrideProvider(PrismaService)
      .useValue(availableDatabase)
      .overrideProvider(JwtVerifierService)
      .useValue({ verify: jest.fn(async () => ({ subject: 'auth-subject' })) })
      .overrideProvider(UserSessionService)
      .useValue({ resolve: jest.fn(async () => authenticatedUser) })
      .compile();
    const connectedApp = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(connectedApp);

    await connectedApp.init();

    try {
      const response = await request(connectedApp.getHttpServer()).get('/health/ready').expect(200);

      expect(response.body).toMatchObject({
        data: {
          checks: {
            database: 'up',
            redis: 'up',
          },
          status: 'ok',
        },
      });
      expect(connectedRedis.ping).toHaveBeenCalledTimes(1);
    } finally {
      await connectedApp.close();
    }
  });

  it('returns 503 promptly when the database is unavailable', async () => {
    const unavailableDatabase = {
      ping: jest.fn(async () => false),
    };
    const connectedRedis = {
      ping: jest.fn(async () => true),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue(connectedRedis)
      .overrideProvider(PrismaService)
      .useValue(unavailableDatabase)
      .overrideProvider(JwtVerifierService)
      .useValue({ verify: jest.fn(async () => ({ subject: 'auth-subject' })) })
      .overrideProvider(UserSessionService)
      .useValue({ resolve: jest.fn(async () => authenticatedUser) })
      .compile();
    const databaseDownApp = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(databaseDownApp);

    await databaseDownApp.init();

    try {
      const startedAt = Date.now();
      const response = await request(databaseDownApp.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(response.body).toMatchObject({
        data: {
          checks: {
            database: 'down',
            redis: 'up',
          },
          status: 'down',
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(unavailableDatabase.ping).toHaveBeenCalledTimes(1);
    } finally {
      await databaseDownApp.close();
    }
  });

  it('does not expose health below the versioned API prefix', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Authorization', AUTHORIZATION)
      .expect(404);

    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND',
      requestId: expect.any(String),
    });
  });

  it('returns every validation error in the standard error shape', async () => {
    const requestId = 'validation-e2e-request';
    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-fixture')
      .set('Authorization', AUTHORIZATION)
      .set('x-request-id', requestId)
      .send({ unexpected: true })
      .expect(400);

    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: 'name' }),
            expect.objectContaining({ path: '' }),
          ]),
        },
        message: 'Validation failed',
        requestId,
      },
    });
  });

  it('wraps successful versioned responses', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-fixture')
      .set('Authorization', AUTHORIZATION)
      .send({ name: 'Infusion Pump' })
      .expect(201);

    expect(response.body).toEqual({ data: { name: 'Infusion Pump' } });
  });

  it('renders Swagger at /api/docs', async () => {
    const htmlResponse = await request(app.getHttpServer()).get('/api/docs').expect(200);
    const jsonResponse = await request(app.getHttpServer()).get('/api/docs-json').expect(200);

    expect(htmlResponse.text).toContain('Swagger UI');
    expect(jsonResponse.body.info.title).toBe('Tophill Inventory API');
    expect(jsonResponse.body.paths).toHaveProperty('/health');
    expect(jsonResponse.body.components.securitySchemes.supabase).toMatchObject({
      bearerFormat: 'JWT',
      scheme: 'bearer',
      type: 'http',
    });
  });

  it('does not mount Swagger in production', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ NODE_ENV: 'production', WEB_ORIGIN: 'http://127.0.0.1:3000' })[key],
          },
        },
      ],
    }).compile();
    const productionApp = moduleRef.createNestApplication();
    configureApplication(productionApp);
    await productionApp.init();

    try {
      await request(productionApp.getHttpServer()).get('/api/docs').expect(404);
      await request(productionApp.getHttpServer()).get('/api/docs-json').expect(404);
    } finally {
      await productionApp.close();
    }
  });
});
