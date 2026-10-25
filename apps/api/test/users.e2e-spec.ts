import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';
import { UsersService } from '../src/users/users.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const user = (role: AuthenticatedUser['role']): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test Administrator',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role,
});

describe('User management API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('SUPER_ADMIN');
  const users = {
    invite: jest.fn(async () => ({ id: 'created-user' })),
    list: jest.fn(async () => ({
      items: [
        {
          department: null,
          email: 'redacted-for-test',
          fullName: 'Managed User',
          id: 'managed-user',
          isActive: true,
          lastLoginAt: null,
          role: 'STAFF',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
    })),
    listDepartments: jest.fn(async () => []),
    setActive: jest.fn(async () => ({ id: 'managed-user' })),
    update: jest.fn(async () => ({ id: 'managed-user' })),
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
      .useValue({ resolve: jest.fn(async () => currentUser) })
      .overrideProvider(UsersService)
      .useValue(users)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('SUPER_ADMIN');
    jest.clearAllMocks();
  });

  it('denies every endpoint to roles without user:manage', async () => {
    currentUser = user('STAFF');
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(403);
    expect(users.list).not.toHaveBeenCalled();
    expect(users.invite).not.toHaveBeenCalled();
  });

  it('lists minimized user fields for an administrator', async () => {
    currentUser = user('ADMIN');
    const response = await request(app.getHttpServer())
      .get('/api/v1/users?page=1&pageSize=25')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data.total).toBe(1);
    expect(JSON.stringify(response.body)).not.toMatch(
      /supabase_user_id|supabaseUserId|is_seed_data|isSeedData/,
    );
  });

  it('validates the small invitation body before calling the service', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'invalid-invite-request')
      .send({ email: 'not-an-email', fullName: ' ', role: 'STAFF', unexpected: true })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: 'invalid-invite-request',
    });
    expect(users.invite).not.toHaveBeenCalled();
  });

  it('rejects invitation request bodies larger than 16 KiB', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'test@example.test', fullName: 'x'.repeat(17_000), role: 'STAFF' })
      .expect(413);
    expect(users.invite).not.toHaveBeenCalled();
  });

  it('passes the request ID and authenticated Neon actor into mutations', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'invite-request')
      .send({ email: 'test@example.test', fullName: 'Test Person', role: 'STAFF' })
      .expect(201);

    expect(users.invite).toHaveBeenCalledWith(
      currentUser,
      { email: 'test@example.test', fullName: 'Test Person', role: 'STAFF' },
      'invite-request',
    );
  });
});
