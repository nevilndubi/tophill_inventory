import { jest } from '@jest/globals';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MachineAlreadyDeletedException,
  MachineCategoryNotFoundException,
  MachineHasActiveBookingsException,
  MachineHasOpenSessionException,
  MachineIdentityTakenException,
  MachineLocationNotFoundException,
  MachineNotDeletedException,
  MachineNotFoundException,
} from './machines.errors';
import { MachinesService } from './machines.service';

const ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '44444444-4444-4444-8444-444444444444';
const ALT_LOCATION_ID = '66666666-6666-4666-8666-666666666666';

const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test Admin',
  id: '55555555-5555-4555-8555-555555555555',
  isActive: true,
  role: 'ADMIN',
};

const now = new Date('2026-10-25T12:00:00.000Z');
const scalarMachine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  categoryId: CATEGORY_ID,
  commissionedOn: new Date('2025-02-01T00:00:00.000Z'),
  condition: 'OPERATIONAL' as const,
  createdAt: now,
  deletedAt: null,
  departmentId: DEPARTMENT_ID,
  description: null,
  id: ID,
  isBookable: true,
  lastServicedAt: new Date('2026-01-01T00:00:00.000Z'),
  locationId: LOCATION_ID,
  manufacturer: 'acme',
  maxBookingMinutes: null,
  model: 'v1',
  name: 'Ventilator',
  nextServiceDueAt: new Date('2026-06-30T00:00:00.000Z'),
  purchaseDate: new Date('2025-01-01T00:00:00.000Z'),
  requiresApproval: false,
  serialNumber: 'sn-1',
  serviceIntervalDays: 180,
  updatedAt: now,
  warrantyExpiresOn: new Date('2027-02-01T00:00:00.000Z'),
};
const machineRow = {
  ...scalarMachine,
  category: { id: CATEGORY_ID, name: 'Ventilator' },
  department: { code: 'ICU', id: DEPARTMENT_ID, name: 'Intensive Care' },
  location: { id: LOCATION_ID, name: 'Bay A' },
};

const createInput = {
  categoryId: CATEGORY_ID,
  commissionedOn: '2025-02-01',
  departmentId: DEPARTMENT_ID,
  lastServicedAt: '2026-01-01T00:00:00Z',
  locationId: LOCATION_ID,
  manufacturer: 'acme',
  model: 'v1',
  name: 'Ventilator',
  purchaseDate: '2025-01-01',
  serialNumber: 'sn-1',
  serviceIntervalDays: 180,
  warrantyExpiresOn: '2027-02-01',
};

