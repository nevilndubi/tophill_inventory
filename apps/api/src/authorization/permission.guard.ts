import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getPermissionScope, isAppRole, isPermission } from '@app/shared';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { IS_PUBLIC_ROUTE } from '../auth/public.decorator';
import { IS_AUTHENTICATED_ONLY_ROUTE } from './authenticated-only.decorator';
import { PermissionDeniedException } from './permission-denied.exception';
import { REQUIRED_PERMISSION } from './require-permission.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const handler = context.getHandler();
    const controller = context.getClass();

    if (
      request.method === 'OPTIONS' ||
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [handler, controller]) === true
    ) {
      return true;
    }

    const authenticatedOnly =
      this.reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_ONLY_ROUTE, [
        handler,
        controller,
      ]) === true;
    const permission = this.reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSION, [
      handler,
      controller,
    ]);
    const user = request.user;

    request.authorizationContext = {
      permission: isPermission(permission) ? permission : 'undeclared',
    };

    if (permission === undefined && authenticatedOnly && user?.isActive === true) {
      return true;
    }

    if (user?.isActive === true && isAppRole(user.role) && isPermission(permission)) {
      const scope = getPermissionScope(user.role, permission);

      if (scope !== 'NONE') {
        request.authorizationContext.scope = scope;
        return true;
      }
    }

    throw new PermissionDeniedException();
  }
}
