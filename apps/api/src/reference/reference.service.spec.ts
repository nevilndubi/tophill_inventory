import { jest } from '@jest/globals';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DepartmentsService } from './departments.service';
import { LocationsService } from './locations.service';
import {
  DepartmentCodeTakenException,
  DepartmentInUseException,
  DepartmentNameTakenException,
  LocationDepartmentImmutableException,
  LocationInUseException,
  LocationNameTakenException,
  ManagerNotEligibleException,
} from './reference.errors';

const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted',
  fullName: 'Admin',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role: 'ADMIN',
};
const department: {
  code: string;
  createdAt: Date;
  id: string;
  managerUserId: string | null;
  name: string;
  updatedAt: Date;
} = {
  code: 'ICU',
  createdAt: new Date(),
  id: '22222222-2222-4222-8222-222222222222',
  managerUserId: null,
  name: 'Intensive Care',
  updatedAt: new Date(),
};
const location = {
  building: null,
  createdAt: new Date(),
  departmentId: department.id,
  floor: null,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Bay A',
  room: null,
  updatedAt: new Date(),
};

const makeHarness = () => {
  const tx = {
    $queryRaw: jest.fn<() => Promise<unknown[]>>(async () => []),
    department: {
      create: jest.fn(async () => department),
      delete: jest.fn(async () => department),
      findUnique: jest.fn(async () => department),
      update: jest.fn(async () => department),
    },
    location: {
      count: jest.fn(async () => 0),
      create: jest.fn(async () => location),
      delete: jest.fn(async () => location),
      findUnique: jest.fn(async () => location),
      update: jest.fn(async () => location),
    },
    machine: { count: jest.fn(async () => 0) },
    user: { count: jest.fn(async () => 0) },
  };
  const managedDepartment = {
    code: department.code,
    id: department.id,
    locationCount: 0,
    machineCount: 0,
    managerFullName: null,
    managerId: null,
    name: department.name,
    userCount: 0,
  };
  const managedLocation = {
    ...location,
    _count: { machines: 0 },
    department: { code: department.code, id: department.id, name: department.name },
  };
  const prisma = {
    $queryRaw: jest.fn(async () => [managedDepartment]),
    $transaction: jest.fn(async (operation: unknown) =>
      Array.isArray(operation)
        ? Promise.all(operation)
        : (operation as (client: typeof tx) => Promise<unknown>)(tx),
    ),
    department: {
      count: jest.fn(async () => 1),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => department),
    },
    location: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => [managedLocation]),
      findUnique: jest.fn(async () => managedLocation),
    },
    machine: { count: jest.fn(async () => 0) },
    user: {
      count: jest.fn(async () => 0),
      findMany: jest.fn<() => Promise<Array<{ fullName: string; id: string }>>>(async () => []),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  return {
    audit,
    departments: new DepartmentsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    ),
    locations: new LocationsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    ),
    prisma,
    tx,
  };
};