const makeHarness = () => {
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: ID }]),
    auditLog: { create: jest.fn(async () => undefined) },
    booking: { count: jest.fn(async () => 0) },
    department: { findUnique: jest.fn(async () => ({ id: DEPARTMENT_ID })) },
    location: { findUnique: jest.fn(async () => ({ id: LOCATION_ID })) },
    machine: {
      create: jest.fn(async () => scalarMachine),
      findUnique: jest.fn(async () => machineRow),
      update: jest.fn(async () => scalarMachine),
    },
    machineCategory: { findUnique: jest.fn(async () => ({ id: CATEGORY_ID })) },
    machineStatusHistory: { create: jest.fn(async () => undefined) },
    usageSession: { count: jest.fn(async () => 0) },
  };
  const prisma = {
    $transaction: jest.fn(async (argument: unknown) => {
      if (Array.isArray(argument)) return Promise.all(argument);
      return (argument as (client: typeof tx) => Promise<unknown>)(tx);
    }),
    department: { findUnique: jest.fn(async () => ({ id: DEPARTMENT_ID })) },
    location: { findUnique: jest.fn(async () => ({ id: LOCATION_ID })) },
    machine: {
      count: jest.fn(async () => 1),
      findFirst: jest.fn(async () => machineRow),
      findMany: jest.fn(async () => [machineRow, { ...machineRow, id: `${ID.slice(0, -1)}2` }]),
    },
    machineCategory: { findUnique: jest.fn(async () => ({ id: CATEGORY_ID })) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new MachinesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { audit, prisma, service, tx };
};

describe('MachinesService', () => {
  it('lists minimized DTOs with filters, escaped search, stable sorting, and no N+1 reads', async () => {
    const { prisma, service } = makeHarness();
    const result = await service.list(actor, {
      category_id: CATEGORY_ID,
      condition: 'OPERATIONAL',
      department_id: DEPARTMENT_ID,
      direction: 'desc',
      is_bookable: true,
      location_id: LOCATION_ID,
      page: 2,
      pageSize: 1,
      registry: 'active',
      search: 'HM%_\\',
      service_due: true,
      sort: 'name',
    });

    expect(result).toMatchObject({ page: 2, pageSize: 1, total: 1 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).not.toHaveProperty('deletedAt');
    expect(result.items[0]).not.toHaveProperty('createdAt');
    expect(prisma.machine.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ name: 'desc' }, { id: 'desc' }],
        skip: 1,
        take: 1,
        where: expect.objectContaining({
          categoryId: CATEGORY_ID,
          condition: 'OPERATIONAL',
          deletedAt: null,
          departmentId: DEPARTMENT_ID,
          isBookable: true,
          locationId: LOCATION_ID,
          nextServiceDueAt: { lte: expect.any(Date) },
          OR: expect.arrayContaining([
            { name: { contains: 'HM\\%\\_\\\\', mode: 'insensitive' } },
            { assetTag: { contains: 'HM\\%\\_\\\\', mode: 'insensitive' } },
            { serialNumber: { contains: 'HM\\%\\_\\\\', mode: 'insensitive' } },
          ]),
        }),
      }),
    );
  });

  it.each([
    ['asset_tag', 'assetTag'],
    ['name', 'name'],
    ['manufacturer', 'manufacturer'],
    ['serial_number', 'serialNumber'],
    ['condition', 'condition'],
    ['next_service_due_at', 'nextServiceDueAt'],
  ] as const)('maps the allowed %s sort without accepting raw fields', async (sort, field) => {
    const { prisma, service } = makeHarness();
    await service.list(actor, {
      direction: 'asc',
      page: 1,
      pageSize: 25,
      registry: 'active',
      sort,
    });
    expect(prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ [field]: 'asc' }, { id: 'asc' }] }),
    );
  });

  it('defines not-due as a null or future due date', async () => {
    const { prisma, service } = makeHarness();
    await service.list(actor, {
      direction: 'asc',
      page: 1,
      pageSize: 25,
      registry: 'active',
      service_due: false,
      sort: 'asset_tag',
    });
    expect(prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ nextServiceDueAt: null }, { nextServiceDueAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it('applies registry visibility before querying and supports deleted/all for administrators', async () => {
    const denied = makeHarness();
    const staff = { ...actor, role: 'STAFF' as const };
    await expect(
      denied.service.list(staff, {
        direction: 'asc',
        page: 1,
        pageSize: 25,
        registry: 'deleted',
        sort: 'asset_tag',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.prisma.machine.findMany).not.toHaveBeenCalled();

    const deleted = makeHarness();
    await deleted.service.list(actor, {
      direction: 'asc',
      page: 1,
      pageSize: 25,
      registry: 'deleted',
      sort: 'asset_tag',
    });
    expect(deleted.prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: { not: null } }) }),
    );

    const all = makeHarness();
    await all.service.list(actor, {
      direction: 'asc',
      page: 1,
      pageSize: 25,
      registry: 'all',
      sort: 'asset_tag',
    });
    expect(all.prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ deletedAt: expect.anything() }),
      }),
    );
  });

  it('keeps RETIRED condition rows visible in the active registry', async () => {
    const { prisma, service } = makeHarness();
    prisma.machine.findMany.mockResolvedValueOnce([
      { ...machineRow, condition: 'RETIRED', retiredOn: new Date('2026-10-01') },
    ] as never);
    const result = await service.list(actor, {
      direction: 'asc',
      page: 1,
      pageSize: 25,
      registry: 'active',
      sort: 'asset_tag',
    });
    expect(result.items[0]).toMatchObject({ condition: 'RETIRED', registryStatus: 'ACTIVE' });
    expect(prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('reads only active rows and normalizes asset tags without leaking malformed lookups', async () => {
    const { prisma, service } = makeHarness();
    await expect(service.read(actor, ID)).resolves.toMatchObject({
      id: ID,
      purchaseDate: '2025-01-01',
      registryStatus: 'ACTIVE',
    });
    await expect(service.readByAssetTag('  hm-000061 ')).resolves.toMatchObject({ id: ID });
    expect(prisma.machine.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { deletedAt: null, id: ID } }),
    );
    expect(prisma.machine.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { assetTag: { equals: 'HM-000061', mode: 'insensitive' }, deletedAt: null },
      }),
    );
    await expect(service.readByAssetTag('not-a-tag')).rejects.toBeInstanceOf(
      MachineNotFoundException,
    );
  });

  it('authorizes deleted detail visibility before database lookup', async () => {
    const denied = makeHarness();
    await expect(
      denied.service.read({ ...actor, role: 'BIOMED_TECH' }, ID, true),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.prisma.machine.findFirst).not.toHaveBeenCalled();

    const allowed = makeHarness();
    allowed.prisma.machine.findFirst.mockResolvedValueOnce({
      ...machineRow,
      deletedAt: now,
    } as never);
    await expect(allowed.service.read(actor, ID, true)).resolves.toMatchObject({
      registryStatus: 'DELETED',
    });
    expect(allowed.prisma.machine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID } }),
    );
  });

  it('creates a machine, computed due date, first SYSTEM history, and audit atomically', async () => {
    const { audit, service, tx } = makeHarness();
    await expect(service.create(actor, createInput, 'request-1')).resolves.toMatchObject({
      assetTag: 'HM-000061',
      condition: 'OPERATIONAL',
    });
    expect(tx.machine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lastServicedAt: new Date('2026-01-01T00:00:00.000Z'),
        nextServiceDueAt: new Date('2026-06-30T00:00:00.000Z'),
      }),
    });
    expect(tx.machineStatusHistory.create).toHaveBeenCalledWith({
      data: {
        changedByUserId: actor.id,
        fromCondition: null,
        machineId: ID,
        reason: 'Machine registered',
        source: 'SYSTEM',
        toCondition: 'OPERATIONAL',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'machine.created', entityId: ID }),
    );
  });

  it('maps missing relations and concurrent duplicate identities to stable errors', async () => {
    const missing = makeHarness();
    missing.tx.machineCategory.findUnique.mockResolvedValueOnce(null as never);
    await expect(missing.service.create(actor, createInput, 'request')).rejects.toBeInstanceOf(
      MachineCategoryNotFoundException,
    );

    const duplicate = makeHarness();
    duplicate.tx.machine.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(duplicate.service.create(actor, createInput, 'request')).rejects.toBeInstanceOf(
      MachineIdentityTakenException,
    );
  });

  it('settles two simultaneous identical creates as one success and one stable conflict', async () => {
    const harness = makeHarness();
    harness.tx.machine.create
      .mockResolvedValueOnce(scalarMachine)
      .mockRejectedValueOnce({ code: 'P2002' });
    const outcomes = await Promise.allSettled([
      harness.service.create(actor, createInput, 'request-a'),
      harness.service.create(actor, createInput, 'request-b'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(MachineIdentityTakenException);
  });

  it('rolls back the create contract when history or audit insertion fails', async () => {
    const historyFailure = makeHarness();
    historyFailure.tx.machineStatusHistory.create.mockRejectedValueOnce(
      new Error('history failed'),
    );
    await expect(historyFailure.service.create(actor, createInput, 'request')).rejects.toThrow(
      'history failed',
    );
    expect(historyFailure.audit.record).not.toHaveBeenCalled();

    const auditFailure = makeHarness();
    auditFailure.audit.record.mockRejectedValueOnce(new Error('audit failed'));
    await expect(auditFailure.service.create(actor, createInput, 'request')).rejects.toThrow(
      'audit failed',
    );
  });

  it('updates only supplied fields, recomputes service due, and writes no history', async () => {
    const { audit, service, tx } = makeHarness();
    await expect(
      service.update(
        actor,
        ID,
        { lastServicedAt: '2026-02-01T00:00:00Z', name: 'Ventilator Two' },
        'request',
      ),
    ).resolves.toMatchObject({ id: ID });
    expect(tx.machine.update).toHaveBeenCalledWith({
      data: {
        lastServicedAt: new Date('2026-02-01T00:00:00.000Z'),
        name: 'Ventilator Two',
        nextServiceDueAt: new Date('2026-07-31T00:00:00.000Z'),
      },
      where: { id: ID },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'machine.updated' }),
    );
    expect(tx.machineStatusHistory.create).not.toHaveBeenCalled();
  });

  it('maps update relation races and named date checks without exposing database errors', async () => {
    const relationRace = makeHarness();
    relationRace.tx.machine.update.mockRejectedValueOnce({ code: 'P2003' });
    relationRace.prisma.location.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      relationRace.service.update(actor, ID, { locationId: ALT_LOCATION_ID }, 'request'),
    ).rejects.toBeInstanceOf(MachineLocationNotFoundException);

    const checkRace = makeHarness();
    checkRace.tx.machine.update.mockRejectedValueOnce({
      code: 'P2004',
      meta: { database_error: 'machines_warranty_after_commission_check' },
    });
    await expect(
      checkRace.service.update(actor, ID, { name: 'Changed' }, 'request'),
    ).rejects.toMatchObject({ response: { code: 'MACHINE_DATES_INVALID' } });
  });

  it('propagates audit failure so update and delete remain transactional', async () => {
    const update = makeHarness();
    update.audit.record.mockRejectedValueOnce(new Error('audit failed'));
    await expect(update.service.update(actor, ID, { name: 'Changed' }, 'request')).rejects.toThrow(
      'audit failed',
    );

    const deletion = makeHarness();
    deletion.audit.record.mockRejectedValueOnce(new Error('audit failed'));
    await expect(deletion.service.delete(actor, ID, {}, 'request')).rejects.toThrow('audit failed');
  });

  it('returns a semantic PATCH no-op without an update, audit, or updated_at bump', async () => {
    const { audit, service, tx } = makeHarness();
    await expect(
      service.update(actor, ID, { name: 'Ventilator' }, 'request'),
    ).resolves.toMatchObject({
      id: ID,
    });
    expect(tx.machine.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('soft deletes without changing condition or history and makes repeated deletion explicit', async () => {
    const { audit, service, tx } = makeHarness();
    tx.machine.update.mockResolvedValueOnce({ ...machineRow, deletedAt: now } as never);
    await expect(
      service.delete(actor, ID, { reason: 'Registry correction' }, 'request'),
    ).resolves.toMatchObject({ id: ID, registryStatus: 'DELETED' });
    expect(tx.machine.update).toHaveBeenCalledWith({
      data: { deletedAt: expect.any(Date) },
      select: expect.any(Object),
      where: { id: ID },
    });
    expect(tx.machineStatusHistory.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'machine.deleted',
        context: { reason: 'Registry correction' },
      }),
    );

    tx.machine.findUnique.mockResolvedValueOnce({ ...machineRow, deletedAt: now } as never);
    await expect(service.delete(actor, ID, {}, 'request')).rejects.toBeInstanceOf(
      MachineAlreadyDeletedException,
    );
  });

  it('blocks deletion after a committed open session or active booking becomes visible', async () => {
    const open = makeHarness();
    open.tx.usageSession.count.mockResolvedValueOnce(1);
    await expect(open.service.delete(actor, ID, {}, 'request')).rejects.toBeInstanceOf(
      MachineHasOpenSessionException,
    );
    expect(open.tx.machine.update).not.toHaveBeenCalled();

    const booked = makeHarness();
    booked.tx.booking.count.mockResolvedValueOnce(2);
    await expect(booked.service.delete(actor, ID, {}, 'request')).rejects.toBeInstanceOf(
      MachineHasActiveBookingsException,
    );
    expect(booked.tx.booking.count).toHaveBeenCalledWith({
      where: {
        machineId: ID,
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
      },
    });
    expect(booked.tx.machine.update).not.toHaveBeenCalled();
  });

  it('restores only deleted rows, preserves condition/history, and audits atomically', async () => {
    const { audit, service, tx } = makeHarness();
    tx.machine.findUnique.mockResolvedValueOnce({ ...machineRow, deletedAt: now } as never);
    tx.machine.update.mockResolvedValueOnce({ ...machineRow, deletedAt: null } as never);
    await expect(
      service.restore(actor, ID, { reason: 'Approved registry return' }, 'request'),
    ).resolves.toMatchObject({ condition: 'OPERATIONAL', registryStatus: 'ACTIVE' });
    expect(tx.machine.update).toHaveBeenCalledWith({
      data: { deletedAt: null },
      select: expect.any(Object),
      where: { id: ID },
    });
    expect(tx.machineStatusHistory.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'machine.restored',
        context: { reason: 'Approved registry return' },
      }),
    );

    const active = makeHarness();
    await expect(active.service.restore(actor, ID, {}, 'request')).rejects.toBeInstanceOf(
      MachineNotDeletedException,
    );

    const auditFailure = makeHarness();
    auditFailure.tx.machine.findUnique.mockResolvedValueOnce({
      ...machineRow,
      deletedAt: now,
    } as never);
    auditFailure.audit.record.mockRejectedValueOnce(new Error('audit failed'));
    await expect(auditFailure.service.restore(actor, ID, {}, 'request')).rejects.toThrow(
      'audit failed',
    );
  });

  it('serializes simultaneous restore attempts so exactly one succeeds', async () => {
    const harness = makeHarness();
    harness.tx.machine.findUnique
      .mockResolvedValueOnce({ ...machineRow, deletedAt: now } as never)
      .mockResolvedValueOnce(machineRow as never);
    const outcomes = await Promise.allSettled([
      harness.service.restore(actor, ID, {}, 'request-a'),
      harness.service.restore(actor, ID, {}, 'request-b'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(MachineNotDeletedException);
  });
});
