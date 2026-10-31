import { jest } from '@jest/globals';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CategoryInUseException,
  CategoryNameTakenException,
  CategoryNotFoundException,
} from './categories.errors';
import { CategoriesService } from './categories.service';

const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Administrator',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role: 'ADMIN',
};

const category = {
  createdAt: new Date('2026-01-01T00:00:00Z'),
  defaultMaxBookingMinutes: 120,
  defaultServiceIntervalDays: 180,
  description: 'Life support equipment',
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ventilator',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const row = { ...category, machineCount: 2, totalMachineCount: 3 };

const makeHarness = () => {
  const tx = {
    $queryRaw: jest.fn(async () => [{ value: 15 }]),
    machine: { count: jest.fn(async () => 0) },
    machineCategory: {
      create: jest.fn(async () => category),
      delete: jest.fn(async () => category),
      findUnique: jest.fn<() => Promise<typeof category | null>>(async () => category),
      update: jest.fn(async () => category),
    },
  };
  const prisma = {
    $queryRaw: jest.fn(async () => [row]),
    $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    ),
    machine: { count: jest.fn(async () => 1) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new CategoriesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { audit, prisma, service, tx };
};

describe(CategoriesService.name, () => {
  it('uses one grouped read and separates active counts from all-reference deletion state', async () => {
    const { prisma, service } = makeHarness();
    await expect(service.read()).resolves.toEqual([
      expect.objectContaining({ is_deletable: false, machine_count: 2, name: 'Ventilator' }),
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns a minimized record and CATEGORY_NOT_FOUND for a missing id', async () => {
    const { prisma, service } = makeHarness();
    const result = await service.read(category.id);
    expect(result).toEqual({
      defaultMaxBookingMinutes: 120,
      defaultServiceIntervalDays: 180,
      description: 'Life support equipment',
      id: category.id,
      is_deletable: false,
      machine_count: 2,
      name: 'Ventilator',
    });
    expect(JSON.stringify(result)).not.toMatch(/createdAt|updatedAt/);

    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.read(category.id)).rejects.toBeInstanceOf(CategoryNotFoundException);
  });

  it('audits create and update in their transactions using category-only state', async () => {
    const { audit, service } = makeHarness();
    await service.create(actor, { name: 'Ventilator' }, 'request-create');
    await service.update(actor, category.id, { description: null }, 'request-update');
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        action: 'category.created',
        entityType: 'category',
        requestId: 'request-create',
      }),
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ action: 'category.updated', before: expect.any(Object) }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/createdAt|updatedAt/);
  });

  it('keeps the mutation and audit in one transaction so an audit failure aborts the write', async () => {
    const { audit, prisma, service, tx } = makeHarness();
    audit.record.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(service.create(actor, { name: 'Ventilator' }, 'request')).rejects.toThrow(
      'audit insert failed',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.machineCategory.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ entityType: 'category' }),
    );
  });

  it('maps create and rename uniqueness races to CATEGORY_NAME_TAKEN', async () => {
    const created = makeHarness();
    created.tx.machineCategory.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      created.service.create(actor, { name: 'Ventilator' }, 'request'),
    ).rejects.toBeInstanceOf(CategoryNameTakenException);

    const updated = makeHarness();
    updated.tx.machineCategory.update.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      updated.service.update(actor, category.id, { name: ' ventilator ' }, 'request'),
    ).rejects.toBeInstanceOf(CategoryNameTakenException);
  });

  it('blocks every machine reference, including a soft-deleted-only reference, without auditing', async () => {
    const { audit, service, tx } = makeHarness();
    tx.machine.count.mockResolvedValueOnce(1);
    await expect(service.delete(actor, category.id, 'request')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CATEGORY_IN_USE',
        details: { machine_count: 1 },
      }),
    });
    expect(tx.machineCategory.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits a successful delete and maps a P2003 race using a fresh reference count', async () => {
    const successful = makeHarness();
    await expect(successful.service.delete(actor, category.id, 'request')).resolves.toMatchObject({
      is_deletable: true,
      machine_count: 0,
    });
    expect(successful.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'category.deleted', before: expect.any(Object) }),
    );

    const raced = makeHarness();
    raced.tx.machineCategory.delete.mockRejectedValueOnce({ code: 'P2003' });
    raced.prisma.machine.count.mockResolvedValueOnce(4);
    await expect(raced.service.delete(actor, category.id, 'request')).rejects.toBeInstanceOf(
      CategoryInUseException,
    );
    expect(raced.prisma.machine.count).toHaveBeenCalledWith({ where: { categoryId: category.id } });
  });

  it('rejects update and delete of missing records without writing an audit row', async () => {
    const { audit, service, tx } = makeHarness();
    tx.machineCategory.findUnique.mockResolvedValue(null);
    await expect(
      service.update(actor, category.id, { name: 'Other' }, 'request'),
    ).rejects.toBeInstanceOf(CategoryNotFoundException);
    await expect(service.delete(actor, category.id, 'request')).rejects.toBeInstanceOf(
      CategoryNotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
