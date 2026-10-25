import { Injectable } from '@nestjs/common';
import type {
  CreateLocationInput,
  ListLocationsQuery,
  ManagedLocation,
  ManagedLocationPage,
  UpdateLocationInput,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DepartmentNotFoundException,
  LocationInUseException,
  LocationDepartmentImmutableException,
  LocationNameTakenException,
  LocationNotFoundException,
} from './reference.errors';

const locationSelection = {
  building: true,
  department: { select: { code: true, id: true, name: true } },
  floor: true,
  id: true,
  name: true,
  room: true,
  _count: { select: { machines: true } },
} satisfies Prisma.LocationSelect;
type LocationRow = Prisma.LocationGetPayload<{ select: typeof locationSelection }>;
type LocationState = {
  building: string | null;
  departmentId: string;
  floor: string | null;
  name: string;
  room: string | null;
};
const isPrismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const stateOf = (value: LocationState): Prisma.InputJsonObject => ({
  building: value.building,
  departmentId: value.departmentId,
  floor: value.floor,
  name: value.name,
  room: value.room,
});
const toManaged = (value: LocationRow): ManagedLocation => ({
  building: value.building,
  department: value.department,
  floor: value.floor,
  id: value.id,
  is_deletable: value._count.machines === 0,
  machine_count: value._count.machines,
  name: value.name,
  room: value.room,
});

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListLocationsQuery): Promise<ManagedLocationPage> {
    const where: Prisma.LocationWhereInput = {
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
        select: locationSelection,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.prisma.location.count({ where }),
    ]);
    return { items: items.map(toManaged), page: query.page, pageSize: query.pageSize, total };
  }

  async read(id: string): Promise<ManagedLocation> {
    const location = await this.prisma.location.findUnique({
      select: locationSelection,
      where: { id },
    });
    if (!location) throw new LocationNotFoundException();
    return toManaged(location);
  }

  async create(actor: AuthenticatedUser, input: CreateLocationInput, requestId: string) {
    try {
      const id = await this.prisma.$transaction(async (transaction) => {
        const parent = await transaction.$queryRaw<readonly { id: string }[]>`
          SELECT id FROM departments WHERE id = ${input.departmentId}::uuid FOR KEY SHARE
        `;
        if (parent.length === 0) throw new DepartmentNotFoundException();
        const location = await transaction.location.create({ data: input });
        await this.audit.record(transaction, {
          action: 'location.created',
          actorUserId: actor.id,
          after: stateOf(location),
          entityId: location.id,
          entityType: 'location',
          requestId,
        });
        return location.id;
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) throw new LocationNameTakenException();
      if (isPrismaError(error, 'P2003')) throw new DepartmentNotFoundException();
      throw error;
    }
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateLocationInput,
    requestId: string,
  ) {
    if (input.departmentId !== undefined) throw new LocationDepartmentImmutableException();
    const update = {
      building: input.building,
      floor: input.floor,
      name: input.name,
      room: input.room,
    };
    try {
      await this.prisma.$transaction(async (transaction) => {
        const before = await transaction.location.findUnique({ where: { id } });
        if (!before) throw new LocationNotFoundException();
        const after = await transaction.location.update({ data: update, where: { id } });
        await this.audit.record(transaction, {
          action: 'location.updated',
          actorUserId: actor.id,
          after: stateOf(after),
          before: stateOf(before),
          entityId: id,
          entityType: 'location',
          requestId,
        });
      });
      return this.read(id);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) throw new LocationNameTakenException();
      throw error;
    }
  }

  async delete(actor: AuthenticatedUser, id: string, requestId: string) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const before = await transaction.location.findUnique({
          include: { department: { select: { code: true, id: true, name: true } } },
          where: { id },
        });
        if (!before) throw new LocationNotFoundException();
        const machineCount = await transaction.machine.count({ where: { locationId: id } });
        if (machineCount > 0) throw new LocationInUseException(machineCount);
        await transaction.location.delete({ where: { id } });
        await this.audit.record(transaction, {
          action: 'location.deleted',
          actorUserId: actor.id,
          before: stateOf(before),
          entityId: id,
          entityType: 'location',
          requestId,
        });
        return {
          building: before.building,
          department: before.department,
          floor: before.floor,
          id,
          is_deletable: true,
          machine_count: 0,
          name: before.name,
          room: before.room,
        } satisfies ManagedLocation;
      });
    } catch (error: unknown) {
      if (error instanceof LocationInUseException || error instanceof LocationNotFoundException)
        throw error;
      if (isPrismaError(error, 'P2003')) {
        throw new LocationInUseException(
          await this.prisma.machine.count({ where: { locationId: id } }),
        );
      }
      throw error;
    }
  }
}
