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
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';
import { MachineInUseException, UpcomingBookingConflictException } from '../src/usage/usage.errors';
import { UsageService } from '../src/usage/usage.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: { code: 'ICU', id: '44444444-4444-4444-8444-444444444444', name: 'ICU' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: USER_ID,
  isActive,
  role,
});

const session = {
  expectedEndAt: null,
  id: SESSION_ID,
  machineId: MACHINE_ID,
  purpose: 'General equipment use',
  startedAt: '2026-10-29T09:00:00.000Z',
};

describe('Usage sessions API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('STAFF');
  const usage = {
    checkIn: jest.fn(async () => ({
      ...session,
      durationSeconds: 60,
      endedAt: '2026-10-29T09:01:00.000Z',
    })),
    checkOut: jest.fn(async () => session),
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
      .overrideProvider(UsageService)
      .useValue(usage)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('STAFF');
    jest.clearAllMocks();
    usage.checkOut.mockImplementation(async () => session);
  });

  it('returns minimized check-out and check-in DTOs', async () => {
    const checkedOut = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'usage-checkout')
      .send({ purpose: '  Ward   round  ' })
      .expect(201);
    expect(checkedOut.body).toEqual({ data: session });
    expect(usage.checkOut).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      MACHINE_ID,
      { purpose: 'Ward round' },
      'usage-checkout',
    );

    const checkedIn = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-in`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: ' Finished ' })
      .expect(201);
    expect(checkedIn.body.data).toEqual(expect.objectContaining({ durationSeconds: 60 }));
    expect(JSON.stringify(checkedIn.body)).not.toMatch(/email|supabase|password/i);
  });

  it('rejects unknown fields, malformed time, blank purpose and invalid force reason', async () => {
    for (const body of [
      { unknown: true },
      { expectedEndAt: '2026-10-29T10:00:00' },
      { purpose: '   ' },
    ]) {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      expect(response.body.error).toEqual(
        expect.objectContaining({ code: 'VALIDATION_ERROR', requestId: expect.any(String) }),
      );
    }

    const forced = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-in`)
      .set('Authorization', `Bearer ${token}`)
      .send({ force: true, reason: 'short' })
      .expect(400);
    expect(forced.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('preserves error envelopes and safe booking/session conflict details', async () => {
    usage.checkOut.mockRejectedValueOnce(
      new UpcomingBookingConflictException(new Date('2026-10-29T09:30:00.000Z'), false),
    );
    const booking = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'usage-booking-conflict')
      .send({})
      .expect(409);
    expect(booking.body).toEqual({
      error: {
        code: 'UPCOMING_BOOKING_CONFLICT',
        details: { already_started: false, starts_at: '2026-10-29T09:30:00.000Z' },
        message: 'Another user has a conflicting confirmed booking',
        requestId: 'usage-booking-conflict',
      },
    });

    usage.checkOut.mockRejectedValueOnce(
      new MachineInUseException({
        expectedEndAt: null,
        heldByCurrentUser: true,
        id: SESSION_ID,
        startedAt: '2026-10-29T09:00:00.000Z',
      }),
    );
    const inUse = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);
    expect(inUse.body.error.details).toEqual({
      expected_end_at: null,
      held_by_current_user: true,
      session_id: SESSION_ID,
      started_at: '2026-10-29T09:00:00.000Z',
    });
    expect(JSON.stringify(inUse.body)).not.toMatch(/email|supabase|password/i);
  });

  it('preserves authentication, inactive-user and role ordering', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
      .send({ unknown: true })
      .expect(401);

    currentUser = user('STAFF', false);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/machines/${MACHINE_ID}/check-out`)
          .set('Authorization', `Bearer ${token}`)
          .send({ unknown: true })
          .expect(403)
      ).body.error.code,
    ).toBe('USER_INACTIVE');

    currentUser = user('VIEWER');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/machines/${MACHINE_ID}/check-in`)
          .set('Authorization', `Bearer ${token}`)
          .send({ unknown: true })
          .expect(403)
      ).body.error.code,
    ).toBe('PERMISSION_DENIED');
  });
});
