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
import {
  MachineAlreadyDeletedException,
  MachineHasActiveBookingsException,
  MachineIdentityTakenException,
  MachineNotDeletedException,
  MachineNotFoundException,
} from '../src/machines/machines.errors';
import { MachinesService } from '../src/machines/machines.service';
import { ConditionService } from '../src/machines/condition.service';
import { ConditionChangedException } from '../src/machines/condition.errors';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0In0.signature';
const ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '44444444-4444-4444-8444-444444444444';

const machine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  category: { id: CATEGORY_ID, name: 'Ventilator' },
  commissionedOn: null,
  condition: 'OPERATIONAL' as const,
  department: { code: 'ICU', id: DEPARTMENT_ID, name: 'Intensive Care' },
  description: null,
  id: ID,
  isBookable: true,
  registryStatus: 'ACTIVE' as const,
  lastServicedAt: null,
  location: { id: LOCATION_ID, name: 'Bay A' },
  manufacturer: 'acme',
  maxBookingMinutes: null,
  model: 'v1',
  name: 'Ventilator',
  nextServiceDueAt: null,
  purchaseDate: null,
  requiresApproval: false,
  serialNumber: 'sn-1',
  serviceIntervalDays: null,
  warrantyExpiresOn: null,
};
const validCreate = {
  categoryId: CATEGORY_ID,
  departmentId: DEPARTMENT_ID,
  locationId: LOCATION_ID,
  manufacturer: ' Acme ',
  model: ' V1 ',
  name: ' Theatre   Ventilator ',
  serialNumber: ' SN-1 ',
};

const user = (role: AuthenticatedUser['role'], isActive = true): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '55555555-5555-4555-8555-555555555555',
  isActive,
  role,
});

