import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';
import request, { type Response, type Test as SupertestRequest } from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthenticationUnavailableException, UserInactiveException } from '../src/auth/auth.errors';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { IS_PUBLIC_ROUTE } from '../src/auth/public.decorator';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { UserSessionService } from '../src/auth/user-session.service';
import { IS_AUTHENTICATED_ONLY_ROUTE } from '../src/authorization/authenticated-only.decorator';
import { PermissionGuard } from '../src/authorization/permission.guard';
import { REQUIRED_PERMISSION } from '../src/authorization/require-permission.decorator';
import { configureApplication } from '../src/bootstrap/configure-application';
import type { ApiEnvironment } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { RedisService } from '../src/redis/redis.service';
import { UserAlreadyExistsException, UserNotFoundException } from '../src/users/users.errors';
import { UsersService } from '../src/users/users.service';
import { CategoriesService } from '../src/categories/categories.service';
import { DepartmentsService } from '../src/reference/departments.service';
import { LocationsService } from '../src/reference/locations.service';
import { MachinesService } from '../src/machines/machines.service';
import { RbacTestOnlyController } from './rbac-test-only.controller';

jest.setTimeout(30_000);

const TEST_ISSUER = 'https://auth.e2e.test/auth/v1';
const TEST_KEY_ID = 'auth-rbac-e2e-key';
const TEST_SUBJECT = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_A = '33333333-3333-4333-8333-333333333333';
const DEPARTMENT_B = '44444444-4444-4444-8444-444444444444';

const TEST_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'BIOMED_TECH',
  'DEPT_MANAGER',
  'STAFF',
  'VIEWER',
] as const;

type TestRole = (typeof TEST_ROLES)[number];
type AccessExpectation = 'ALLOW' | 'DENY' | 'SCOPED';
type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST';

type ExpectedAccessRow = {
  declaration: string;
  inactive: AccessExpectation;
  method: HttpMethod;
  roles: Record<TestRole, AccessExpectation>;
  route: string;
  successStatus: number;
  unauthenticated: AccessExpectation;
};

// This is deliberately hand-transcribed from Architecture §§5 and 7. Do not derive it from
// @app/shared or from controller permission metadata: it is the independent oracle for this suite.
const EXPECTED_ACCESS_TABLE = [
  {
    declaration: 'public',
    inactive: 'ALLOW',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/health',
    successStatus: 200,
    unauthenticated: 'ALLOW',
  },
  {
    declaration: 'public',
    inactive: 'ALLOW',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/health/ready',
    successStatus: 200,
    unauthenticated: 'ALLOW',
  },
  {
    declaration: 'infrastructure-public',
    inactive: 'ALLOW',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/docs',
    successStatus: 200,
    unauthenticated: 'ALLOW',
  },
  {
    declaration: 'infrastructure-public',
    inactive: 'ALLOW',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/docs-json',
    successStatus: 200,
    unauthenticated: 'ALLOW',
  },
  {
    declaration: 'authenticated-only',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/me',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users/departments',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'PATCH',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users/:id/deactivate',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:user:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/users/:id/reactivate',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/categories',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/categories/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/categories',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'PATCH',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/categories/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'DELETE',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/categories/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/departments',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/departments/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/departments/:id/eligible-managers',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/departments',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'PATCH',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/departments/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'DELETE',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/departments/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/locations',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/locations/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/locations',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'PATCH',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/locations/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:reference:manage',
    inactive: 'DENY',
    method: 'DELETE',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/locations/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/machines',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:create',
    inactive: 'DENY',
    method: 'POST',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/machines',
    successStatus: 201,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/machines/by-tag/:assetTag',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:read',
    inactive: 'DENY',
    method: 'GET',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'ALLOW',
      STAFF: 'ALLOW',
      VIEWER: 'ALLOW',
    },
    route: '/api/v1/machines/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:update',
    inactive: 'DENY',
    method: 'PATCH',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'ALLOW',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/machines/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
  {
    declaration: 'permission:machine:retire',
    inactive: 'DENY',
    method: 'DELETE',
    roles: {
      SUPER_ADMIN: 'ALLOW',
      ADMIN: 'ALLOW',
      BIOMED_TECH: 'DENY',
      DEPT_MANAGER: 'DENY',
      STAFF: 'DENY',
      VIEWER: 'DENY',
    },
    route: '/api/v1/machines/:id',
    successStatus: 200,
    unauthenticated: 'DENY',
  },
] as const satisfies readonly ExpectedAccessRow[];

