import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap/configure-application';
import { createZodDto } from '../src/common/validation/zod-dto';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

class ValidationFixtureDto extends createZodDto(z.object({ name: z.string().min(1) }).strict()) {}

@Controller('validation-fixture')
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ValidationFixtureController],
      imports: [AppModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue(unavailableRedis)
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
          database: 'not_configured',
          redis: 'down',
        },
        status: 'degraded',
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(unavailableRedis.ping).toHaveBeenCalled();
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
      .compile();
    const connectedApp = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(connectedApp);

    await connectedApp.init();

    try {
      const response = await request(connectedApp.getHttpServer()).get('/health/ready').expect(200);

      expect(response.body).toMatchObject({
        data: {
          checks: {
            database: 'not_configured',
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

  it('does not expose health below the versioned API prefix', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(404);

    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND',
      requestId: expect.any(String),
    });
  });

  it('returns every validation error in the standard error shape', async () => {
    const requestId = 'validation-e2e-request';
    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-fixture')
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
  });
});
