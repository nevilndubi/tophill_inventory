import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canAssignRole,
  canDeactivateUser,
  canManageUser,
  isLastActiveSuperAdmin,
  type AppRole,
  type InviteUserInput,
  type ListUsersQuery,
  type ManagedDepartment,
  type ManagedUser,
  type ManagedUserPage,
  type UpdateUserInput,
} from '@app/shared';
import type { ApiEnvironment } from '../config/env';
import type { Prisma, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  SupabaseAdminRequestError,
  SupabaseAdminService,
  SupabaseIdentityExistsError,
} from '../auth/supabase-admin.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthIdentityExistsException,
  DepartmentNotFoundException,
  LastSuperAdminException,
  OrphanedAuthIdentityException,
  SeedUserProtectedException,
  UserAlreadyExistsException,
  UserManagementDeniedException,
  UserManagementUnavailableException,
  UserNotFoundException,
} from './users.errors';

const managedUserSelection = {
  department: { select: { code: true, id: true, name: true } },
  email: true,
  fullName: true,
  id: true,
  isActive: true,
  isSeedData: true,
  lastLoginAt: true,
  role: true,
} satisfies Prisma.UserSelect;

type LocalManagedUser = Prisma.UserGetPayload<{ select: typeof managedUserSelection }>;
type UserState = { departmentId: string | null; isActive: boolean; role: Role };

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const toManagedUser = (user: LocalManagedUser): ManagedUser => ({
  department: user.department,
  email: user.email,
  fullName: user.fullName,
  id: user.id,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  role: user.role,
});

const stateOf = (user: UserState): Prisma.InputJsonObject => ({
  departmentId: user.departmentId,
  isActive: user.isActive,
  role: user.role,
});

@Injectable()
export class UsersService {
  private readonly inviteRedirectTo: string;
  private readonly logger = new Logger(UsersService.name);

  constructor(
    config: ConfigService<ApiEnvironment, true>,
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly audit: AuditService,
  ) {
    this.inviteRedirectTo = `${config.get('WEB_ORIGIN', { infer: true }).replace(/\/$/, '')}/auth/confirm`;
  }

  async list(query: ListUsersQuery): Promise<ManagedUserPage> {
    const where: Prisma.UserWhereInput = {
      isSeedData: false,
      ...(query.active === undefined ? {} : { isActive: query.active }),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: escapeLike(query.search), mode: 'insensitive' } },
              { fullName: { contains: escapeLike(query.search), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        select: managedUserSelection,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: items.map(toManagedUser), page: query.page, pageSize: query.pageSize, total };
  }

