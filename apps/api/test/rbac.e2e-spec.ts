import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UserInactiveException } from '../src/auth/auth.errors';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { IS_PUBLIC_ROUTE } from '../src/auth/public.decorator';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { IS_AUTHENTICATED_ONLY_ROUTE } from '../src/authorization/authenticated-only.decorator';
import { PermissionGuard } from '../src/authorization/permission.guard';
import { REQUIRED_PERMISSION } from '../src/authorization/require-permission.decorator';
import { configureApplication } from '../src/bootstrap/configure-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';
import { RbacTestOnlyController } from './rbac-test-only.controller';

const tokenFor = (label: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ label })).toString('base64url');
  return `${header}.${payload}.c2lnbmF0dXJl`;
};

const readLabel = (token: string): string => {
  const encodedPayload = token.split('.')[1];
  if (encodedPayload === undefined) return 'unknown';

  const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  return typeof parsed === 'object' && parsed !== null && 'label' in parsed
    ? String(parsed.label)
    : 'unknown';
};

const makeUser = (
  role: AuthenticatedUser['role'],
  departmentId: string | null = 'department-a',
): AuthenticatedUser => ({
  department:
    departmentId === null ? null : { code: 'ICU', id: departmentId, name: 'Intensive Care Unit' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role,
});

describe('API role authorization (e2e)', () => {
  let app: INestApplication;
  let currentUser = makeUser('STAFF');
  let discovery: DiscoveryService;
  let metadataScanner: MetadataScanner;
  let permissionGuard: PermissionGuard;
  let reflector: Reflector;

  const tokenVerifier = {
    verify: jest.fn(async (token: string) => ({ subject: readLabel(token) })),
  };
  const userSession = {
    resolve: jest.fn(async (subject: string) => {
      if (subject === 'inactive') throw new UserInactiveException();
      return currentUser;
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RbacTestOnlyController],
      imports: [AppModule, DiscoveryModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(PrismaService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(JwtVerifierService)
      .useValue(tokenVerifier)
      .overrideProvider(UserSessionService)
      .useValue(userSession)
      .compile();

    discovery = moduleRef.get(DiscoveryService);
    metadataScanner = moduleRef.get(MetadataScanner);
    permissionGuard = moduleRef.get(PermissionGuard);
    reflector = moduleRef.get(Reflector);
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = makeUser('STAFF');
    jest.clearAllMocks();
  });

  it('allows and denies a global permission from the Neon user role', async () => {
    currentUser = makeUser('ADMIN');
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200, { data: { allowed: true } });

    currentUser = makeUser('STAFF');
    const denied = await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .set('x-request-id', 'rbac-denied-request')
      .expect(403);

    expect(denied.body).toEqual({
      error: {
        code: 'PERMISSION_DENIED',
        details: {},
        message: 'You do not have permission to perform this action',
        requestId: 'rbac-denied-request',
      },
    });
    expect(JSON.stringify(denied.body)).not.toMatch(/ADMIN|SUPER_ADMIN|BIOMED_TECH/);
  });

  it('enforces own-department scope and denies missing or cross-department resources', async () => {
    currentUser = makeUser('DEPT_MANAGER', 'department-a');
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/department/department-a')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/department/department-b')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(403);

    currentUser = makeUser('DEPT_MANAGER', null);
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/department/department-a')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(403);

    currentUser = makeUser('ADMIN', null);
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/department/department-b')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200);
  });

  it('keeps public and authenticated-only routes distinct', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/public')
      .expect(200, { data: { public: true } });
    await request(app.getHttpServer()).get('/api/v1/rbac-test-only/authenticated').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/authenticated')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200, { data: { allowed: true } });
  });

  it('returns 401 before authorization and does not run the permission guard for inactive users', async () => {
    const guardSpy = jest.spyOn(permissionGuard, 'canActivate');

    await request(app.getHttpServer()).get('/api/v1/rbac-test-only/global').expect(401);
    expect(guardSpy).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${tokenFor('inactive')}`)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('USER_INACTIVE'));
    expect(guardSpy).not.toHaveBeenCalled();
    guardSpy.mockRestore();
  });

  it('allows CORS preflight without authentication', async () => {
    await request(app.getHttpServer())
      .options('/api/v1/rbac-test-only/global')
      .set('Access-Control-Request-Headers', 'authorization')
      .set('Access-Control-Request-Method', 'GET')
      .set('Origin', 'http://127.0.0.1:3000')
      .expect(204);
  });

  it('reads the role from the database-backed user context on every request', async () => {
    currentUser = makeUser('STAFF');
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${tokenFor('same-identity')}`)
      .expect(403);

    currentUser = makeUser('ADMIN');
    await request(app.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${tokenFor('same-identity')}`)
      .expect(200);

    expect(userSession.resolve).toHaveBeenCalledTimes(2);
  });

  it('requires explicit access metadata on every non-public handler', () => {
    const routes: string[] = [];

    for (const wrapper of discovery.getControllers()) {
      const controller = wrapper.metatype;
      const instance = wrapper.instance as object | null;
      if (controller === null || instance === null) continue;

      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      if (controllerPath === undefined) continue;

      for (const methodName of metadataScanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const handler = instance[methodName as keyof typeof instance];
        if (typeof handler !== 'function') continue;

        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (methodPath === undefined || requestMethod === undefined) continue;

        const isPublic =
          reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [handler, controller]) === true;
        const isAuthenticatedOnly =
          reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_ONLY_ROUTE, [
            handler,
            controller,
          ]) === true;
        const permission = reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSION, [
          handler,
          controller,
        ]);
        const declarations = [isPublic, isAuthenticatedOnly, permission !== undefined].filter(
          Boolean,
        );
        expect(declarations).toHaveLength(1);

        const routeParts = [controllerPath, methodPath]
          .map((part) => part.replace(/^\/+|\/+$/g, ''))
          .filter((part) => part.length > 0);
        const access = isPublic
          ? 'public'
          : isAuthenticatedOnly
            ? 'authenticated-only'
            : `permission:${String(permission)}`;
        routes.push(`${RequestMethod[requestMethod]} /${routeParts.join('/')} ${access}`);
      }
    }

    expect(routes.sort()).toEqual([
      'DELETE /categories/:id permission:reference:manage',
      'DELETE /departments/:id permission:reference:manage',
      'DELETE /locations/:id permission:reference:manage',
      'DELETE /machines/:id permission:machine:retire',
      'GET /categories permission:machine:read',
      'GET /categories/:id permission:machine:read',
      'GET /departments permission:machine:read',
      'GET /departments/:id permission:machine:read',
      'GET /departments/:id/eligible-managers permission:reference:manage',
      'GET /health public',
      'GET /health/ready public',
      'GET /locations permission:machine:read',
      'GET /locations/:id permission:machine:read',
      'GET /machines permission:machine:read',
      'GET /machines/:id permission:machine:read',
      'GET /machines/by-tag/:assetTag permission:machine:read',
      'GET /me authenticated-only',
      'GET /rbac-test-only/authenticated authenticated-only',
      'GET /rbac-test-only/department/:departmentId permission:booking:approve',
      'GET /rbac-test-only/departmentless permission:booking:approve',
      'GET /rbac-test-only/global permission:machine:create',
      'GET /rbac-test-only/public public',
      'GET /rbac-test-only/unknown-permission permission:unknown:permission',
      'GET /users permission:user:manage',
      'GET /users/departments permission:user:manage',
      'PATCH /categories/:id permission:reference:manage',
      'PATCH /departments/:id permission:reference:manage',
      'PATCH /locations/:id permission:reference:manage',
      'PATCH /machines/:id permission:machine:update',
      'PATCH /users/:id permission:user:manage',
      'POST /categories permission:reference:manage',
      'POST /departments permission:reference:manage',
      'POST /locations permission:reference:manage',
      'POST /machines permission:machine:create',
      'POST /users permission:user:manage',
      'POST /users/:id/deactivate permission:user:manage',
      'POST /users/:id/reactivate permission:user:manage',
    ]);
  });
});
