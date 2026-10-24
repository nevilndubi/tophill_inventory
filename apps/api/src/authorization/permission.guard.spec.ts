import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { IS_PUBLIC_ROUTE } from '../auth/public.decorator';
import { IS_AUTHENTICATED_ONLY_ROUTE } from './authenticated-only.decorator';
import { PermissionDeniedException } from './permission-denied.exception';
import { PermissionGuard } from './permission.guard';
import { REQUIRED_PERMISSION } from './require-permission.decorator';

const activeUser: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role: 'STAFF',
};

type ContextOptions = {
  authenticatedOnly?: boolean;
  method?: string;
  permission?: unknown;
  publicRoute?: boolean;
  user?: AuthenticatedUser;
};

const contextFor = (options: ContextOptions): ExecutionContext => {
  class TestController {}
  const handler = () => undefined;

  if (options.authenticatedOnly !== undefined) {
    Reflect.defineMetadata(IS_AUTHENTICATED_ONLY_ROUTE, options.authenticatedOnly, handler);
  }
  if (options.permission !== undefined) {
    Reflect.defineMetadata(REQUIRED_PERMISSION, options.permission, handler);
  }
  if (options.publicRoute !== undefined) {
    Reflect.defineMetadata(IS_PUBLIC_ROUTE, options.publicRoute, handler);
  }

  const request = {
    headers: {},
    method: options.method ?? 'GET',
    originalUrl: '/api/v1/test',
    requestId: 'permission-test-request',
    user: options.user,
  } as unknown as AuthenticatedRequest;

  return {
    getClass: () => TestController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

describe(PermissionGuard.name, () => {
  const guard = new PermissionGuard(new Reflector());

  it('allows public routes and preflight requests without authorization metadata', () => {
    expect(guard.canActivate(contextFor({ publicRoute: true }))).toBe(true);
    expect(guard.canActivate(contextFor({ method: 'OPTIONS' }))).toBe(true);
  });

  it('allows an explicitly authenticated-only route for an active local user', () => {
    expect(guard.canActivate(contextFor({ authenticatedOnly: true, user: activeUser }))).toBe(true);
  });

  it('allows a documented permission and rejects a denied permission', () => {
    expect(guard.canActivate(contextFor({ permission: 'booking:create', user: activeUser }))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor({ permission: 'booking:approve', user: activeUser })),
    ).toThrow(PermissionDeniedException);
  });

  it.each([
    ['missing route metadata', { user: activeUser }],
    ['missing user', { authenticatedOnly: true }],
    ['missing role', { permission: 'machine:read', user: { ...activeUser, role: undefined } }],
    ['unknown role', { permission: 'machine:read', user: { ...activeUser, role: 'UNKNOWN' } }],
    ['unknown permission', { permission: 'unknown:permission', user: activeUser }],
  ])('fails closed for %s', (_name, options) => {
    expect(() => guard.canActivate(contextFor(options as ContextOptions))).toThrow(
      PermissionDeniedException,
    );
  });
});
