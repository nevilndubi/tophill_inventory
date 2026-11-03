import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { CreatedBooking } from '@app/shared';
import { UserInactiveException } from '../src/auth/auth.errors';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { BookingService } from '../src/booking/booking.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const machineId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const bookingId = '33333333-3333-4333-8333-333333333333';
const body = {
  ends_at: '2026-11-04T11:00:00.000Z',
  machine_id: machineId,
  purpose: '  Ward   round  ',
  starts_at: '2026-11-04T10:00:00.000Z',
};
const booking: CreatedBooking = {
  blocked_until: '2026-11-04T11:15:00.000Z',
  created_at: '2026-11-03T10:00:00.000Z',
  effective_buffer_minutes: 15,
  ends_at: '2026-11-04T11:00:00.000Z',
  id: bookingId,
  machine: { asset_tag: 'HM-000061', id: machineId, name: 'Ventilator' },
  purpose: 'Ward round',
  requires_approval: false,
  starts_at: '2026-11-04T10:00:00.000Z',
  status: 'CONFIRMED' as const,
};

const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: userId,
  isActive,
  role,
});

describe('Booking creation API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('STAFF');
  const bookings = {
    create: jest.fn(async () => ({ booking, replayed: false })),
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
      .useValue({ verify: jest.fn(async () => ({ subject: userId })) })
      .overrideProvider(UserSessionService)
      .useValue({
        resolve: jest.fn(async () => {
          if (!currentUser.isActive) throw new UserInactiveException();
          return currentUser;
        }),
      })
      .overrideProvider(BookingService)
      .useValue(bookings)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('STAFF');
    jest.clearAllMocks();
    bookings.create.mockImplementation(async () => ({ booking, replayed: false }));
  });

  it('creates a minimized booking, normalizes purpose and returns no-store headers', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'opaque-test-key')
      .set('x-request-id', 'booking-create')
      .send(body)
      .expect(201);

    expect(response.body).toEqual({ data: booking });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toContain('Authorization');
    expect(bookings.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: userId }),
      { ...body, purpose: 'Ward round' },
      'booking-create',
      'opaque-test-key',
    );
    expect(JSON.stringify(response.body)).not.toMatch(/idempotency|supabase|password/i);
  });

  it('returns a replay as 200 with the exposed replay header', async () => {
    bookings.create.mockResolvedValueOnce({
      booking: { ...booking, status: 'CANCELLED' },
      replayed: true,
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(response.body.data.status).toBe('CANCELLED');
  });

  it('rejects unknown fields, malformed timestamps, invalid identifiers and blank purpose', async () => {
    for (const invalid of [
      { ...body, unknown: true },
      { ...body, starts_at: '2026-11-04T10:00:00' },
      { ...body, machine_id: 'not-an-id' },
      { ...body, purpose: '   ' },
    ]) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${token}`)
        .send(invalid)
        .expect(400);
      expect(response.body.error).toEqual(
        expect.objectContaining({ code: 'VALIDATION_ERROR', requestId: expect.any(String) }),
      );
    }
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it('enforces authentication, inactive state and booking:create before validation', async () => {
    await request(app.getHttpServer()).post('/api/v1/bookings').send({ unknown: true }).expect(401);

    currentUser = user('STAFF', false);
    const inactive = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unknown: true })
      .expect(403);
    expect(inactive.body.error.code).toBe('USER_INACTIVE');

    currentUser = user('VIEWER');
    const forbidden = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unknown: true })
      .expect(403);
    expect(forbidden.body.error.code).toBe('PERMISSION_DENIED');
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it('allows a browser preflight for idempotency and exposes only the replay metadata header', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/bookings')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
      .set('Access-Control-Request-Method', 'POST')
      .set('Origin', 'http://127.0.0.1:3000')
      .expect(204);
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'idempotency-key',
    );
    expect(String(response.headers['access-control-expose-headers']).toLowerCase()).toContain(
      'idempotency-replayed',
    );
    expect(response.text).toBe('');
  });
});