describe('Machines API (e2e)', () => {
  let app: INestApplication;
  let currentUser = user('ADMIN');
  const machines = {
    create: jest.fn(async () => machine),
    delete: jest.fn(async () => machine),
    list: jest.fn(async () => ({ items: [machine], page: 1, pageSize: 25, total: 1 })),
    read: jest.fn(async () => machine),
    readByAssetTag: jest.fn(async (assetTag: string) => {
      if (!/^\s*HM-\d{6,}\s*$/i.test(assetTag)) throw new MachineNotFoundException();
      return machine;
    }),
    update: jest.fn(async () => machine),
    restore: jest.fn(async () => machine),
  };
  const conditions = {
    history: jest.fn(async () => ({ items: [], page: 1, pageSize: 50, total: 0 })),
    transition: jest.fn(async () => ({
      condition: 'NEEDS_SERVICE',
      machineId: ID,
      retiredOn: null,
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
      .overrideProvider(MachinesService)
      .useValue(machines)
      .overrideProvider(ConditionService)
      .useValue(conditions)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    currentUser = user('ADMIN');
    jest.clearAllMocks();
    machines.readByAssetTag.mockImplementation(async (assetTag: string) => {
      if (!/^\s*HM-\d{6,}\s*$/i.test(assetTag)) throw new MachineNotFoundException();
      return machine;
    });
  });

  it('requires authentication and rejects inactive users before authorization', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/v1/machines').expect(401)).body.error.code,
    ).toBe('AUTH_INVALID');
    currentUser = user('ADMIN', false);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/machines')
          .set('Authorization', `Bearer ${token}`)
          .expect(403)
      ).body.error.code,
    ).toBe('USER_INACTIVE');
  });

  it('returns page metadata and passes every normalized list filter to the service', async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/api/v1/machines?page=2&pageSize=10&department_id=${DEPARTMENT_ID}&category_id=${CATEGORY_ID}&location_id=${LOCATION_ID}&condition=OPERATIONAL&is_bookable=false&service_due=true&search=ventilator&sort=name&direction=desc`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      data: [machine],
      meta: { page: 1, pageSize: 25, total: 1 },
    });
    expect(machines.list).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN' }), {
      category_id: CATEGORY_ID,
      condition: 'OPERATIONAL',
      department_id: DEPARTMENT_ID,
      direction: 'desc',
      is_bookable: false,
      location_id: LOCATION_ID,
      page: 2,
      pageSize: 10,
      registry: 'active',
      search: 'ventilator',
      service_due: true,
      sort: 'name',
    });
  });

  it('rejects unknown queries, one-character search, invalid pagination, and raw sort input', async () => {
    for (const query of ['unknown=x', 'search=x', 'page=0', 'pageSize=101', 'sort=name%20desc']) {
      await request(app.getHttpServer())
        .get(`/api/v1/machines?${query}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    }
    expect(machines.list).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/api/v1/machines?search=EC')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('normalizes create input and lets only ADMIN and SUPER_ADMIN create', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      currentUser = user(role);
      await request(app.getHttpServer())
        .post('/api/v1/machines')
        .set('Authorization', `Bearer ${token}`)
        .send(validCreate)
        .expect(201);
    }
    expect(machines.create).toHaveBeenCalledWith(
      expect.any(Object),
      {
        categoryId: CATEGORY_ID,
        departmentId: DEPARTMENT_ID,
        locationId: LOCATION_ID,
        manufacturer: 'acme',
        model: 'V1',
        name: 'Theatre Ventilator',
        serialNumber: 'sn-1',
      },
      expect.any(String),
    );

    for (const role of ['BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'] as const) {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .post('/api/v1/machines')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('allows BIOMED_TECH to update all editable fields but not create or delete', async () => {
    currentUser = user('BIOMED_TECH');
    await request(app.getHttpServer())
      .patch(`/api/v1/machines/${ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isBookable: false, name: 'Updated' })
      .expect(200);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/machines')
          .set('Authorization', `Bearer ${token}`)
          .send(validCreate)
          .expect(403)
      ).body.error.code,
    ).toBe('PERMISSION_DENIED');
    expect(
      (
        await request(app.getHttpServer())
          .delete(`/api/v1/machines/${ID}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403)
      ).body.error.code,
    ).toBe('PERMISSION_DENIED');
  });

  it('allows every active role to read by list, id, and normalized tag', async () => {
    for (const role of [
      'SUPER_ADMIN',
      'ADMIN',
      'BIOMED_TECH',
      'DEPT_MANAGER',
      'STAFF',
      'VIEWER',
    ] as const) {
      currentUser = user(role);
      await request(app.getHttpServer())
        .get('/api/v1/machines')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/machines/${ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/machines/by-tag/%20hm-000061%20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
  });

  it('allows every active role to read minimized condition history', async () => {
    for (const role of [
      'SUPER_ADMIN',
      'ADMIN',
      'BIOMED_TECH',
      'DEPT_MANAGER',
      'STAFF',
      'VIEWER',
    ] as const) {
      currentUser = user(role);
      await request(app.getHttpServer())
        .get(`/api/v1/machines/${ID}/history?page=1&pageSize=50`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
  });

  it('allows service managers to transition and denies other roles before validation', async () => {
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'BIOMED_TECH'] as const) {
      currentUser = user(role);
      await request(app.getHttpServer())
        .post(`/api/v1/machines/${ID}/condition`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCondition: 'OPERATIONAL',
          reason: 'Verified equipment condition',
          toCondition: 'NEEDS_SERVICE',
        })
        .expect(201);
    }
    expect(conditions.transition).toHaveBeenCalledWith(
      ID,
      'NEEDS_SERVICE',
      expect.objectContaining({ force: false, source: 'MANUAL' }),
    );
    for (const role of ['DEPT_MANAGER', 'STAFF', 'VIEWER'] as const) {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/machines/${ID}/condition`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects unknown fields and reports stale observed condition safely', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/machines/${ID}/condition`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        actor: ID,
        fromCondition: 'OPERATIONAL',
        reason: 'Verified equipment condition',
        toCondition: 'NEEDS_SERVICE',
      })
      .expect(400);
    conditions.transition.mockRejectedValueOnce(new ConditionChangedException('OUT_OF_SERVICE'));
    const response = await request(app.getHttpServer())
      .post(`/api/v1/machines/${ID}/condition`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromCondition: 'OPERATIONAL',
        reason: 'Verified equipment condition',
        toCondition: 'NEEDS_SERVICE',
      })
      .expect(409);
    expect(response.body.error).toMatchObject({
      code: 'CONDITION_CHANGED',
      details: { current_condition: 'OUT_OF_SERVICE' },
    });
  });

  it('accepts a DELETE JSON body through CORS and normalizes the registry reason', async () => {
    const preflight = await request(app.getHttpServer())
      .options(`/api/v1/machines/${ID}`)
      .set('Origin', 'http://127.0.0.1:3000')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(preflight.headers['access-control-allow-methods']).toContain('DELETE');
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'content-type',
    );

    await request(app.getHttpServer())
      .delete(`/api/v1/machines/${ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({ reason: '  Registry   correction  ' })
      .expect(200);
    expect(machines.delete).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      ID,
      { reason: 'Registry correction' },
      expect.any(String),
    );
  });

  it('allows only ADMIN and SUPER_ADMIN to restore', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      currentUser = user(role);
      await request(app.getHttpServer())
        .post(`/api/v1/machines/${ID}/restore`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Corrected registry removal' })
        .expect(201);
    }
    for (const role of ['BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'] as const) {
      currentUser = user(role);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/machines/${ID}/restore`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('returns MACHINE_NOT_FOUND for malformed tags and validates UUID ids', async () => {
    const malformed = await request(app.getHttpServer())
      .get('/api/v1/machines/by-tag/not-a-tag')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(malformed.body.error.code).toBe('MACHINE_NOT_FOUND');
    await request(app.getHttpServer())
      .get('/api/v1/machines/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('rejects empty PATCHes, unknown fields, state/internal fields, and relation objects', async () => {
    for (const body of [
      {},
      { condition: 'NEEDS_SERVICE' },
      { asset_tag: 'HM-999999' },
      { deleted_at: null },
      { retired_on: '2026-10-25' },
      { id: ID },
      { createdAt: '2026-10-25T00:00:00Z' },
      { category: { id: CATEGORY_ID } },
      { nextServiceDueAt: '2026-10-25T00:00:00Z' },
    ]) {
      await request(app.getHttpServer())
        .patch(`/api/v1/machines/${ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
    expect(machines.update).not.toHaveBeenCalled();
  });

  it('validates field bounds, ISO date shapes, and purchase dates', async () => {
    for (const body of [
      { ...validCreate, name: ' ' },
      { ...validCreate, serviceIntervalDays: 3651 },
      { ...validCreate, maxBookingMinutes: 4 },
      { ...validCreate, purchaseDate: '10/25/2026' },
      { ...validCreate, purchaseDate: '2999-01-01' },
      { ...validCreate, lastServicedAt: '2026-10-25T12:00:00' },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/machines')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
  });

  it('accepts a zero-minute machine buffer override', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/machines')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validCreate, bufferMinutes: 0 })
      .expect(201);
    expect(machines.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bufferMinutes: 0 }),
      expect.any(String),
    );
  });

  it.each([
    [new MachineIdentityTakenException(), 409, 'MACHINE_IDENTITY_TAKEN'],
    [new MachineNotFoundException(), 404, 'MACHINE_NOT_FOUND'],
    [new MachineAlreadyDeletedException(), 409, 'MACHINE_ALREADY_DELETED'],
    [new MachineHasActiveBookingsException(2), 409, 'MACHINE_HAS_ACTIVE_BOOKINGS'],
    [new MachineNotDeletedException(), 409, 'MACHINE_NOT_DELETED'],
  ] as const)('preserves stable errors and request IDs', async (error, status, code) => {
    const isRestore = error instanceof MachineNotDeletedException;
    (isRestore ? machines.restore : machines.delete).mockRejectedValueOnce(error);
    const builder = isRestore
      ? request(app.getHttpServer()).post(`/api/v1/machines/${ID}/restore`)
      : request(app.getHttpServer()).delete(`/api/v1/machines/${ID}`);
    const response = await builder
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', `machine-${code}`)
      .send({})
      .expect(status);
    expect(response.body.error).toMatchObject({ code, requestId: `machine-${code}` });
    expect(JSON.stringify(response.body)).not.toMatch(/constraint|prisma|sql/i);
  });
});
