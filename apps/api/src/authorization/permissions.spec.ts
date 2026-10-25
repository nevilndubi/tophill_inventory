import {
  can,
  canAssignRole,
  canDeactivateUser,
  canManageUser,
  getPermissionScope,
  isLastActiveSuperAdmin,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type AppRole,
  type Permission,
  type PermissionMatrix,
} from '@app/shared';
import { Role as PrismaRole } from '../generated/prisma/enums';

const expectedMatrix = {
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

describe('shared role permissions', () => {
  it('matches the independently transcribed Architecture section 7 matrix in both directions', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.keys(expectedMatrix).sort());

    for (const role of ROLES) {
      expect(Object.keys(ROLE_PERMISSIONS[role]).sort()).toEqual(
        Object.keys(expectedMatrix[role]).sort(),
      );

      for (const permission of PERMISSIONS) {
        const expectedScope = expectedMatrix[role][permission];

        expect(getPermissionScope(role, permission)).toBe(expectedScope);
        expect(can(role, permission)).toBe(expectedScope !== 'NONE');
      }
    }
  });

  it('uses exactly the Prisma Role enum values', () => {
    expect([...ROLES].sort()).toEqual(Object.values(PrismaRole).sort());
  });

  it('matches the independent role-assignment matrix for every role pair', () => {
    const expectedAssignableRoles = {
      SUPER_ADMIN: [...ROLES],
      ADMIN: ['ADMIN', 'BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'],
      BIOMED_TECH: [],
      DEPT_MANAGER: [],
      STAFF: [],
      VIEWER: [],
    } as const satisfies Record<AppRole, readonly AppRole[]>;

    for (const actorRole of ROLES) {
      for (const targetRole of ROLES) {
        expect(canAssignRole(actorRole, targetRole)).toBe(
          expectedAssignableRoles[actorRole].some((role) => role === targetRole),
        );
      }
    }
  });

  it('protects self-deactivation and the final active SUPER_ADMIN', () => {
    expect(
      canDeactivateUser({
        activeSuperAdminCount: 2,
        actorId: 'same-user',
        actorRole: 'SUPER_ADMIN',
        targetId: 'same-user',
        targetIsActive: true,
        targetRole: 'SUPER_ADMIN',
      }),
    ).toBe(false);
    expect(
      isLastActiveSuperAdmin({
        activeSuperAdminCount: 1,
        targetIsActive: true,
        targetRole: 'SUPER_ADMIN',
      }),
    ).toBe(true);
    expect(
      canDeactivateUser({
        activeSuperAdminCount: 2,
        actorId: 'actor',
        actorRole: 'SUPER_ADMIN',
        targetId: 'target',
        targetIsActive: true,
        targetRole: 'SUPER_ADMIN',
      }),
    ).toBe(true);
    expect(
      canDeactivateUser({
        activeSuperAdminCount: 2,
        actorId: 'actor',
        actorRole: 'ADMIN',
        targetId: 'target',
        targetIsActive: true,
        targetRole: 'SUPER_ADMIN',
      }),
    ).toBe(false);
  });

  it('matches the independent user-management target matrix for every role pair', () => {
    const expectedManageableTargets = {
      SUPER_ADMIN: [...ROLES],
      ADMIN: ['ADMIN', 'BIOMED_TECH', 'DEPT_MANAGER', 'STAFF', 'VIEWER'],
      BIOMED_TECH: [],
      DEPT_MANAGER: [],
      STAFF: [],
      VIEWER: [],
    } as const satisfies Record<AppRole, readonly AppRole[]>;

    for (const actorRole of ROLES) {
      for (const targetRole of ROLES) {
        expect(canManageUser(actorRole, targetRole)).toBe(
          expectedManageableTargets[actorRole].some((role) => role === targetRole),
        );
      }
    }
  });

  it('keeps permission names a closed typed set', () => {
    const allPermissions: readonly Permission[] = PERMISSIONS;
    expect(new Set(allPermissions).size).toBe(allPermissions.length);
  });
});