  async listDepartments(): Promise<readonly ManagedDepartment[]> {
    return this.prisma.department.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { code: true, id: true, name: true },
    });
  }

  async invite(
    actor: AuthenticatedUser,
    input: InviteUserInput,
    requestId: string,
  ): Promise<ManagedUser> {
    if (!canAssignRole(actor.role, input.role)) {
      throw new UserManagementDeniedException('ROLE_ASSIGNMENT_DENIED');
    }
    await this.assertDepartment(input.departmentId ?? null, input.role);

    const local = await this.prisma.user.findFirst({
      select: { id: true },
      where: { email: { equals: input.email, mode: 'insensitive' } },
    });
    if (local !== null) throw new UserAlreadyExistsException();

    try {
      if ((await this.supabaseAdmin.findUserIdByEmail(input.email)) !== null) {
        throw new AuthIdentityExistsException();
      }
    } catch (error: unknown) {
      if (error instanceof AuthIdentityExistsException) throw error;
      if (error instanceof SupabaseAdminRequestError)
        throw new UserManagementUnavailableException();
      throw error;
    }

    let createdIdentity: { id: string };
    try {
      createdIdentity = await this.supabaseAdmin.inviteUserByEmail(
        input.email,
        input.fullName,
        this.inviteRedirectTo,
      );
    } catch (error: unknown) {
      if (error instanceof SupabaseIdentityExistsError) {
        throw new AuthIdentityExistsException();
      }
      throw new UserManagementUnavailableException();
    }

    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            departmentId: input.departmentId ?? null,
            email: input.email,
            fullName: input.fullName,
            isActive: true,
            isSeedData: false,
            role: input.role,
            supabaseUserId: createdIdentity.id,
          },
          select: managedUserSelection,
        });
        await this.audit.record(transaction, {
          action: 'user.invited',
          actorUserId: actor.id,
          after: stateOf({
            departmentId: input.departmentId ?? null,
            isActive: true,
            role: input.role,
          }),
          entityId: user.id,
          requestId,
        });
        return user;
      });
      return toManagedUser(created);
    } catch (error: unknown) {
      const compensated = await this.supabaseAdmin.deleteUser(createdIdentity.id);
      if (!compensated) {
        this.logger.error(
          { code: 'ORPHANED_AUTH_IDENTITY', supabaseUserId: createdIdentity.id },
          'Invitation compensation failed',
        );
        throw new OrphanedAuthIdentityException();
      }
      if (isUniqueViolation(error)) throw new UserAlreadyExistsException();
      throw new UserManagementUnavailableException();
    }
  }

  async update(
    actor: AuthenticatedUser,
    userId: string,
    input: UpdateUserInput,
    requestId: string,
  ): Promise<ManagedUser> {
    return this.prisma.$transaction(async (transaction) => {
      const lockedAdmins = await this.lockActiveSuperAdmins(transaction);
      await transaction.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const target = await transaction.user.findUnique({
        select: { ...managedUserSelection, departmentId: true },
        where: { id: userId },
      });
      this.assertManageable(actor, target);

      if (actor.id === userId && (input.role !== undefined || input.departmentId !== undefined)) {
        throw new UserManagementDeniedException(
          'SELF_ROLE_OR_DEPARTMENT_CHANGE',
          'You cannot change your own role or department',
        );
      }

      const nextRole = input.role ?? target.role;
      const nextDepartmentId =
        input.departmentId === undefined ? target.departmentId : input.departmentId;
      if (input.role !== undefined && !canAssignRole(actor.role, input.role)) {
        throw new UserManagementDeniedException('ROLE_ASSIGNMENT_DENIED');
      }
      await this.assertDepartment(nextDepartmentId, nextRole, transaction);

      if (
        target.role === 'SUPER_ADMIN' &&
        target.isActive &&
        nextRole !== 'SUPER_ADMIN' &&
        isLastActiveSuperAdmin({
          activeSuperAdminCount: lockedAdmins.length,
          targetIsActive: target.isActive,
          targetRole: target.role,
        })
      ) {
        throw new LastSuperAdminException();
      }

      const before = stateOf(target);
      const updated = await transaction.user.update({
        data: {
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
          ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
          ...(input.role === undefined ? {} : { role: input.role }),
        },
        select: { ...managedUserSelection, departmentId: true },
        where: { id: userId },
      });
      const after = stateOf(updated);

      if (
        target.role === 'DEPT_MANAGER' &&
        (updated.role !== 'DEPT_MANAGER' || updated.departmentId !== target.departmentId)
      ) {
        await this.clearManagedDepartments(transaction, actor, target.id, requestId);
      }

      if (target.role !== updated.role) {
        await this.audit.record(transaction, {
          action: 'user.role_changed',
          actorUserId: actor.id,
          after,
          before,
          entityId: userId,
          requestId,
        });
      }
      if (target.departmentId !== updated.departmentId) {
        await this.audit.record(transaction, {
          action: 'user.department_changed',
          actorUserId: actor.id,
          after,
          before,
          entityId: userId,
          requestId,
        });
      }
      if (input.fullName !== undefined && input.fullName !== target.fullName) {
        await this.audit.record(transaction, {
          action: 'user.updated',
          actorUserId: actor.id,
          after,
          before,
          entityId: userId,
          requestId,
        });
      }
      return toManagedUser(updated);
    });
  }

  async setActive(
    actor: AuthenticatedUser,
    userId: string,
    isActive: boolean,
    requestId: string,
  ): Promise<ManagedUser> {
    return this.prisma.$transaction(async (transaction) => {
      const lockedAdmins = await this.lockActiveSuperAdmins(transaction);
      await transaction.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const target = await transaction.user.findUnique({
        select: { ...managedUserSelection, departmentId: true },
        where: { id: userId },
      });
      this.assertManageable(actor, target);
      if (!isActive && actor.id === userId) {
        throw new UserManagementDeniedException(
          'SELF_DEACTIVATION_DENIED',
          'You cannot deactivate your own account',
        );
      }
      if (
        !isActive &&
        !canDeactivateUser({
          activeSuperAdminCount: lockedAdmins.length,
          actorId: actor.id,
          actorRole: actor.role,
          targetId: target.id,
          targetIsActive: target.isActive,
          targetRole: target.role,
        })
      ) {
        if (
          isLastActiveSuperAdmin({
            activeSuperAdminCount: lockedAdmins.length,
            targetIsActive: target.isActive,
            targetRole: target.role,
          })
        ) {
          throw new LastSuperAdminException();
        }
        throw new UserManagementDeniedException('USER_DEACTIVATION_DENIED');
      }
      if (target.isActive === isActive) return toManagedUser(target);

      const before = stateOf(target);
      const updated = await transaction.user.update({
        data: { isActive },
        select: { ...managedUserSelection, departmentId: true },
        where: { id: userId },
      });
      if (!updated.isActive) {
        await this.clearManagedDepartments(transaction, actor, target.id, requestId);
      }
      await this.audit.record(transaction, {
        action: isActive ? 'user.reactivated' : 'user.deactivated',
        actorUserId: actor.id,
        after: stateOf(updated),
        before,
        entityId: userId,
        requestId,
      });
      return toManagedUser(updated);
    });
  }

  private assertManageable(
    actor: AuthenticatedUser,
    target: (LocalManagedUser & { departmentId: string | null }) | null,
  ): asserts target is LocalManagedUser & { departmentId: string | null } {
    if (target === null) throw new UserNotFoundException();
    if (target.isSeedData) throw new SeedUserProtectedException();
    if (!canManageUser(actor.role, target.role)) {
      throw new UserManagementDeniedException('SUPER_ADMIN_PROTECTED');
    }
  }

  private async assertDepartment(
    departmentId: string | null,
    role: AppRole,
    transaction: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (role === 'DEPT_MANAGER' && departmentId === null) {
      throw new DepartmentNotFoundException();
    }
    if (departmentId === null) return;
    const department = await transaction.department.findUnique({
      select: { id: true },
      where: { id: departmentId },
    });
    if (department === null) throw new DepartmentNotFoundException();
  }

  private lockActiveSuperAdmins(transaction: Prisma.TransactionClient) {
    return transaction.$queryRaw<readonly { id: string }[]>`
      SELECT id
      FROM users
      WHERE role = 'SUPER_ADMIN'::user_role
        AND is_active = true
        AND is_seed_data = false
      ORDER BY id
      FOR UPDATE
    `;
  }

  private async clearManagedDepartments(
    transaction: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    managerUserId: string,
    requestId: string,
  ): Promise<void> {
    const departments = await transaction.department.findMany({
      select: { code: true, id: true, managerUserId: true, name: true },
      where: { managerUserId },
    });
    for (const department of departments) {
      await transaction.department.update({
        data: { managerUserId: null },
        where: { id: department.id },
      });
      await this.audit.record(transaction, {
        action: 'department.manager_cleared',
        actorUserId: actor.id,
        after: { code: department.code, managerUserId: null, name: department.name },
        before: { code: department.code, managerUserId, name: department.name },
        entityId: department.id,
        entityType: 'department',
        requestId,
      });
    }
  }
}
