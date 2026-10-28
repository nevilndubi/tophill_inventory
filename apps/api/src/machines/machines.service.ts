import { Injectable } from '@nestjs/common';
import {
  can,
  machineAssetTagSchema,
  type CreateMachineInput,
  type ListMachinesQuery,
  type MachineRegistryMutationInput,
  type MachineCondition,
  type ManagedMachine,
  type ManagedMachinePage,
  type UpdateMachineInput,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { AuditService } from '../audit/audit.service';
import type { Machine, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MachineAlreadyDeletedException,
  MachineCategoryNotFoundException,
  MachineConstraintViolationException,
  MachineDatesInvalidException,
  MachineDepartmentNotFoundException,
  MachineHasActiveBookingsException,
  MachineHasOpenSessionException,
  MachineIdentityTakenException,
  MachineLocationNotFoundException,
  MachineNotDeletedException,
  MachineNotFoundException,
} from './machines.errors';

const machineSelection = {
  allowBookingWhenNeedsService: true,
  assetTag: true,
  bufferMinutes: true,
  category: { select: { id: true, name: true } },
  categoryId: true,
  commissionedOn: true,
  condition: true,
  department: { select: { code: true, id: true, name: true } },
  departmentId: true,
  deletedAt: true,
  description: true,
  id: true,
  isBookable: true,
  lastServicedAt: true,
  location: { select: { id: true, name: true } },
  locationId: true,
  manufacturer: true,
  maxBookingMinutes: true,
  model: true,
  name: true,
  nextServiceDueAt: true,
  purchaseDate: true,
  requiresApproval: true,
  serialNumber: true,
  serviceIntervalDays: true,
  warrantyExpiresOn: true,
} satisfies Prisma.MachineSelect;

type MachineRow = Prisma.MachineGetPayload<{ select: typeof machineSelection }>;
type RelationIds = Pick<CreateMachineInput, 'categoryId' | 'departmentId' | 'locationId'>;
type RelationReader = Pick<Prisma.TransactionClient, 'department' | 'location' | 'machineCategory'>;
type MachineAuditState = Pick<
  Machine,
  | 'allowBookingWhenNeedsService'
  | 'assetTag'
  | 'bufferMinutes'
  | 'categoryId'
  | 'commissionedOn'
  | 'condition'
  | 'departmentId'
  | 'description'
  | 'isBookable'
  | 'lastServicedAt'
  | 'locationId'
  | 'manufacturer'
  | 'maxBookingMinutes'
  | 'model'
  | 'name'
  | 'nextServiceDueAt'
  | 'purchaseDate'
  | 'requiresApproval'
  | 'serialNumber'
  | 'serviceIntervalDays'
  | 'warrantyExpiresOn'
>;

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] as const;
const DAY_IN_MILLISECONDS = 86_400_000;

const isPrismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const errorContains = (error: unknown, value: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = 'meta' in error ? error.meta : error;
  try {
    return JSON.stringify(candidate).includes(value);
  } catch {
    return false;
  }
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const dateTime = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const parseDateOnly = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

const parseDateTime = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

const calculateNextServiceDue = (
  lastServicedAt: Date | null,
  serviceIntervalDays: number | null,
): Date | null =>
  lastServicedAt === null || serviceIntervalDays === null
    ? null
    : new Date(lastServicedAt.getTime() + serviceIntervalDays * DAY_IN_MILLISECONDS);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
};

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/gu, '\\$&');

const toManagedMachine = (value: MachineRow): ManagedMachine => ({
  allowBookingWhenNeedsService: value.allowBookingWhenNeedsService,
  assetTag: value.assetTag,
  bufferMinutes: value.bufferMinutes,
  category: value.category,
  commissionedOn: dateOnly(value.commissionedOn),
  condition: value.condition as MachineCondition,
  department: value.department,
  description: value.description,
  id: value.id,
  isBookable: value.isBookable,
  registryStatus: value.deletedAt === null ? 'ACTIVE' : 'DELETED',
  lastServicedAt: dateTime(value.lastServicedAt),
  location: value.location,
  manufacturer: value.manufacturer,
  maxBookingMinutes: value.maxBookingMinutes,
  model: value.model,
  name: value.name,
  nextServiceDueAt: dateTime(value.nextServiceDueAt),
  purchaseDate: dateOnly(value.purchaseDate),
  requiresApproval: value.requiresApproval,
  serialNumber: value.serialNumber,
  serviceIntervalDays: value.serviceIntervalDays,
  warrantyExpiresOn: dateOnly(value.warrantyExpiresOn),
});

