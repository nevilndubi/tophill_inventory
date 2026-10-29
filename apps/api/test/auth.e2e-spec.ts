import { Controller, Get, RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  AuthenticatedOnly,
  IS_AUTHENTICATED_ONLY_ROUTE,
} from '../src/authorization/authenticated-only.decorator';
import {
  AuthenticationUnavailableException,
  InvalidAuthenticationException,
  UserInactiveException,
  UserNotProvisionedException,
} from '../src/auth/auth.errors';
import { IS_PUBLIC_ROUTE } from '../src/auth/public.decorator';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { configureApplication } from '../src/bootstrap/configure-application';
import { REQUIRED_PERMISSION } from '../src/authorization/require-permission.decorator';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';

const subjects = {
  inactive: '22222222-2222-4222-8222-222222222222',
  missing: '33333333-3333-4333-8333-333333333333',
  valid: '11111111-1111-4111-8111-111111111111',
};

const authenticatedUser = {
  department: {
    code: 'ICU',
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Intensive Care Unit',
  },
  email: 'staff@hospital.test',
  fullName: 'Hospital Staff',
  id: '55555555-5555-4555-8555-555555555555',
  isActive: true,
  role: 'STAFF' as const,
};

const tokenFor = (label: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ label })).toString('base64url');
  return `${header}.${payload}.c2lnbmF0dXJl`;
};

const readLabel = (token: string): string => {
  const encodedPayload = token.split('.')[1];

  if (encodedPayload === undefined) return 'malformed';

  const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  return typeof parsed === 'object' && parsed !== null && 'label' in parsed
    ? String(parsed.label)
    : 'malformed';
};

@Controller('protected-fixture')
@AuthenticatedOnly()
class ProtectedFixtureController {
  @Get()
  getFixture() {
    return { protected: true };
  }
}

