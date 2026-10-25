export const APP_NAME = 'Tophill Inventory' as const;

export {
  AUDIT_ACTIONS,
  auditActionSchema,
  NOTIFICATION_TYPES,
  notificationTypeSchema,
  openEventTypeSchema,
  type AuditAction,
  type NotificationType,
} from './event-types';

export {
  can,
  canAssignRole,
  canDeactivateUser,
  canManageUser,
  getPermissionScope,
  isAppRole,
  isLastActiveSuperAdmin,
  isPermission,
  PERMISSIONS,
  PERMISSION_SCOPES,
  ROLE_PERMISSIONS,
  ROLES,
  type AppRole,
  type DeactivationFacts,
  type Permission,
  type PermissionMatrix,
  type PermissionScope,
} from './permissions';

export {
  inviteUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamsSchema,
  USER_PAGE_SIZE_DEFAULT,
  USER_PAGE_SIZE_MAX,
  type InviteUserInput,
  type ListUsersQuery,
  type ManagedDepartment,
  type ManagedUser,
  type ManagedUserPage,
  type UpdateUserInput,
} from './user-management';
