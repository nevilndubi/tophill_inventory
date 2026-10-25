import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { UserInactiveException } from '../src/auth/auth.errors';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import {
  CategoryInUseException,
  CategoryNameTakenException,
  CategoryNotFoundException,
} from '../src/categories/categories.errors';
import { CategoriesService } from '../src/categories/categories.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const categoryId = '22222222-2222-4222-8222-222222222222';
const category = {
  defaultMaxBookingMinutes: 120,
  defaultServiceIntervalDays: 180,
  description: 'Life support equipment',
  id: categoryId,
  is_deletable: true,
  machine_count: 0,
  name: 'Ventilator',
};
const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive,
  role,
});

describe('Categories API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('ADMIN');
  const categories = {
    create: jest.fn(async () => category),
    delete: jest.fn(async () => category),
    read: jest.fn(async (id?: string) => (id === undefined ? [category] : category)),
    update: jest.fn(async () => category),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(PrismaService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(JwtVerifierService)
      .useValue({ verify: jest.fn(async () => ({ subject: 'test-subject' })) })
      .overrideProvider(UserSessionService)
      .useValue({
        resolve: jest.fn(async () => {
          if (!currentUser.isActive) throw new UserInactiveException();
          return currentUser;
        }),
      })
      .overrideProvider(CategoriesService)
      .useValue(categories)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('ADMIN');
    jest.clearAllMocks();
  });

  it('requires authentication and active Neon users', async () => {
    const unauthenticated = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .expect(401);
    expect(unauthenticated.body.error.code).toBe('AUTH_INVALID');

    currentUser = user('ADMIN', false);
    const inactive = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(inactive.body.error.code).toBe('USER_INACTIVE');
  });

  it.each(['SUPER_ADMIN', 'ADMIN'] as const)(
    'allows %s to perform every mutation',
    async (role) => {
      currentUser = user(role);
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '  Intensive   Care  ', description: '' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultMaxBookingMinutes: null })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(categories.create).toHaveBeenCalledWith(
        currentUser,
        { description: null, name: 'Intensive Care' },
        expect.any(String),
      );
    },
  );

  it.each(['BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'] as const)(
    'denies %s mutations with PERMISSION_DENIED before validation',
    async (role) => {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(categories.create).not.toHaveBeenCalled();
    },
  );

  it.each(['SUPER_ADMIN', 'ADMIN', 'BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'] as const)(
    'allows active %s users to read reference data',
    async (role) => {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(response.body.data).toEqual([category]);
    },
  );

  it('rejects unknown fields, blank names, empty patches, and values outside API bounds', async () => {
    for (const body of [
      { name: ' ' },
      { name: 'Valid', unexpected: true },
      { name: 'Valid', defaultServiceIntervalDays: 3651 },
      { name: 'Valid', defaultMaxBookingMinutes: 4 },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
    await request(app.getHttpServer())
      .patch(`/api/v1/categories/${categoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
    expect(categories.create).not.toHaveBeenCalled();
    expect(categories.update).not.toHaveBeenCalled();
  });

  it('normalizes a differently cased duplicate before returning CATEGORY_NAME_TAKEN', async () => {
    categories.create.mockRejectedValueOnce(new CategoryNameTakenException());
    const response = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  ventilator  ' })
      .expect(409);
    expect(response.body.error.code).toBe('CATEGORY_NAME_TAKEN');
    expect(categories.create).toHaveBeenCalledWith(
      currentUser,
      { name: 'ventilator' },
      expect.any(String),
    );
  });

  it.each([
    [new CategoryNameTakenException(), 409, 'CATEGORY_NAME_TAKEN'],
    [new CategoryNotFoundException(), 404, 'CATEGORY_NOT_FOUND'],
    [new CategoryInUseException(3), 409, 'CATEGORY_IN_USE'],
  ] as const)('preserves stable errors in the standard envelope', async (error, status, code) => {
    categories.delete.mockRejectedValueOnce(error);
    const response = await request(app.getHttpServer())
      .delete(`/api/v1/categories/${categoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', `category-${code}`)
      .expect(status);
    expect(response.body.error).toMatchObject({ code, requestId: `category-${code}` });
    if (code === 'CATEGORY_IN_USE') {
      expect(response.body.error.details).toEqual({ machine_count: 3 });
    }
  });
});
