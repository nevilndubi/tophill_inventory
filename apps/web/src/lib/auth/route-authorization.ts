import type { AppRole, Permission } from '@app/shared';
import { can } from '@app/shared';

export const permissionFailureDestination = (
  role: AppRole,
  permission: Permission,
): '/forbidden' | null => (can(role, permission) ? null : '/forbidden');
