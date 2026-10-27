import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AttachmentsService } from '../src/attachments/attachments.service';
import { UserInactiveException } from '../src/auth/auth.errors';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const attachment = {
  fileName: 'manual.pdf',
  id: ATTACHMENT_ID,
  sizeBytes: 1024,
  typeLabel: 'PDF document' as const,
  uploadedAt: '2026-10-27T10:00:00.000Z',
  uploader: { fullName: 'Test technician' },
};

const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '33333333-3333-4333-8333-333333333333',
  isActive,
  role,
});

describe('Machine attachments API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('ADMIN');
  const attachments = {
    confirm: jest.fn(async () => attachment),
    delete: jest.fn(async () => attachment),
    download: jest.fn(async () => ({
      expiresAt: '2026-10-27T10:05:00.000Z',
      url: 'signed-download-redacted',
    })),
    list: jest.fn(async () => [attachment]),
    requestUpload: jest.fn(async () => ({
      expiresAt: '2026-10-27T10:15:00.000Z',
      intentToken: 'intent-redacted',
      uploadUrl: 'signed-upload-redacted',
    })),
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
      .overrideProvider(AttachmentsService)
      .useValue(attachments)
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

  it('requires authentication and active status before attachment access', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/machines/${MACHINE_ID}/attachments`)
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_INVALID'));
    currentUser = user('ADMIN', false);
    await request(app.getHttpServer())
      .get(`/api/v1/machines/${MACHINE_ID}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('USER_INACTIVE'));
  });

  it('allows every active role to list and download minimized metadata', async () => {
    for (const role of [
      'SUPER_ADMIN',
      'ADMIN',
      'BIOMED_TECH',
      'DEPT_MANAGER',
      'STAFF',
      'VIEWER',
    ] as const) {
      currentUser = user(role);
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/machines/${MACHINE_ID}/attachments`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(listed.body).toEqual({ data: [attachment] });
      expect(JSON.stringify(listed.body)).not.toMatch(/storagePath|signedUrl|supabase/i);
      await request(app.getHttpServer())
        .get(`/api/v1/attachments/${ATTACHMENT_ID}/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
  });

  it.each(['SUPER_ADMIN', 'ADMIN', 'BIOMED_TECH'] as const)(
    'allows %s to sign, confirm and delete',
    async (role) => {
      currentUser = user(role);
      await request(app.getHttpServer())
        .post(`/api/v1/machines/${MACHINE_ID}/attachments/sign-upload`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: '../manual.pdf', mimeType: 'application/pdf', sizeBytes: 1024 })
        .expect(201);
      expect(attachments.requestUpload).toHaveBeenCalledWith(
        expect.objectContaining({ role }),
        MACHINE_ID,
        { fileName: '.._manual.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
      );
      await request(app.getHttpServer())
        .post('/api/v1/attachments/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ intentToken: 'intent-redacted' })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/api/v1/attachments/${ATTACHMENT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    },
  );

  it.each(['DEPT_MANAGER', 'STAFF', 'VIEWER'] as const)(
    'denies %s mutation access with the standard envelope',
    async (role) => {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/machines/${MACHINE_ID}/attachments/sign-upload`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-request-id', `attachment-denied-${role}`)
        .send({ fileName: 'manual.pdf', mimeType: 'application/pdf', sizeBytes: 1024 })
        .expect(403);
      expect(response.body).toEqual({
        error: {
          code: 'PERMISSION_DENIED',
          details: {},
          message: 'You do not have permission to perform this action',
          requestId: `attachment-denied-${role}`,
        },
      });
    },
  );

  it('returns stable client validation errors before the storage service runs', async () => {
    const invalidType = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/attachments/sign-upload`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'file.txt', mimeType: 'text/plain', sizeBytes: 100 })
      .expect(400);
    expect(invalidType.body.error.code).toBe('ATTACHMENT_INVALID_TYPE');

    const oversized = await request(app.getHttpServer())
      .post(`/api/v1/machines/${MACHINE_ID}/attachments/sign-upload`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'file.png', mimeType: 'image/png', sizeBytes: 10 * 1024 * 1024 + 1 })
      .expect(400);
    expect(oversized.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(attachments.requestUpload).not.toHaveBeenCalled();
  });
});
