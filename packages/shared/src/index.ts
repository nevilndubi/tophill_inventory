export const APP_NAME = 'Tophill Inventory' as const;

export {
  categoryIdParamsSchema,
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type ManagedCategory,
  type UpdateCategoryInput,
} from './category-management';

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
  createDepartmentSchema,
  createLocationSchema,
  departmentIdParamsSchema,
  listLocationsQuerySchema,
  locationIdParamsSchema,
  updateDepartmentSchema,
  updateLocationSchema,
  type CreateDepartmentInput,
  type CreateLocationInput,
  type DepartmentSummary,
  type EligibleManager,
  type ListLocationsQuery,
  type ManagedDepartmentReference,
  type ManagedLocation,
  type ManagedLocationPage,
  type UpdateDepartmentInput,
  type UpdateLocationInput,
} from './reference-management';

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