const auditState = (value: MachineAuditState): Prisma.InputJsonObject => ({
  allowBookingWhenNeedsService: value.allowBookingWhenNeedsService,
  assetTag: value.assetTag,
  bufferMinutes: value.bufferMinutes,
  categoryId: value.categoryId,
  commissionedOn: dateOnly(value.commissionedOn),
  condition: value.condition,
  departmentId: value.departmentId,
  description: value.description,
  isBookable: value.isBookable,
  lastServicedAt: dateTime(value.lastServicedAt),
  locationId: value.locationId,
  manufacturer: value.manufacturer,
  maxBookingMinutes: value.maxBookingMinutes,
  model: value.model,
  name: value.name,
  nextServiceDueAt: dateTime(value.nextServiceDueAt),
  purchaseDate: dateOnly(value.purchaseDate),
  requiresApproval: value.requiresApproval,
  serialNumber: value.serialNumber,
  serviceIntervalDays: value.serviceIntervalDays,
  warrantyExpiresOn: dateOnly(value.warrantyExpiresOn),
});

const registryAuditState = (
  value: MachineAuditState,
  registryStatus: 'ACTIVE' | 'DELETED',
): Prisma.InputJsonObject => ({ ...auditState(value), registryStatus });

const assertLifecycleDates = (value: {
  commissionedOn: Date | null;
  purchaseDate: Date | null;
  warrantyExpiresOn: Date | null;
}): void => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (value.purchaseDate !== null && value.purchaseDate > today) {
    throw new MachineDatesInvalidException('purchaseDate', 'Purchase date cannot be in the future');
  }
  if (
    value.purchaseDate !== null &&
    value.commissionedOn !== null &&
    value.commissionedOn < value.purchaseDate
  ) {
    throw new MachineDatesInvalidException(
      'commissionedOn',
      'Commissioned date cannot precede purchase date',
    );
  }
  if (
    value.commissionedOn !== null &&
    value.warrantyExpiresOn !== null &&
    value.warrantyExpiresOn < value.commissionedOn
  ) {
    throw new MachineDatesInvalidException(
      'warrantyExpiresOn',
      'Warranty expiry cannot precede commissioned date',
    );
  }
};

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthenticatedUser, query: ListMachinesQuery): Promise<ManagedMachinePage> {
    if (query.registry !== 'active' && !can(actor.role, 'machine:restore')) {
      throw new PermissionDeniedException();
    }
    const now = new Date();
    const escapedSearch = query.search === undefined ? undefined : escapeLikePattern(query.search);
    const where: Prisma.MachineWhereInput = {
      ...(query.registry === 'active'
        ? { deletedAt: null }
        : query.registry === 'deleted'
          ? { deletedAt: { not: null } }
          : {}),
      ...(query.category_id === undefined ? {} : { categoryId: query.category_id }),
      ...(query.condition === undefined ? {} : { condition: query.condition }),
      ...(query.department_id === undefined ? {} : { departmentId: query.department_id }),
      ...(query.is_bookable === undefined ? {} : { isBookable: query.is_bookable }),
      ...(query.location_id === undefined ? {} : { locationId: query.location_id }),
      ...(query.service_due === undefined
        ? {}
        : query.service_due
          ? { nextServiceDueAt: { lte: now } }
          : { OR: [{ nextServiceDueAt: null }, { nextServiceDueAt: { gt: now } }] }),
      ...(escapedSearch === undefined
        ? {}
        : {
            OR: [
              { name: { contains: escapedSearch, mode: 'insensitive' } },
              { assetTag: { contains: escapedSearch, mode: 'insensitive' } },
              { serialNumber: { contains: escapedSearch, mode: 'insensitive' } },
            ],
          }),
    };
    const sortField = {
      asset_tag: 'assetTag',
      condition: 'condition',
      manufacturer: 'manufacturer',
      name: 'name',
      next_service_due_at: 'nextServiceDueAt',
      serial_number: 'serialNumber',
    }[query.sort] as keyof Prisma.MachineOrderByWithRelationInput;
    const orderBy = [
      { [sortField]: query.direction },
      { id: query.direction },
    ] as Prisma.MachineOrderByWithRelationInput[];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.machine.findMany({
        orderBy,
        select: machineSelection,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.prisma.machine.count({ where }),
    ]);
    return {
      items: rows.map(toManagedMachine),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async read(
    actor: AuthenticatedUser,
    id: string,
    includeDeleted = false,
  ): Promise<ManagedMachine> {
    if (includeDeleted && !can(actor.role, 'machine:restore')) {
      throw new PermissionDeniedException();
    }
    const machine = await this.prisma.machine.findFirst({
      select: machineSelection,
      where: includeDeleted ? { id } : { deletedAt: null, id },
    });
    if (machine === null) throw new MachineNotFoundException();
    return toManagedMachine(machine);
  }

  async readByAssetTag(rawAssetTag: string): Promise<ManagedMachine> {
    const assetTag = machineAssetTagSchema.safeParse(rawAssetTag);
    if (!assetTag.success) throw new MachineNotFoundException();
    const machine = await this.prisma.machine.findFirst({
      select: machineSelection,
      where: { assetTag: { equals: assetTag.data, mode: 'insensitive' }, deletedAt: null },
    });
    if (machine === null) throw new MachineNotFoundException();
    return toManagedMachine(machine);
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateMachineInput,
    requestId: string,
  ): Promise<ManagedMachine> {
    const purchaseDate = parseDateOnly(input.purchaseDate ?? null);
    const commissionedOn = parseDateOnly(input.commissionedOn ?? null);
    const warrantyExpiresOn = parseDateOnly(input.warrantyExpiresOn ?? null);
    assertLifecycleDates({ commissionedOn, purchaseDate, warrantyExpiresOn });
    const lastServicedAt = parseDateTime(input.lastServicedAt ?? null);
    const serviceIntervalDays = input.serviceIntervalDays ?? null;
    const data: Prisma.MachineUncheckedCreateInput = {
      categoryId: input.categoryId,
      commissionedOn,
      departmentId: input.departmentId,
      description: input.description ?? null,
      lastServicedAt,
      locationId: input.locationId,
      manufacturer: input.manufacturer,
      model: input.model,
      name: input.name,
      nextServiceDueAt: calculateNextServiceDue(lastServicedAt, serviceIntervalDays),
      purchaseDate,
      serialNumber: input.serialNumber,
      serviceIntervalDays,
      warrantyExpiresOn,
      ...(input.allowBookingWhenNeedsService === undefined
        ? {}
        : { allowBookingWhenNeedsService: input.allowBookingWhenNeedsService }),
      ...(input.bufferMinutes === undefined ? {} : { bufferMinutes: input.bufferMinutes }),
      ...(input.isBookable === undefined ? {} : { isBookable: input.isBookable }),
      ...(input.maxBookingMinutes === undefined
        ? {}
        : { maxBookingMinutes: input.maxBookingMinutes }),
      ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
    };

    try {
      const id = await this.prisma.$transaction(async (transaction) => {
        await this.assertRelations(transaction, input);
        const machine = await transaction.machine.create({ data });
        await transaction.machineStatusHistory.create({
          data: {
            changedByUserId: actor.id,
            fromCondition: null,
            machineId: machine.id,
            reason: 'Machine registered',
            source: 'SYSTEM',
            toCondition: 'OPERATIONAL',
          },
        });
        await this.audit.record(transaction, {
          action: 'machine.created',
          actorUserId: actor.id,
          after: auditState(machine),
          entityId: machine.id,
          entityType: 'machine',
          requestId,
        });
        return machine.id;
      });
      return this.read(actor, id);
    } catch (error: unknown) {
      return this.mapWriteError(error, input);
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateMachineInput,
    requestId: string,
  ): Promise<ManagedMachine> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT id FROM machines WHERE id = ${id}::uuid FOR UPDATE`;
        const before = await transaction.machine.findUnique({
          select: machineSelection,
          where: { id },
        });
        if (before === null || before.deletedAt !== null) throw new MachineNotFoundException();
        await this.assertRelations(transaction, {
          categoryId: input.categoryId ?? before.categoryId,
          departmentId: input.departmentId ?? before.departmentId,
          locationId: input.locationId ?? before.locationId,
        });

        const purchaseDate = hasOwn(input, 'purchaseDate')
          ? parseDateOnly(input.purchaseDate ?? null)
          : before.purchaseDate;
        const commissionedOn = hasOwn(input, 'commissionedOn')
          ? parseDateOnly(input.commissionedOn ?? null)
          : before.commissionedOn;
        const warrantyExpiresOn = hasOwn(input, 'warrantyExpiresOn')
          ? parseDateOnly(input.warrantyExpiresOn ?? null)
          : before.warrantyExpiresOn;
        assertLifecycleDates({ commissionedOn, purchaseDate, warrantyExpiresOn });

        const data: Prisma.MachineUncheckedUpdateInput = {};
        const scalarKeys = [
          'allowBookingWhenNeedsService',
          'bufferMinutes',
          'categoryId',
          'departmentId',
          'description',
          'isBookable',
          'locationId',
          'manufacturer',
          'maxBookingMinutes',
          'model',
          'name',
          'requiresApproval',
          'serialNumber',
          'serviceIntervalDays',
        ] as const;
        for (const key of scalarKeys) {
          if (hasOwn(input, key)) data[key] = input[key] as never;
        }
        if (hasOwn(input, 'purchaseDate')) data.purchaseDate = purchaseDate;
        if (hasOwn(input, 'commissionedOn')) data.commissionedOn = commissionedOn;
        if (hasOwn(input, 'warrantyExpiresOn')) data.warrantyExpiresOn = warrantyExpiresOn;
        const lastServicedAt = hasOwn(input, 'lastServicedAt')
          ? parseDateTime(input.lastServicedAt ?? null)
          : before.lastServicedAt;
        if (hasOwn(input, 'lastServicedAt')) data.lastServicedAt = lastServicedAt;
        if (hasOwn(input, 'lastServicedAt') || hasOwn(input, 'serviceIntervalDays')) {
          data.nextServiceDueAt = calculateNextServiceDue(
            lastServicedAt,
            input.serviceIntervalDays === undefined
              ? before.serviceIntervalDays
              : input.serviceIntervalDays,
          );
        }

        const changes = Object.entries(data).filter(([key, value]) => {
          const current = before[key as keyof typeof before];
          return !sameValue(current, value);
        });
        if (changes.length === 0) return toManagedMachine(before);

        const after = await transaction.machine.update({ data, where: { id } });
        await this.audit.record(transaction, {
          action: 'machine.updated',
          actorUserId: actor.id,
          after: auditState(after),
          before: auditState(before),
          entityId: id,
          entityType: 'machine',
          requestId,
        });
        const selected = await transaction.machine.findUnique({
          select: machineSelection,
          where: { id },
        });
        if (selected === null) throw new MachineNotFoundException();
        return toManagedMachine(selected);
      });
    } catch (error: unknown) {
      return this.mapWriteError(error, {
        categoryId: input.categoryId,
        departmentId: input.departmentId,
        locationId: input.locationId,
      });
    }
  }

  async delete(
    actor: AuthenticatedUser,
    id: string,
    input: MachineRegistryMutationInput,
    requestId: string,
  ): Promise<ManagedMachine> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM machines WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await transaction.machine.findUnique({
        select: machineSelection,
        where: { id },
      });
      if (before === null) throw new MachineNotFoundException();
      if (before.deletedAt !== null) throw new MachineAlreadyDeletedException();
      const [openSessionCount, activeBookingCount] = await Promise.all([
        transaction.usageSession.count({ where: { endedAt: null, machineId: id } }),
        transaction.booking.count({
          where: { machineId: id, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        }),
      ]);
      if (openSessionCount > 0) throw new MachineHasOpenSessionException();
      if (activeBookingCount > 0) {
        throw new MachineHasActiveBookingsException(activeBookingCount);
      }
      const after = await transaction.machine.update({
        data: { deletedAt: new Date() },
        select: machineSelection,
        where: { id },
      });
      await this.audit.record(transaction, {
        action: 'machine.deleted',
        actorUserId: actor.id,
        after: registryAuditState(after, 'DELETED'),
        before: registryAuditState(before, 'ACTIVE'),
        ...(input.reason === undefined ? {} : { context: { reason: input.reason } }),
        entityId: id,
        entityType: 'machine',
        requestId,
      });
      return toManagedMachine(after);
    });
  }

  async restore(
    actor: AuthenticatedUser,
    id: string,
    input: MachineRegistryMutationInput,
    requestId: string,
  ): Promise<ManagedMachine> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM machines WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await transaction.machine.findUnique({
        select: machineSelection,
        where: { id },
      });
      if (before === null) throw new MachineNotFoundException();
      if (before.deletedAt === null) throw new MachineNotDeletedException();
      const after = await transaction.machine.update({
        data: { deletedAt: null },
        select: machineSelection,
        where: { id },
      });
      await this.audit.record(transaction, {
        action: 'machine.restored',
        actorUserId: actor.id,
        after: registryAuditState(after, 'ACTIVE'),
        before: registryAuditState(before, 'DELETED'),
        ...(input.reason === undefined ? {} : { context: { reason: input.reason } }),
        entityId: id,
        entityType: 'machine',
        requestId,
      });
      return toManagedMachine(after);
    });
  }

  private async assertRelations(reader: RelationReader, ids: RelationIds): Promise<void> {
    const [category, department, location] = await Promise.all([
      reader.machineCategory.findUnique({ select: { id: true }, where: { id: ids.categoryId } }),
      reader.department.findUnique({ select: { id: true }, where: { id: ids.departmentId } }),
      reader.location.findUnique({ select: { id: true }, where: { id: ids.locationId } }),
    ]);
    if (category === null) throw new MachineCategoryNotFoundException();
    if (department === null) throw new MachineDepartmentNotFoundException();
    if (location === null) throw new MachineLocationNotFoundException();
  }

  private async mapWriteError(error: unknown, ids: Partial<RelationIds>): Promise<never> {
    if (
      error instanceof MachineNotFoundException ||
      error instanceof MachineCategoryNotFoundException ||
      error instanceof MachineDepartmentNotFoundException ||
      error instanceof MachineLocationNotFoundException ||
      error instanceof MachineDatesInvalidException
    ) {
      throw error;
    }
    if (isPrismaError(error, 'P2002')) throw new MachineIdentityTakenException();
    if (isPrismaError(error, 'P2003')) {
      if (ids.categoryId !== undefined) {
        const category = await this.prisma.machineCategory.findUnique({
          select: { id: true },
          where: { id: ids.categoryId },
        });
        if (category === null) throw new MachineCategoryNotFoundException();
      }
      if (ids.departmentId !== undefined) {
        const department = await this.prisma.department.findUnique({
          select: { id: true },
          where: { id: ids.departmentId },
        });
        if (department === null) throw new MachineDepartmentNotFoundException();
      }
      if (ids.locationId !== undefined) {
        const location = await this.prisma.location.findUnique({
          select: { id: true },
          where: { id: ids.locationId },
        });
        if (location === null) throw new MachineLocationNotFoundException();
      }
    }
    if (
      isPrismaError(error, 'P2004') &&
      (errorContains(error, 'machines_warranty_after_commission_check') ||
        errorContains(error, 'machines_retirement_consistency_check'))
    ) {
      throw new MachineDatesInvalidException(
        'warrantyExpiresOn',
        'Warranty expiry cannot precede commissioned date',
      );
    }
    if (isPrismaError(error, 'P2003') || isPrismaError(error, 'P2004')) {
      throw new MachineConstraintViolationException();
    }
    throw error;
  }
}
