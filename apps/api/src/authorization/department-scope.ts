import { getPermissionScope, type Permission } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from './permission-denied.exception';

export type AuthorizationResourceContext = {
  readonly isOwner?: boolean;
};

export type DepartmentScopeFilter = Readonly<{
  departmentId?: string;
}>;

export const assertDepartmentAccess = (
  user: AuthenticatedUser,
  resourceDepartmentId: string | null | undefined,
  _context: AuthorizationResourceContext = {},
): void => {
  if (
    user.role !== 'DEPT_MANAGER' ||
    user.department === null ||
    resourceDepartmentId === null ||
    resourceDepartmentId === undefined ||
    user.department.id !== resourceDepartmentId
  ) {
    throw new PermissionDeniedException();
  }
};

export const departmentScopeFilter = (
  user: AuthenticatedUser,
  permission: Permission,
  _context: AuthorizationResourceContext = {},
): DepartmentScopeFilter => {
  const scope = getPermissionScope(user.role, permission);

  if (scope === 'GLOBAL') {
    return {};
  }

  if (scope === 'OWN_DEPARTMENT' && user.department !== null) {
    return { departmentId: user.department.id };
  }

  throw new PermissionDeniedException();
};