type InventoryRow = {
  declaration: string;
  method: HttpMethod;
  route: string;
};

type TokenOptions = {
  audience?: string;
  expiresAt?: number;
  issuer?: string;
  key?: CryptoKey;
  kid?: string;
  payload?: JWTPayload;
  role?: string;
  subject?: string;
};

const managedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Managed User',
  id: TARGET_USER_ID,
  isActive: true,
  lastLoginAt: null,
  role: 'STAFF' as const,
};

const makeUser = (
  role: TestRole,
  departmentId: string | null = DEPARTMENT_A,
): AuthenticatedUser => ({
  department:
    departmentId === null ? null : { code: 'ICU', id: departmentId, name: 'Intensive Care Unit' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: TEST_SUBJECT,
  isActive: true,
  role,
});

const usersService = {
  invite: jest.fn(async () => managedUser),
  list: jest.fn(async () => ({ items: [managedUser], page: 1, pageSize: 25, total: 1 })),
  listDepartments: jest.fn(async () => []),
  setActive: jest.fn(async () => managedUser),
  update: jest.fn(async () => managedUser),
};

const managedCategory = {
  defaultMaxBookingMinutes: null,
  defaultServiceIntervalDays: null,
  description: null,
  id: TARGET_USER_ID,
  is_deletable: true,
  machine_count: 0,
  name: 'Test category',
};

const categoriesService = {
  create: jest.fn(async () => managedCategory),
  delete: jest.fn(async () => managedCategory),
  read: jest.fn(async () => managedCategory),
  update: jest.fn(async () => managedCategory),
};
const managedDepartment = {
  code: 'ICU',
  id: DEPARTMENT_A,
  is_deletable: true,
  location_count: 0,
  machine_count: 0,
  manager: null,
  name: 'Intensive Care',
  user_count: 0,
};
const departmentsService = {
  create: jest.fn(async () => managedDepartment),
  delete: jest.fn(async () => managedDepartment),
  eligibleManagers: jest.fn(async () => []),
  read: jest.fn(async () => managedDepartment),
  update: jest.fn(async () => managedDepartment),
};
const managedLocation = {
  building: null,
  department: { code: 'ICU', id: DEPARTMENT_A, name: 'Intensive Care' },
  floor: null,
  id: TARGET_USER_ID,
  is_deletable: true,
  machine_count: 0,
  name: 'Bay A',
  room: null,
};
const locationsService = {
  create: jest.fn(async () => managedLocation),
  delete: jest.fn(async () => managedLocation),
  list: jest.fn(async () => ({ items: [managedLocation], page: 1, pageSize: 50, total: 1 })),
  read: jest.fn(async () => managedLocation),
  update: jest.fn(async () => managedLocation),
};
const managedMachine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  category: { id: TARGET_USER_ID, name: 'Ventilator' },
  commissionedOn: null,
  condition: 'OPERATIONAL' as const,
  department: { code: 'ICU', id: DEPARTMENT_A, name: 'Intensive Care' },
  description: null,
  id: TARGET_USER_ID,
  isBookable: true,
  lastServicedAt: null,
  location: { id: DEPARTMENT_B, name: 'Bay A' },
  manufacturer: 'acme',
  maxBookingMinutes: null,
  model: 'V1',
  name: 'Ventilator',
  nextServiceDueAt: null,
  purchaseDate: null,
  requiresApproval: false,
  serialNumber: 'sn-1',
  serviceIntervalDays: null,
  warrantyExpiresOn: null,
};
const machinesService = {
  create: jest.fn(async () => managedMachine),
  delete: jest.fn(async () => managedMachine),
  list: jest.fn(async () => ({ items: [managedMachine], page: 1, pageSize: 25, total: 1 })),
  read: jest.fn(async () => managedMachine),
  readByAssetTag: jest.fn(async () => managedMachine),
  update: jest.fn(async () => managedMachine),
};