describe('reference services', () => {
  it('returns minimized grouped department counts and eligible candidates without emails', async () => {
    const { departments, prisma } = makeHarness();
    prisma.user.findMany.mockResolvedValueOnce([{ fullName: 'Manager One', id: actor.id }]);
    await expect(departments.read()).resolves.toEqual([
      expect.objectContaining({ is_deletable: true, manager: null, name: department.name }),
    ]);
    await expect(departments.eligibleManagers(department.id)).resolves.toEqual([
      { full_name: 'Manager One', id: actor.id },
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          departmentId: department.id,
          isActive: true,
          isSeedData: false,
          role: 'DEPT_MANAGER',
        },
      }),
    );
  });

  it('locks and validates a manager only when the assignment changes', async () => {
    const stale = makeHarness();
    stale.tx.department.findUnique.mockResolvedValueOnce({
      ...department,
      managerUserId: actor.id,
    });
    stale.tx.department.update.mockResolvedValueOnce({
      ...department,
      managerUserId: actor.id,
      name: 'ICU Renamed',
    });
    await expect(
      stale.departments.update(actor, department.id, { name: 'ICU Renamed' }, 'request'),
    ).resolves.toBeDefined();
    expect(stale.tx.$queryRaw).not.toHaveBeenCalled();

    const rejected = makeHarness();
    rejected.tx.$queryRaw.mockResolvedValueOnce([
      { departmentId: department.id, isActive: false, isSeedData: false, role: 'DEPT_MANAGER' },
    ]);
    await expect(
      rejected.departments.update(actor, department.id, { managerUserId: actor.id }, 'request'),
    ).rejects.toBeInstanceOf(ManagerNotEligibleException);
  });

  it('blocks department deletion with all dependency counts and writes no audit', async () => {
    const { audit, departments, tx } = makeHarness();
    tx.$queryRaw.mockResolvedValueOnce([
      { code: department.code, managerUserId: null, name: department.name },
    ]);
    tx.user.count.mockResolvedValueOnce(2);
    tx.location.count.mockResolvedValueOnce(1);
    tx.machine.count.mockResolvedValueOnce(3);
    await expect(departments.delete(actor, department.id, 'request')).rejects.toBeInstanceOf(
      DepartmentInUseException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lists locations in one page shape, keeps department immutable, and maps machine references', async () => {
    const { audit, locations, prisma, tx } = makeHarness();
    await expect(locations.list({ page: 1, pageSize: 50 })).resolves.toEqual(
      expect.objectContaining({ page: 1, total: 0 }),
    );
    await expect(
      locations.update(actor, location.id, { departmentId: actor.id }, 'request'),
    ).rejects.toBeInstanceOf(LocationDepartmentImmutableException);
    tx.machine.count.mockResolvedValueOnce(1);
    await expect(locations.delete(actor, location.id, 'request')).rejects.toBeInstanceOf(
      LocationInUseException,
    );
    expect(audit.record).not.toHaveBeenCalled();
    expect(prisma.location.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });

  it('keeps writes and audits in the same transaction', async () => {
    const { audit, locations, tx } = makeHarness();
    tx.$queryRaw.mockResolvedValueOnce([{ id: department.id }]);
    await locations.create(actor, { departmentId: department.id, name: ' Bay   A ' }, 'request');
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'location.created', entityType: 'location' }),
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.location.create.mock.invocationCallOrder[0]!,
    );
  });

  it('maps forced unique races to stable department and location codes', async () => {
    const nameRace = makeHarness();
    nameRace.tx.department.create.mockRejectedValueOnce({ code: 'P2002' } as never);
    nameRace.prisma.department.findFirst.mockResolvedValueOnce(department as never);
    await expect(
      nameRace.departments.create(actor, { code: 'ICU', name: 'intensive care' }, 'request'),
    ).rejects.toBeInstanceOf(DepartmentNameTakenException);

    const codeRace = makeHarness();
    codeRace.tx.department.create.mockRejectedValueOnce({ code: 'P2002' } as never);
    await expect(
      codeRace.departments.create(actor, { code: 'ICU', name: 'Critical Care' }, 'request'),
    ).rejects.toBeInstanceOf(DepartmentCodeTakenException);

    const locationRace = makeHarness();
    locationRace.tx.$queryRaw.mockResolvedValueOnce([{ id: department.id }]);
    locationRace.tx.location.create.mockRejectedValueOnce({ code: 'P2002' } as never);
    await expect(
      locationRace.locations.create(
        actor,
        { departmentId: department.id, name: 'bay a' },
        'request',
      ),
    ).rejects.toBeInstanceOf(LocationNameTakenException);
  });

  it('maps forced foreign-key delete races to dependency conflicts', async () => {
    const departmentRace = makeHarness();
    departmentRace.tx.$queryRaw.mockResolvedValueOnce([
      { code: department.code, managerUserId: null, name: department.name },
    ]);
    departmentRace.tx.department.delete.mockRejectedValueOnce({ code: 'P2003' } as never);
    departmentRace.prisma.location.count.mockResolvedValueOnce(1);
    await expect(
      departmentRace.departments.delete(actor, department.id, 'request'),
    ).rejects.toBeInstanceOf(DepartmentInUseException);

    const locationRace = makeHarness();
    locationRace.tx.location.delete.mockRejectedValueOnce({ code: 'P2003' } as never);
    locationRace.prisma.machine.count.mockResolvedValueOnce(1);
    await expect(
      locationRace.locations.delete(actor, location.id, 'request'),
    ).rejects.toBeInstanceOf(LocationInUseException);
  });

  it('returns the minimized parent department when deleting an empty location', async () => {
    const { locations, tx } = makeHarness();
    tx.location.findUnique.mockResolvedValueOnce({
      ...location,
      department: { code: department.code, id: department.id, name: department.name },
    } as never);
    await expect(locations.delete(actor, location.id, 'request')).resolves.toEqual(
      expect.objectContaining({
        department: { code: department.code, id: department.id, name: department.name },
        is_deletable: true,
      }),
    );
  });
});
