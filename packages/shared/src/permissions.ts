export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'BIOMED_TECH',
  'DEPT_MANAGER',
  'STAFF',
  'VIEWER',
] as const;

export type AppRole = (typeof ROLES)[number];

export const PERMISSIONS = [
  'machine:read',
  'machine:create',
  'machine:update',
  'machine:retire',
  'reference:manage',
  'booking:create',
  'booking:approve',
  'usage:check-in-out',
  'usage:force-end',
  'fault:report',
  'service:manage',
  'user:manage',
  'audit:read',
  'report:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SCOPES = ['GLOBAL', 'OWN_DEPARTMENT', 'NONE'] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export type PermissionMatrix = {
  readonly [Role in AppRole]: {
    readonly [Capability in Permission]: PermissionScope;
  };
};

export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: {
    'machine:read': 'GLOBAL',
    'machine:create': 'GLOBAL',
    'machine:update': 'GLOBAL',
    'machine:retire': 'GLOBAL',
    'reference:manage': 'GLOBAL',
    'booking:create': 'GLOBAL',
    'booking:approve': 'GLOBAL',
    'usage:check-in-out': 'GLOBAL',
    'usage:force-end': 'GLOBAL',
    'fault:report': 'GLOBAL',
    'service:manage': 'GLOBAL',
    'user:manage': 'GLOBAL',
    'audit:read': 'GLOBAL',
    'report:read': 'GLOBAL',
  },
  ADMIN: {
    'machine:read': 'GLOBAL',
    'machine:create': 'GLOBAL',
    'machine:update': 'GLOBAL',
    'machine:retire': 'GLOBAL',
    'reference:manage': 'GLOBAL',
    'booking:create': 'GLOBAL',
    'booking:approve': 'GLOBAL',
    'usage:check-in-out': 'GLOBAL',
    'usage:force-end': 'GLOBAL',
    'fault:report': 'GLOBAL',
    'service:manage': 'GLOBAL',
    'user:manage': 'GLOBAL',
    'audit:read': 'GLOBAL',
    'report:read': 'GLOBAL',
  },
  BIOMED_TECH: {
    'machine:read': 'GLOBAL',
    'machine:create': 'NONE',
    'machine:update': 'GLOBAL',
    'machine:retire': 'NONE',
    'reference:manage': 'NONE',
    'booking:create': 'GLOBAL',
    'booking:approve': 'NONE',
    'usage:check-in-out': 'GLOBAL',
    'usage:force-end': 'NONE',
    'fault:report': 'GLOBAL',
    'service:manage': 'GLOBAL',
    'user:manage': 'NONE',
    'audit:read': 'NONE',
    'report:read': 'GLOBAL',
  },
  DEPT_MANAGER: {
    'machine:read': 'GLOBAL',
    'machine:create': 'NONE',
    'machine:update': 'NONE',
    'machine:retire': 'NONE',
    'reference:manage': 'NONE',
    'booking:create': 'GLOBAL',
    'booking:approve': 'OWN_DEPARTMENT',
    'usage:check-in-out': 'GLOBAL',
    'usage:force-end': 'OWN_DEPARTMENT',
    'fault:report': 'GLOBAL',
    'service:manage': 'NONE',
    'user:manage': 'NONE',
    'audit:read': 'NONE',
    'report:read': 'OWN_DEPARTMENT',
  },
  STAFF: {
    'machine:read': 'GLOBAL',
    'machine:create': 'NONE',
    'machine:update': 'NONE',
    'machine:retire': 'NONE',
    'reference:manage': 'NONE',
    'booking:create': 'GLOBAL',
    'booking:approve': 'NONE',
    'usage:check-in-out': 'GLOBAL',
    'usage:force-end': 'NONE',
    'fault:report': 'GLOBAL',
    'service:manage': 'NONE',
    'user:manage': 'NONE',
    'audit:read': 'NONE',
    'report:read': 'NONE',
  },
  VIEWER: {
    'machine:read': 'GLOBAL',
    'machine:create': 'NONE',
    'machine:update': 'NONE',
    'machine:retire': 'NONE',
    'reference:manage': 'NONE',
    'booking:create': 'NONE',
    'booking:approve': 'NONE',
    'usage:check-in-out': 'NONE',
    'usage:force-end': 'NONE',
    'fault:report': 'NONE',
    'service:manage': 'NONE',
    'user:manage': 'NONE',
    'audit:read': 'NONE',
    'report:read': 'GLOBAL',
  },
} as const satisfies PermissionMatrix;

const roleSet: ReadonlySet<string> = new Set(ROLES);
const permissionSet: ReadonlySet<string> = new Set(PERMISSIONS);

export const isAppRole = (value: unknown): value is AppRole =>
  typeof value === 'string' && roleSet.has(value);

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && permissionSet.has(value);

export const getPermissionScope = (role: AppRole, permission: Permission): PermissionScope =>
  ROLE_PERMISSIONS[role][permission];

export const can = (role: AppRole, permission: Permission): boolean =>
  getPermissionScope(role, permission) !== 'NONE';

export const canAssignRole = (actorRole: AppRole, targetRole: AppRole): boolean =>
  actorRole === 'SUPER_ADMIN' || (actorRole === 'ADMIN' && targetRole !== 'SUPER_ADMIN');

export const canManageUser = (actorRole: AppRole, targetRole: AppRole): boolean =>
  actorRole === 'SUPER_ADMIN' || (actorRole === 'ADMIN' && targetRole !== 'SUPER_ADMIN');

export type DeactivationFacts = {
  activeSuperAdminCount: number;
  actorId: string;
  actorRole: AppRole;
  targetId: string;
  targetIsActive: boolean;
  targetRole: AppRole;
};

export const isLastActiveSuperAdmin = ({
  activeSuperAdminCount,
  targetIsActive,
  targetRole,
}: Pick<DeactivationFacts, 'activeSuperAdminCount' | 'targetIsActive' | 'targetRole'>): boolean =>
  targetRole === 'SUPER_ADMIN' && targetIsActive && activeSuperAdminCount <= 1;

export const canDeactivateUser = (facts: DeactivationFacts): boolean =>
  facts.actorId !== facts.targetId &&
  canAssignRole(facts.actorRole, facts.targetRole) &&
  !isLastActiveSuperAdmin(facts);