const configForVerifier = (jwksUrl: string) =>
  ({
    get: jest.fn((key: keyof ApiEnvironment) => {
      if (key === 'SUPABASE_JWT_ISSUER') return TEST_ISSUER;
      if (key === 'SUPABASE_JWKS_URL') return jwksUrl;
      return undefined;
    }),
  }) as unknown as ConfigService<ApiEnvironment, true>;

const concreteRoute = (route: string): string =>
  route.replace(':id', TARGET_USER_ID).replace(':assetTag', 'HM-000061');

const requestFor = (app: INestApplication, method: HttpMethod, route: string): SupertestRequest => {
  const path = concreteRoute(route);
  const client = request(app.getHttpServer());
  let builder: SupertestRequest;

  switch (method) {
    case 'GET':
      builder = client.get(path);
      break;
    case 'DELETE':
      builder = client.delete(path);
      break;
    case 'PATCH':
      builder = client
        .patch(path)
        .send(
          route.startsWith('/api/v1/categories') ||
            route.startsWith('/api/v1/departments') ||
            route.startsWith('/api/v1/locations')
            ? { name: 'Updated reference' }
            : route.startsWith('/api/v1/machines')
              ? { name: 'Updated machine' }
              : { fullName: 'Updated User' },
        );
      break;
    case 'POST':
      builder = client.post(path);
      if (route === '/api/v1/users') {
        builder = builder.send({
          email: 'managed-user@example.invalid',
          fullName: 'Managed User',
          role: 'STAFF',
        });
      }
      if (route === '/api/v1/categories') {
        builder = builder.send({ name: 'Test category' });
      }
      if (route === '/api/v1/departments')
        builder = builder.send({ code: 'ICU', name: 'Intensive Care' });
      if (route === '/api/v1/locations')
        builder = builder.send({ departmentId: DEPARTMENT_A, name: 'Bay A' });
      if (route === '/api/v1/machines')
        builder = builder.send({
          categoryId: TARGET_USER_ID,
          departmentId: DEPARTMENT_A,
          locationId: DEPARTMENT_B,
          manufacturer: 'Acme',
          model: 'V1',
          name: 'Ventilator',
          serialNumber: 'SN-1',
        });
      break;
  }

  return builder;
};

const expectExactError = (
  response: Response,
  status: 401 | 403 | 503,
  code: string,
  message: string,
): void => {
  expect(response.status).toBe(status);
  expect(response.headers['x-request-id']).toEqual(expect.any(String));
  expect(response.body).toEqual({
    error: {
      code,
      details: {},
      message,
      requestId: response.headers['x-request-id'],
    },
  });
  expect(Object.keys(response.body.error).sort()).toEqual([
    'code',
    'details',
    'message',
    'requestId',
  ]);
  expect(JSON.stringify(response.body)).not.toMatch(
    /stack|SUPER_ADMIN|ADMIN|BIOMED_TECH|DEPT_MANAGER|STAFF|VIEWER|supabase|email/i,
  );
};

const routeKey = (row: Pick<InventoryRow, 'method' | 'route'>): string =>
  `${row.method} ${row.route}`;

const findHandoff = (): string => {
  const candidates = [
    resolve(process.cwd(), 'project_model_handoff.md'),
    resolve(process.cwd(), '../../project_model_handoff.md'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));

  if (path === undefined) throw new Error('project_model_handoff.md was not found');
  return readFileSync(path, 'utf8');
};