describe('API authentication (e2e)', () => {
  let app: INestApplication;
  let discovery: DiscoveryService;
  let metadataScanner: MetadataScanner;
  let reflector: Reflector;

  const tokenVerifier = {
    verify: jest.fn(async (token: string) => {
      const label = readLabel(token);

      if (label === 'unavailable') throw new AuthenticationUnavailableException();
      if (
        [
          'expired',
          'forged',
          'unknown-kid',
          'wrong-issuer',
          'wrong-audience',
          'wrong-role',
        ].includes(label)
      ) {
        throw new InvalidAuthenticationException();
      }

      if (label === 'inactive') return { subject: subjects.inactive };
      if (label === 'missing') return { subject: subjects.missing };
      return { subject: subjects.valid };
    }),
  };
  const userSession = {
    resolve: jest.fn(async (subject: string) => {
      if (subject === subjects.inactive) throw new UserInactiveException();
      if (subject === subjects.missing) throw new UserNotProvisionedException();
      return authenticatedUser;
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProtectedFixtureController],
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
    reflector = moduleRef.get(Reflector);
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the root health probes public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(tokenVerifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Token not-a-bearer-token'],
    ['incomplete Bearer', 'Bearer only-one-segment'],
  ])('returns a standard 401 for %s credentials', async (_name, authorization) => {
    const requestBuilder = request(app.getHttpServer())
      .get('/api/v1/me')
      .set('x-request-id', 'auth-invalid-request');

    if (authorization !== undefined) requestBuilder.set('Authorization', authorization);

    const response = await requestBuilder.expect(401);
    expect(response.body).toEqual({
      error: {
        code: 'AUTH_INVALID',
        details: {},
        message: 'Authentication credentials are invalid',
        requestId: 'auth-invalid-request',
      },
    });
  });

  it.each(['expired', 'forged', 'unknown-kid', 'wrong-issuer', 'wrong-audience', 'wrong-role'])(
    'returns 401 when token verification rejects %s',
    async (label) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${tokenFor(label)}`)
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_INVALID',
        requestId: expect.any(String),
      });
    },
  );

  it('returns 503 without converting a JWKS outage into a logout response', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokenFor('unavailable')}`)
      .set('x-request-id', 'auth-unavailable-request')
      .expect(503);

    expect(response.body).toEqual({
      error: {
        code: 'AUTH_UNAVAILABLE',
        details: {},
        message: 'Authentication service is temporarily unavailable',
        requestId: 'auth-unavailable-request',
      },
    });
  });

  it.each([
    ['inactive local user', 'inactive', 'USER_INACTIVE'],
    ['unprovisioned identity', 'missing', 'USER_NOT_PROVISIONED'],
  ])('returns a standard 403 for an %s', async (_name, label, code) => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokenFor(label)}`)
      .expect(403);

    expect(response.body.error).toMatchObject({ code, requestId: expect.any(String) });
  });

  it('returns only the documented /me fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200);

    expect(response.body).toEqual({ data: authenticatedUser });
    expect(JSON.stringify(response.body)).not.toMatch(
      /supabaseUserId|supabase_user_id|isSeedData|is_seed_data|createdAt|updatedAt/,
    );
  });

  it('protects an undecorated controller through the global guard', async () => {
    await request(app.getHttpServer()).get('/api/v1/protected-fixture').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/protected-fixture')
      .set('Authorization', `Bearer ${tokenFor('valid')}`)
      .expect(200, { data: { protected: true } });
  });

  it('allows CORS preflight without authentication', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/me')
      .set('Access-Control-Request-Headers', 'authorization')
      .set('Access-Control-Request-Method', 'GET')
      .set('Origin', 'http://127.0.0.1:3000')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(tokenVerifier.verify).not.toHaveBeenCalled();
  });

  it('allows public metadata only on the two documented controller routes', () => {
    const publicRoutes: string[] = [];

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

        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
          handler,
          controller,
        ]);
        if (isPublic === true) {
          const routeParts = [controllerPath, methodPath]
            .map((part) => part.replace(/^\/+|\/+$/g, ''))
            .filter((part) => part.length > 0);
          publicRoutes.push(`/${routeParts.join('/')}`);
        }
      }
    }

    expect(publicRoutes.sort()).toEqual(['/health', '/health/ready']);
  });

  it('keeps an explicit coverage inventory for every controller route', () => {
    const coveredRoutes: string[] = [];

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

        const routeParts = [controllerPath, methodPath]
          .map((part) => part.replace(/^\/+|\/+$/g, ''))
          .filter((part) => part.length > 0);
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
        const access = isPublic
          ? 'public'
          : isAuthenticatedOnly
            ? 'authenticated-only'
            : permission
              ? `permission:${String(permission)}`
              : 'missing';
        coveredRoutes.push(`${RequestMethod[requestMethod]} /${routeParts.join('/')} ${access}`);
      }
    }

    expect(coveredRoutes.sort()).toEqual([
      'DELETE /attachments/:id permission:attachment:upload',
      'DELETE /categories/:id permission:reference:manage',
      'DELETE /departments/:id permission:reference:manage',
      'DELETE /locations/:id permission:reference:manage',
      'DELETE /machines/:id permission:machine:retire',
      'GET /attachments/:id/url permission:machine:read',
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
      'GET /machines/:id/history permission:machine:read',
      'GET /machines/:machineId/attachments permission:machine:read',
      'GET /machines/by-tag/:assetTag permission:machine:read',
      'GET /machines/import/template permission:machine:create',
      'GET /me authenticated-only',
      'GET /protected-fixture authenticated-only',
      'GET /users permission:user:manage',
      'GET /users/departments permission:user:manage',
      'PATCH /categories/:id permission:reference:manage',
      'PATCH /departments/:id permission:reference:manage',
      'PATCH /locations/:id permission:reference:manage',
      'PATCH /machines/:id permission:machine:update',
      'PATCH /users/:id permission:user:manage',
      'POST /attachments/confirm permission:attachment:upload',
      'POST /categories permission:reference:manage',
      'POST /departments permission:reference:manage',
      'POST /locations permission:reference:manage',
      'POST /machines permission:machine:create',
      'POST /machines/:id/check-in permission:usage:check-in-out',
      'POST /machines/:id/check-out permission:usage:check-in-out',
      'POST /machines/:id/condition permission:service:manage',
      'POST /machines/:id/restore permission:machine:restore',
      'POST /machines/:machineId/attachments/sign-upload permission:attachment:upload',
      'POST /machines/import permission:machine:create',
      'POST /users permission:user:manage',
      'POST /users/:id/deactivate permission:user:manage',
      'POST /users/:id/reactivate permission:user:manage',
    ]);
  });
});
