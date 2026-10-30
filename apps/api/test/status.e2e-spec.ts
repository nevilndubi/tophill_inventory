import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UserInactiveException } from '../src/auth/auth.errors';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { MachineNotFoundException } from '../src/machines/machines.errors';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';
import { StatusService } from '../src/status/status.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: USER_ID,
  isActive,
  role,
});

const machineStatus = {
  as_of: '2026-10-29T12:00:00.000Z',
  asset_tag: 'HM-000001',
  category: { id: '33333333-3333-4333-8333-333333333333', name: 'Ventilator' },
  department: {
    code: 'ICU',
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Intensive Care',
  },
  display_status: 'AVAILABLE_OK' as const,
  id: MACHINE_ID,
  location: { id: '55555555-5555-4555-8555-555555555555', name: 'Bay 1' },
  name: 'Ventilator One',
  next_booking_at: null,
  open_session: null,
  service_due: false,
  stored_condition: 'OPERATIONAL' as const,
  usable: true,
};

const statusBoard = {
  as_of: machineStatus.as_of,
  counts: {
    AVAILABLE_NEEDS_SERVICE: 0,
    AVAILABLE_OK: 1,
    IN_USE: 0,
    OUT_OF_SERVICE: 0,
    RETIRED: 0,
    UNDER_MAINTENANCE: 0,
  },
  items: [machineStatus],
  page: 1,
  page_size: 50,
  total: 1,
};

describe('Live status API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('STAFF');
  const status = {
    board: jest.fn(async () => statusBoard),
    get: jest.fn(async () => machineStatus),
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
      .useValue({ verify: jest.fn(async () => ({ subject: USER_ID })) })
      .overrideProvider(UserSessionService)
      .useValue({
        resolve: jest.fn(async () => {
          if (!currentUser.isActive) throw new UserInactiveException();
          return currentUser;
        }),
      })
      .overrideProvider(StatusService)
      .useValue(status)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('STAFF');
    jest.clearAllMocks();
    status.get.mockImplementation(async () => machineStatus);
  });

  it('returns minimized status and board payloads with live-data cache headers', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/machines/${MACHINE_ID}/status`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body).toEqual({ data: machineStatus });
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.headers.vary).toContain('Authorization');

    const board = await request(app.getHttpServer())
      .get('/api/v1/status/board?status=IN_USE&status=RETIRED&page_size=20')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(board.body).toEqual({ data: statusBoard });
    expect(board.headers['cache-control']).toBe('no-store');
    expect(board.headers.vary).toContain('Authorization');
    expect(status.board).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      expect.objectContaining({ page_size: 20, status: ['IN_USE', 'RETIRED'] }),
    );
    expect(JSON.stringify(board.body)).not.toMatch(/email|supabase|seed|token/i);
  });

  it('rejects unknown filters, false service_due, short search and invalid IDs', async () => {
    for (const path of [
      '/api/v1/status/board?unknown=true',
      '/api/v1/status/board?service_due=false',
      '/api/v1/status/board?q=x',
      '/api/v1/status/board?page_size=201',
      '/api/v1/machines/not-a-uuid/status',
    ]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(status.board).not.toHaveBeenCalled();
    expect(status.get).not.toHaveBeenCalled();
  });

  it('returns the standard hidden-machine not-found response', async () => {
    status.get.mockRejectedValueOnce(new MachineNotFoundException());
    const response = await request(app.getHttpServer())
      .get(`/api/v1/machines/${MACHINE_ID}/status`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'status-not-found')
      .expect(404);
    expect(response.body).toEqual({
      error: {
        code: 'MACHINE_NOT_FOUND',
        details: {},
        message: 'Machine was not found',
        requestId: 'status-not-found',
      },
    });
  });

  it('preserves authentication then inactive-user ordering before validation', async () => {
    await request(app.getHttpServer()).get('/api/v1/status/board?unknown=true').expect(401);

    currentUser = user('VIEWER', false);
    const inactive = await request(app.getHttpServer())
      .get('/api/v1/status/board?unknown=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(inactive.body.error.code).toBe('USER_INACTIVE');
    expect(status.board).not.toHaveBeenCalled();
  });
});
