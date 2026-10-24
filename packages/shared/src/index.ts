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
