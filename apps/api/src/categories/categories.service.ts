import { Injectable } from '@nestjs/common';
import type { CreateCategoryInput, ManagedCategory, UpdateCategoryInput } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertMaximumMeetsMinimum } from '../booking/booking-policy.validation';
import {
  CategoryInUseException,
  CategoryNameTakenException,
  CategoryNotFoundException,
} from './categories.errors';

type CategoryRow = {
  defaultMaxBookingMinutes: number | null;
  defaultServiceIntervalDays: number | null;
  description: string | null;
  id: string;
  machineCount: number;
  name: string;
  totalMachineCount: number;
};

type CategoryState = Pick<
  CategoryRow,
  'defaultMaxBookingMinutes' | 'defaultServiceIntervalDays' | 'description' | 'name'
>;

const isPrismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const toManagedCategory = (row: CategoryRow): ManagedCategory => ({
  defaultMaxBookingMinutes: row.defaultMaxBookingMinutes,
  defaultServiceIntervalDays: row.defaultServiceIntervalDays,
  description: row.description,
  id: row.id,
  is_deletable: row.totalMachineCount === 0,
  machine_count: row.machineCount,
  name: row.name,
});

const stateOf = (category: CategoryState): Prisma.InputJsonObject => ({
  defaultMaxBookingMinutes: category.defaultMaxBookingMinutes,
  defaultServiceIntervalDays: category.defaultServiceIntervalDays,
  description: category.description,
  name: category.name,
});

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  read(): Promise<readonly ManagedCategory[]>;
  read(id: string): Promise<ManagedCategory>;
  async read(id?: string): Promise<readonly ManagedCategory[] | ManagedCategory> {
    const rows =
      id === undefined
        ? await this.prisma.$queryRaw<CategoryRow[]>`
            SELECT
              category.id,
              category.name,
              category.description,
              category.default_service_interval_days AS "defaultServiceIntervalDays",
              category.default_max_booking_minutes AS "defaultMaxBookingMinutes",
              count(machine.id) FILTER (
                WHERE machine.deleted_at IS NULL
                  AND machine.condition <> 'RETIRED'::machine_condition
              )::integer AS "machineCount",
              count(machine.id)::integer AS "totalMachineCount"
            FROM machine_categories category
            LEFT JOIN machines machine ON machine.category_id = category.id
            GROUP BY category.id
            ORDER BY lower(category.name), category.id
          `
        : await this.prisma.$queryRaw<CategoryRow[]>`
            SELECT
              category.id,
              category.name,
              category.description,
              category.default_service_interval_days AS "defaultServiceIntervalDays",
              category.default_max_booking_minutes AS "defaultMaxBookingMinutes",
              count(machine.id) FILTER (
                WHERE machine.deleted_at IS NULL
                  AND machine.condition <> 'RETIRED'::machine_condition
              )::integer AS "machineCount",
              count(machine.id)::integer AS "totalMachineCount"
            FROM machine_categories category
            LEFT JOIN machines machine ON machine.category_id = category.id
            WHERE category.id = ${id}::uuid
            GROUP BY category.id
          `;

    if (id === undefined) return rows.map(toManagedCategory);
    const row = rows[0];
    if (row === undefined) throw new CategoryNotFoundException();
    return toManagedCategory(row);
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateCategoryInput,
    requestId: string,
  ): Promise<ManagedCategory> {
    try {
      const id = await this.prisma.$transaction(async (transaction) => {
        await assertMaximumMeetsMinimum(transaction, input.defaultMaxBookingMinutes ?? null);
        const category = await transaction.machineCategory.create({ data: input });
        await this.audit.record(transaction, {
          action: 'category.created',
          actorUserId: actor.id,
          after: stateOf(category),
          entityId: category.id,
          entityType: 'category',
          requestId,
        });
        return category.id;
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) throw new CategoryNameTakenException();
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateCategoryInput,
    requestId: string,
  ): Promise<ManagedCategory> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        const before = await transaction.machineCategory.findUnique({ where: { id } });
        if (before === null) throw new CategoryNotFoundException();
        await assertMaximumMeetsMinimum(
          transaction,
          input.defaultMaxBookingMinutes === undefined
            ? before.defaultMaxBookingMinutes
            : input.defaultMaxBookingMinutes,
        );
        const after = await transaction.machineCategory.update({ data: input, where: { id } });
        await this.audit.record(transaction, {
          action: 'category.updated',
          actorUserId: actor.id,
          after: stateOf(after),
          before: stateOf(before),
          entityId: id,
          entityType: 'category',
          requestId,
        });
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) throw new CategoryNameTakenException();
      throw error;
    }
  }

  async delete(actor: AuthenticatedUser, id: string, requestId: string): Promise<ManagedCategory> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const category = await transaction.machineCategory.findUnique({ where: { id } });
        if (category === null) throw new CategoryNotFoundException();
        const machineCount = await transaction.machine.count({ where: { categoryId: id } });
        if (machineCount > 0) throw new CategoryInUseException(machineCount);
        await transaction.machineCategory.delete({ where: { id } });
        await this.audit.record(transaction, {
          action: 'category.deleted',
          actorUserId: actor.id,
          before: stateOf(category),
          entityId: id,
          entityType: 'category',
          requestId,
        });
        return toManagedCategory({
          ...category,
          machineCount: 0,
          totalMachineCount: 0,
        });
      });
    } catch (error: unknown) {
      if (error instanceof CategoryInUseException || error instanceof CategoryNotFoundException) {
        throw error;
      }
      if (isPrismaError(error, 'P2003')) {
        const machineCount = await this.prisma.machine.count({ where: { categoryId: id } });
        throw new CategoryInUseException(machineCount);
      }
      throw error;
    }
  }
}
