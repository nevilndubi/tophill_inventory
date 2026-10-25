import { Injectable } from '@nestjs/common';
import type {
  CreateDepartmentInput,
  EligibleManager,
  ManagedDepartmentReference,
  UpdateDepartmentInput,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DepartmentCodeTakenException,
  DepartmentInUseException,
  DepartmentNameTakenException,
  DepartmentNotFoundException,
  ManagerNotEligibleException,
  UserNotFoundException,
} from './reference.errors';

type DepartmentRow = {
  code: string;
  id: string;
  locationCount: number;
  machineCount: number;
  managerFullName: string | null;
  managerId: string | null;
  name: string;
  userCount: number;
};
type DepartmentState = { code: string; managerUserId: string | null; name: string };

const isPrismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const stateOf = (value: DepartmentState): Prisma.InputJsonObject => ({
  code: value.code,
  managerUserId: value.managerUserId,
  name: value.name,
});
const toManaged = (row: DepartmentRow): ManagedDepartmentReference => ({
  code: row.code,
  id: row.id,
  is_deletable: row.locationCount === 0 && row.machineCount === 0 && row.userCount === 0,
  location_count: row.locationCount,
  machine_count: row.machineCount,
  manager:
    row.managerId === null || row.managerFullName === null
      ? null
      : { full_name: row.managerFullName, id: row.managerId },
  name: row.name,
  user_count: row.userCount,
});

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  read(): Promise<readonly ManagedDepartmentReference[]>;
  read(id: string): Promise<ManagedDepartmentReference>;
  async read(
    id?: string,
  ): Promise<readonly ManagedDepartmentReference[] | ManagedDepartmentReference> {
    const rows = await this.prisma.$queryRaw<DepartmentRow[]>`
      SELECT department.id, department.name, department.code,
        manager.id AS "managerId", manager.full_name AS "managerFullName",
        count(DISTINCT member.id)::integer AS "userCount",
        count(DISTINCT location.id)::integer AS "locationCount",
        count(DISTINCT machine.id)::integer AS "machineCount"
      FROM departments department
      LEFT JOIN users manager ON manager.id = department.manager_user_id
      LEFT JOIN users member ON member.department_id = department.id
      LEFT JOIN locations location ON location.department_id = department.id
      LEFT JOIN machines machine ON machine.department_id = department.id
      WHERE (${id ?? null}::uuid IS NULL OR department.id = ${id ?? null}::uuid)
      GROUP BY department.id, manager.id
      ORDER BY lower(department.name), department.id
    `;
    if (id === undefined) return rows.map(toManaged);
    const row = rows[0];
    if (!row) throw new DepartmentNotFoundException();
    return toManaged(row);
  }

  async eligibleManagers(id: string): Promise<readonly EligibleManager[]> {
    if ((await this.prisma.department.count({ where: { id } })) === 0) {
      throw new DepartmentNotFoundException();
    }
    const rows = await this.prisma.user.findMany({
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      select: { fullName: true, id: true },
      where: { departmentId: id, isActive: true, isSeedData: false, role: 'DEPT_MANAGER' },
    });
    return rows.map((user) => ({ full_name: user.fullName, id: user.id }));
  }

  async create(actor: AuthenticatedUser, input: CreateDepartmentInput, requestId: string) {
    try {
      const id = await this.prisma.$transaction(async (transaction) => {
        const department = await transaction.department.create({ data: input });
        if (input.managerUserId)
          await this.assertEligibleManager(transaction, department.id, input.managerUserId);
        await this.audit.record(transaction, {
          action: 'department.created',
          actorUserId: actor.id,
          after: stateOf(department),
          entityId: department.id,
          entityType: 'department',
          requestId,
        });
        return department.id;
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) throw await this.uniqueError(input.name);
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDepartmentInput,
    requestId: string,
  ) {
    try {
      await this.prisma.$transaction(async (transaction) => {
        const before = await transaction.department.findUnique({ where: { id } });
        if (!before) throw new DepartmentNotFoundException();
        const managerChanges =
          input.managerUserId !== undefined && input.managerUserId !== before.managerUserId;
        if (managerChanges && input.managerUserId !== null && input.managerUserId !== undefined) {
          await this.assertEligibleManager(transaction, id, input.managerUserId);
        }
        const after = await transaction.department.update({ data: input, where: { id } });
        await this.audit.record(transaction, {
          action: managerChanges ? 'department.manager_changed' : 'department.updated',
          actorUserId: actor.id,
          after: stateOf(after),
          before: stateOf(before),
          entityId: id,
          entityType: 'department',
          requestId,
        });
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) {
        const current = await this.prisma.department.findUnique({ where: { id } });
        throw await this.uniqueError(input.name ?? current?.name ?? '', id);
      }
      throw error;
    }
  }

  async delete(actor: AuthenticatedUser, id: string, requestId: string) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<DepartmentState[]>`
          SELECT name, code, manager_user_id AS "managerUserId" FROM departments WHERE id = ${id}::uuid FOR UPDATE
        `;
        const before = locked[0];
        if (!before) throw new DepartmentNotFoundException();
        const [userCount, locationCount, machineCount] = await Promise.all([
          transaction.user.count({ where: { departmentId: id } }),
          transaction.location.count({ where: { departmentId: id } }),
          transaction.machine.count({ where: { departmentId: id } }),
        ]);
        if (userCount + locationCount + machineCount > 0) {
          throw new DepartmentInUseException({
            location_count: locationCount,
            machine_count: machineCount,
            user_count: userCount,
          });
        }
        await transaction.department.delete({ where: { id } });
        await this.audit.record(transaction, {
          action: 'department.deleted',
          actorUserId: actor.id,
          before: stateOf(before),
          entityId: id,
          entityType: 'department',
          requestId,
        });
        return {
          ...toManaged({
            ...before,
            id,
            locationCount: 0,
            machineCount: 0,
            managerFullName: null,
            managerId: before.managerUserId,
            userCount: 0,
          }),
          manager: null,
        };
      });
    } catch (error: unknown) {
      if (error instanceof DepartmentInUseException || error instanceof DepartmentNotFoundException)
        throw error;
      if (isPrismaError(error, 'P2003')) {
        const [userCount, locationCount, machineCount] = await Promise.all([
          this.prisma.user.count({ where: { departmentId: id } }),
          this.prisma.location.count({ where: { departmentId: id } }),
          this.prisma.machine.count({ where: { departmentId: id } }),
        ]);
        throw new DepartmentInUseException({
          location_count: locationCount,
          machine_count: machineCount,
          user_count: userCount,
        });
      }
      throw error;
    }
  }

  private async assertEligibleManager(
    transaction: Prisma.TransactionClient,
    departmentId: string,
    userId: string,
  ) {
    const rows = await transaction.$queryRaw<
      readonly {
        departmentId: string | null;
        isActive: boolean;
        isSeedData: boolean;
        role: string;
      }[]
    >`
      SELECT department_id AS "departmentId", is_active AS "isActive", is_seed_data AS "isSeedData", role::text
      FROM users WHERE id = ${userId}::uuid FOR UPDATE
    `;
    const user = rows[0];
    if (!user) throw new UserNotFoundException();
    if (
      !user.isActive ||
      user.isSeedData ||
      user.role !== 'DEPT_MANAGER' ||
      user.departmentId !== departmentId
    ) {
      throw new ManagerNotEligibleException();
    }
  }

  private async uniqueError(name: string, excludeId?: string) {
    const duplicateName = await this.prisma.department.findFirst({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    return duplicateName ? new DepartmentNameTakenException() : new DepartmentCodeTakenException();
  }
}