const task72IsComplete = /^- \[x\] 7\.2 /m.test(findHandoff());

describe('Consolidated API authentication and RBAC (e2e)', () => {
  let app: INestApplication;
  let fixtureApp: INestApplication;
  let discovery: DiscoveryService;
  let productionPermissionGuard: PermissionGuard;
  let jwksServer: Server;
  let privateKey: CryptoKey;
  let forgedPrivateKey: CryptoKey;
  let validToken: string;
  let currentUser: AuthenticatedUser = makeUser('STAFF');
  let sessionState: 'active' | 'inactive' = 'active';

  const userSession = {
    resolve: jest.fn(async () => {
      if (sessionState === 'inactive') throw new UserInactiveException();
      return currentUser;
    }),
  };

  const signToken = async (options: TokenOptions = {}): Promise<string> =>
    new SignJWT({ ...(options.payload ?? {}), role: options.role ?? 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? TEST_KEY_ID })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience(options.audience ?? 'authenticated')
      .setSubject(options.subject ?? TEST_SUBJECT)
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300)
      .sign(options.key ?? privateKey);

  beforeAll(async () => {
    const signingKeys = await generateKeyPair('ES256');
    const forgedKeys = await generateKeyPair('ES256');
    privateKey = signingKeys.privateKey;
    forgedPrivateKey = forgedKeys.privateKey;
    const publicJwk: JWK = {
      ...(await exportJWK(signingKeys.publicKey)),
      alg: 'ES256',
      kid: TEST_KEY_ID,
      use: 'sig',
    };

    jwksServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolveListen) => jwksServer.listen(0, '127.0.0.1', resolveListen));
    const address = jwksServer.address() as AddressInfo;
    const verifier = new JwtVerifierService(
      configForVerifier(`http://127.0.0.1:${address.port}/.well-known/jwks.json`),
    );

    const createModule = (includeFixtures: boolean) =>
      Test.createTestingModule({
        controllers: includeFixtures ? [RbacTestOnlyController] : [],
        imports: [AppModule, DiscoveryModule],
      })
        .overrideProvider(REDIS_CLIENT)
        .useValue({})
        .overrideProvider(RedisService)
        .useValue({ ping: jest.fn(async () => true) })
        .overrideProvider(PrismaService)
        .useValue({ ping: jest.fn(async () => true) })
        .overrideProvider(JwtVerifierService)
        .useValue(verifier)
        .overrideProvider(UserSessionService)
        .useValue(userSession)
        .overrideProvider(UsersService)
        .useValue(usersService)
        .overrideProvider(CategoriesService)
        .useValue(categoriesService)
        .overrideProvider(DepartmentsService)
        .useValue(departmentsService)
        .overrideProvider(LocationsService)
        .useValue(locationsService)
        .overrideProvider(MachinesService)
        .useValue(machinesService)
        .compile();

    const productionModule = await createModule(false);
    discovery = productionModule.get(DiscoveryService);
    productionPermissionGuard = productionModule.get(PermissionGuard);
    app = productionModule.createNestApplication({ bufferLogs: true });
    configureApplication(app);
    await app.init();

    const fixtureModule = await createModule(true);
    fixtureApp = fixtureModule.createNestApplication({ bufferLogs: true });
    configureApplication(fixtureApp);
    await fixtureApp.init();
    validToken = await signToken();
  });

  afterAll(async () => {
    await fixtureApp.close();
    await app.close();
    await new Promise<void>((resolveClose, reject) =>
      jwksServer.close((error) => (error === undefined ? resolveClose() : reject(error))),
    );
  });

  beforeEach(() => {
    currentUser = makeUser('STAFF');
    sessionState = 'active';
    jest.clearAllMocks();
    usersService.invite.mockImplementation(async () => managedUser);
    usersService.list.mockImplementation(async () => ({
      items: [managedUser],
      page: 1,
      pageSize: 25,
      total: 1,
    }));
    usersService.listDepartments.mockImplementation(async () => []);
    usersService.setActive.mockImplementation(async () => managedUser);
    usersService.update.mockImplementation(async () => managedUser);
  });

  const discoverProductionRoutes = (): InventoryRow[] => {
    const scanner = new MetadataScanner();
    const reflector = new Reflector();
    const routes: InventoryRow[] = [];

    for (const wrapper of discovery.getControllers()) {
      const controller = wrapper.metatype;
      const instance = wrapper.instance as object | null;
      if (controller === null || instance === null) continue;

      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      if (controllerPath === undefined) continue;

      for (const methodName of scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
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
        const declaration =
          declarations.length !== 1
            ? `invalid:${declarations.length}`
            : isPublic
              ? 'public'
              : isAuthenticatedOnly
                ? 'authenticated-only'
                : `permission:${String(permission)}`;
        const parts = [controllerPath, methodPath]
          .map((part) => part.replace(/^\/+|\/+$/g, ''))
          .filter((part) => part.length > 0);
        const route = `/${parts.join('/')}`;
        const method = RequestMethod[requestMethod] as HttpMethod;

        routes.push({
          declaration,
          method,
          route: controllerPath === 'health' ? route : `/api/v1${route}`,
        });
      }
    }

    routes.push(
      { declaration: 'infrastructure-public', method: 'GET', route: '/api/docs' },
      { declaration: 'infrastructure-public', method: 'GET', route: '/api/docs-json' },
    );
    return routes;
  };

  it('has exactly one independent access-table row for every production route', () => {
    const inventory = discoverProductionRoutes();
    const expectedKeys = EXPECTED_ACCESS_TABLE.map(routeKey);
    const inventoryKeys = inventory.map(routeKey);

    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
    expect(new Set(inventoryKeys).size).toBe(inventoryKeys.length);
    expect([...expectedKeys].sort()).toEqual([...inventoryKeys].sort());

    for (const expected of EXPECTED_ACCESS_TABLE) {
      const actual = inventory.find((candidate) => routeKey(candidate) === routeKey(expected));
      expect(actual?.declaration).toBe(expected.declaration);
    }
  });

  it('matches the hand-written role × production-route access table', async () => {
    let requestSequence = 0;

    for (const role of TEST_ROLES) {
      currentUser = makeUser(role);

      for (const row of EXPECTED_ACCESS_TABLE) {
        const expected = row.roles[role] as AccessExpectation;
        const response = await requestFor(app, row.method, row.route)
          .set('Authorization', `Bearer ${validToken}`)
          .set('x-request-id', `matrix-request-${(requestSequence += 1)}`);

        if (expected === 'ALLOW' || expected === 'SCOPED') {
          if (response.status !== row.successStatus) {
            throw new Error(
              `Access mismatch for ${role} ${row.method} ${row.route}: expected ${expected} (${row.successStatus}), received ${response.status}`,
            );
          }
        } else {
          try {
            expectExactError(
              response,
              403,
              'PERMISSION_DENIED',
              'You do not have permission to perform this action',
            );
          } catch (error: unknown) {
            throw new Error(
              `Access mismatch for ${role} ${row.method} ${row.route}: expected DENY, received ${response.status}`,
              { cause: error },
            );
          }
        }
      }
    }
  });

  it('matches the unauthenticated and inactive columns for every production route', async () => {
    for (const row of EXPECTED_ACCESS_TABLE) {
      const unauthenticated = await requestFor(app, row.method, row.route).set(
        'x-request-id',
        `unauthenticated-${row.method.toLowerCase()}`,
      );

      if (row.unauthenticated === 'ALLOW') {
        expect(unauthenticated.status).toBe(row.successStatus);
      } else {
        expectExactError(
          unauthenticated,
          401,
          'AUTH_INVALID',
          'Authentication credentials are invalid',
        );
      }

      sessionState = 'inactive';
      const inactive = await requestFor(app, row.method, row.route)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-request-id', `inactive-${row.method.toLowerCase()}`);
      sessionState = 'active';

      if (row.inactive === 'ALLOW') {
        expect(inactive.status).toBe(row.successStatus);
      } else {
        expectExactError(inactive, 403, 'USER_INACTIVE', 'User access is inactive');
      }
    }
  });

  it('enforces authentication, active state and permission before validation or resource reads', async () => {
    const guardSpy = jest.spyOn(productionPermissionGuard, 'canActivate');

    const unauthenticatedInvalid = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('x-request-id', 'ordering-unauthenticated-invalid')
      .send({});
    expectExactError(
      unauthenticatedInvalid,
      401,
      'AUTH_INVALID',
      'Authentication credentials are invalid',
    );

    const unauthenticatedMissing = await request(app.getHttpServer())
      .patch(`/api/v1/users/${TARGET_USER_ID}`)
      .set('x-request-id', 'ordering-unauthenticated-missing')
      .send({ fullName: 'Updated User' });
    expectExactError(
      unauthenticatedMissing,
      401,
      'AUTH_INVALID',
      'Authentication credentials are invalid',
    );

    sessionState = 'inactive';
    const inactiveInvalid = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-request-id', 'ordering-inactive-invalid')
      .send({});
    expectExactError(inactiveInvalid, 403, 'USER_INACTIVE', 'User access is inactive');
    sessionState = 'active';
    expect(guardSpy).not.toHaveBeenCalled();
    guardSpy.mockRestore();

    currentUser = makeUser('STAFF');
    const deniedInvalid = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-request-id', 'ordering-denied-invalid')
      .send({});
    expectExactError(
      deniedInvalid,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );

    const deniedMissing = await request(app.getHttpServer())
      .patch(`/api/v1/users/${TARGET_USER_ID}`)
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-request-id', 'ordering-denied-missing')
      .send({ fullName: 'Updated User' });
    expectExactError(
      deniedMissing,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );
    expect(usersService.invite).not.toHaveBeenCalled();
    expect(usersService.update).not.toHaveBeenCalled();

    currentUser = makeUser('ADMIN');
    const permittedInvalid = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${validToken}`)
      .send({})
      .expect(400);
    expect(permittedInvalid.body.error.code).toBe('VALIDATION_ERROR');

    usersService.update.mockRejectedValueOnce(new UserNotFoundException());
    const permittedMissing = await request(app.getHttpServer())
      .patch(`/api/v1/users/${TARGET_USER_ID}`)
      .set('Authorization', `Bearer ${validToken}`)
      .send({ fullName: 'Updated User' })
      .expect(404);
    expect(permittedMissing.body.error.code).toBe('USER_NOT_FOUND');

    usersService.invite.mockRejectedValueOnce(new UserAlreadyExistsException());
    const permittedConflict = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        email: 'managed-user@example.invalid',
        fullName: 'Managed User',
        role: 'STAFF',
      })
      .expect(409);
    expect(permittedConflict.body.error.code).toBe('USER_ALREADY_EXISTS');
    expect(usersService.update).toHaveBeenCalledTimes(1);
    expect(usersService.invite).toHaveBeenCalledTimes(1);
  });

  it('fails closed for unknown or missing roles and unknown permissions', async () => {
    currentUser = { ...makeUser('STAFF'), role: 'UNKNOWN_ROLE' as AuthenticatedUser['role'] };
    const unknownRole = await request(fixtureApp.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${validToken}`);
    expectExactError(
      unknownRole,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );

    currentUser = {
      ...makeUser('STAFF'),
      role: undefined as unknown as AuthenticatedUser['role'],
    };
    const missingRole = await request(fixtureApp.getHttpServer())
      .get('/api/v1/rbac-test-only/global')
      .set('Authorization', `Bearer ${validToken}`);
    expectExactError(
      missingRole,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );

    currentUser = makeUser('SUPER_ADMIN');
    const unknownPermission = await request(fixtureApp.getHttpServer())
      .get('/api/v1/rbac-test-only/unknown-permission')
      .set('Authorization', `Bearer ${validToken}`);
    expectExactError(
      unknownPermission,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );
  });

  it('enforces own-department scope including missing and departmentless resources', async () => {
    currentUser = makeUser('DEPT_MANAGER', DEPARTMENT_A);
    await request(fixtureApp.getHttpServer())
      .get(`/api/v1/rbac-test-only/department/${DEPARTMENT_A}`)
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);

    for (const route of [
      `/api/v1/rbac-test-only/department/${DEPARTMENT_B}`,
      '/api/v1/rbac-test-only/departmentless',
    ]) {
      const denied = await request(fixtureApp.getHttpServer())
        .get(route)
        .set('Authorization', `Bearer ${validToken}`);
      expectExactError(
        denied,
        403,
        'PERMISSION_DENIED',
        'You do not have permission to perform this action',
      );
    }

    currentUser = makeUser('DEPT_MANAGER', null);
    const noDepartment = await request(fixtureApp.getHttpServer())
      .get(`/api/v1/rbac-test-only/department/${DEPARTMENT_A}`)
      .set('Authorization', `Bearer ${validToken}`);
    expectExactError(
      noDepartment,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );

    currentUser = makeUser('ADMIN', null);
    await request(fixtureApp.getHttpServer())
      .get('/api/v1/rbac-test-only/departmentless')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);
  });

  it('rejects path, method and prefix bypass attempts without exposing handler data', async () => {
    const attempts = [
      ['trailing slash', () => request(app.getHttpServer()).get('/api/v1/users/'), [401]],
      ['upper-case path', () => request(app.getHttpServer()).get('/API/V1/USERS'), [401]],
      ['double slash', () => request(app.getHttpServer()).get('/api/v1//users'), [401, 404]],
      ['encoded slash', () => request(app.getHttpServer()).get('/api/v1%2Fusers'), [404]],
      ['HEAD for GET', () => request(app.getHttpServer()).head('/api/v1/users'), [401]],
      [
        'method override',
        () =>
          request(app.getHttpServer())
            .post('/api/v1/users')
            .set('X-HTTP-Method-Override', 'GET')
            .send({}),
        [401],
      ],
    ] as const;

    for (const [name, perform, expectedStatuses] of attempts) {
      const response = await perform();
      if (!expectedStatuses.includes(response.status as never)) {
        throw new Error(`${name} bypass returned unexpected HTTP ${response.status}`);
      }
      expect(JSON.stringify(response.body)).not.toContain('Managed User');
      if (response.status === 401 && name !== 'HEAD for GET') {
        expectExactError(response, 401, 'AUTH_INVALID', 'Authentication credentials are invalid');
      } else if (name === 'HEAD for GET') {
        expect(response.headers['x-request-id']).toEqual(expect.any(String));
        expect(response.text).toBeUndefined();
      }
    }

    await request(app.getHttpServer()).get('/users').expect(404);
    await request(app.getHttpServer()).post('/users').send({}).expect(404);
    expect(usersService.list).not.toHaveBeenCalled();
    expect(usersService.invite).not.toHaveBeenCalled();
  });

  it('allows preflight only for the configured web origin and returns no data', async () => {
    const configured = await request(app.getHttpServer())
      .options('/api/v1/users')
      .set('Access-Control-Request-Headers', 'authorization')
      .set('Access-Control-Request-Method', 'GET')
      .set('Origin', 'http://127.0.0.1:3000')
      .expect(204);
    expect(configured.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(configured.text).toBe('');

    const otherOrigin = await request(app.getHttpServer())
      .options('/api/v1/users')
      .set('Access-Control-Request-Headers', 'authorization')
      .set('Access-Control-Request-Method', 'GET')
      .set('Origin', 'https://untrusted.example.test')
      .expect(404);
    expect(otherOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(otherOrigin.body).not.toHaveProperty('data');
    expect(usersService.list).not.toHaveBeenCalled();
  });

  it('applies the database-backed active state and changed role, ignoring custom role claims', async () => {
    const claimToken = await signToken({
      payload: { app_role: 'ADMIN', user_metadata: { role: 'SUPER_ADMIN' } },
    });

    sessionState = 'inactive';
    const inactive = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${claimToken}`);
    expectExactError(inactive, 403, 'USER_INACTIVE', 'User access is inactive');

    sessionState = 'active';
    currentUser = makeUser('STAFF');
    const before = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${claimToken}`);
    expectExactError(
      before,
      403,
      'PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );

    currentUser = makeUser('ADMIN');
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${claimToken}`)
      .expect(200);
  });

  it('rejects token and Authorization-header abuse with one stable 401 response', async () => {
    const invalidTokens = [
      await signToken({ expiresAt: Math.floor(Date.now() / 1_000) - 60 }),
      await signToken({ key: forgedPrivateKey }),
      await signToken({ kid: 'unknown-key' }),
      await signToken({ issuer: 'https://wrong.example.test/auth/v1' }),
      await signToken({ audience: 'wrong-audience' }),
      await signToken({ role: 'anon' }),
      await signToken({ role: 'service_role' }),
      await signToken({ role: 'SUPER_ADMIN' }),
    ];

    for (const token of invalidTokens) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`);
      expectExactError(response, 401, 'AUTH_INVALID', 'Authentication credentials are invalid');
    }

    for (const authorization of [
      `Bearer ${validToken} ${validToken}`,
      `Basic ${validToken}`,
      `bearer ${validToken}`,
    ]) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', authorization);
      expectExactError(response, 401, 'AUTH_INVALID', 'Authentication credentials are invalid');
    }
  });

  it('returns an exact 503 envelope when the controlled JWKS verifier is unavailable', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(PrismaService)
      .useValue({ ping: jest.fn(async () => true) })
      .overrideProvider(JwtVerifierService)
      .useValue({
        verify: jest.fn(async () => {
          throw new AuthenticationUnavailableException();
        }),
      })
      .overrideProvider(UserSessionService)
      .useValue(userSession)
      .overrideProvider(UsersService)
      .useValue(usersService)
      .compile();
    const unavailableApp = moduleRef.createNestApplication({ bufferLogs: true });
    configureApplication(unavailableApp);
    await unavailableApp.init();

    try {
      const response = await request(unavailableApp.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-request-id', 'controlled-jwks-unavailable');
      expectExactError(
        response,
        503,
        'AUTH_UNAVAILABLE',
        'Authentication service is temporarily unavailable',
      );
    } finally {
      await unavailableApp.close();
    }
  });

  it('keeps Swagger public only outside production and excludes test controllers from production', async () => {
    const productionControllerNames = discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype?.name)
      .filter((name): name is string => name !== undefined);
    expect(productionControllerNames).not.toContain('RbacTestOnlyController');

    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ NODE_ENV: 'production', WEB_ORIGIN: 'http://127.0.0.1:3000' })[key],
          },
        },
      ],
    }).compile();
    const productionApp = moduleRef.createNestApplication();
    configureApplication(productionApp);
    await productionApp.init();

    try {
      await request(productionApp.getHttpServer()).get('/api/docs').expect(404);
      await request(productionApp.getHttpServer()).get('/api/docs-json').expect(404);
    } finally {
      await productionApp.close();
    }
  });

  if (task72IsComplete) {
    it('requires Task 7.2 to replace the cache-invalidation sentinel with a real next-request test', () => {
      throw new Error(
        'Task 7.2 is checked complete but the role/active-state cache invalidation test is still pending',
      );
    });
  } else {
    it.skip('PENDING Task 7.2: cached role or active-state changes apply on the next request', () => {
      // Task 7.2 must replace this sentinel with a real cache invalidation e2e test.
    });
  }
});
