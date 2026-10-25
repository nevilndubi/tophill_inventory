import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { AuthenticatedUser } from '../auth/auth.types';
import { SupabaseAdminRequestError, SupabaseAdminService } from '../auth/supabase-admin.service';
import { AuditService } from '../audit/audit.service';
import type { ApiEnvironment } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthIdentityExistsException,
  LastSuperAdminException,
  OrphanedAuthIdentityException,
  SeedUserProtectedException,
  UserAlreadyExistsException,
  UserManagementDeniedException,
  UserManagementUnavailableException,
} from './users.errors';
import { UsersService } from './users.service';

const department = {
  code: 'ICU',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Intensive Care Unit',
};

const actor = (role: AuthenticatedUser['role'] = 'SUPER_ADMIN'): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test Actor',
  id: '22222222-2222-4222-8222-222222222222',
  isActive: true,
  role,
});

type TestLocalUser = {
  department: typeof department | null;
  departmentId: string | null;
  email: string;
  fullName: string;
  id: string;
  isActive: boolean;
  isSeedData: boolean;
  lastLoginAt: Date | null;
  role: AuthenticatedUser['role'];
};

const localUser = (overrides: Partial<TestLocalUser> = {}): TestLocalUser => ({
  department,
  departmentId: department.id,
  email: 'redacted-for-test',
  fullName: 'Managed User',
  id: '33333333-3333-4333-8333-333333333333',
  isActive: true,
  isSeedData: false,
  lastLoginAt: null,
  role: 'STAFF',
  ...overrides,
});

const makeHarness = () => {
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: 'admin-a' }, { id: 'admin-b' }]),
    auditLog: { create: jest.fn(async () => ({})) },
    department: {
      findMany: jest.fn<
        () => Promise<
          Array<{ code: string; id: string; managerUserId: string | null; name: string }>
        >
      >(async () => []),
      findUnique: jest.fn<(arguments_: unknown) => Promise<{ id: string } | null>>(async () => ({
        id: department.id,
      })),
      update: jest.fn(async () => ({})),
    },
    user: {
      create: jest.fn(async () => localUser()),
      findUnique: jest.fn<(arguments_: unknown) => Promise<TestLocalUser | null>>(async () =>
        localUser(),
      ),
      update: jest.fn<(arguments_: unknown) => Promise<TestLocalUser>>(async () => localUser()),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (argument: unknown) => {
      if (Array.isArray(argument)) return Promise.all(argument);
      return (argument as (transaction: typeof tx) => Promise<unknown>)(tx);
    }),
    department: {
      findMany: jest.fn(async () => [department]),
      findUnique: jest.fn<(arguments_: unknown) => Promise<{ id: string } | null>>(async () => ({
        id: department.id,
      })),
    },
    user: {
      count: jest.fn(async () => 1),
      findFirst: jest.fn<(arguments_: unknown) => Promise<{ id: string } | null>>(async () => null),
      findMany: jest.fn<(arguments_: unknown) => Promise<TestLocalUser[]>>(async () => [
        localUser(),
      ]),
    },
  };
  const supabase = {
    deleteUser: jest.fn(async () => true),
    findUserIdByEmail: jest.fn<(email: string) => Promise<string | null>>(async () => null),
    inviteUserByEmail: jest.fn(async () => ({ id: '44444444-4444-4444-8444-444444444444' })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const config = { get: jest.fn(() => 'http://127.0.0.1:3000') };
  const service = new UsersService(
    config as unknown as ConfigService<ApiEnvironment, true>,
    prisma as unknown as PrismaService,
    supabase as unknown as SupabaseAdminService,
    audit as unknown as AuditService,
  );
  return { audit, prisma, service, supabase, tx };
};

describe(UsersService.name, () => {
  it('lists only minimized non-seed fields with stable pagination and escaped search', async () => {
    const { prisma, service } = makeHarness();
    const result = await service.list({ page: 2, pageSize: 25, search: '%_ward' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: 25,
        take: 25,
        where: expect.objectContaining({ isSeedData: false }),
      }),
    );
    const { where } = prisma.user.findMany.mock.calls[0]?.[0] as {
      where: { OR?: Array<{ email?: { contains?: string } }> };
    };
    expect(where.OR?.[0]?.email?.contains).toBe('\\%\\_ward');
    expect(result.items[0]).toEqual({
      department,
      email: 'redacted-for-test',
      fullName: 'Managed User',
      id: '33333333-3333-4333-8333-333333333333',
      isActive: true,
      lastLoginAt: null,
      role: 'STAFF',
    });
    expect(JSON.stringify(result)).not.toMatch(/supabase|isSeedData|createdAt|updatedAt/);
  });

  it('returns department choices without creating department CRUD', async () => {
    const { service } = makeHarness();
    await expect(service.listDepartments()).resolves.toEqual([department]);
  });

  it('creates one identity, one Neon row and one audit record for an invitation', async () => {
    const { audit, service, supabase, tx } = makeHarness();
    const result = await service.invite(
      actor(),
      {
        departmentId: department.id,
        email: 'test@example.test',
        fullName: 'Test Person',
        role: 'STAFF',
      },
      'request-1',
    );

    expect(supabase.inviteUserByEmail).toHaveBeenCalledWith(
      'test@example.test',
      'Test Person',
      'http://127.0.0.1:3000/auth/confirm',
    );
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSeedData: false, supabaseUserId: expect.any(String) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'user.invited', requestId: 'request-1' }),
    );
    expect(result.id).toBeDefined();
  });

  it('rejects retries and pre-existing auth identities without creating another identity', async () => {
    const local = makeHarness();
    local.prisma.user.findFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(
      local.service.invite(
        actor(),
        { email: 'test@example.test', fullName: 'Test', role: 'STAFF' },
        'request',
      ),
    ).rejects.toBeInstanceOf(UserAlreadyExistsException);
    expect(local.supabase.inviteUserByEmail).not.toHaveBeenCalled();

    const auth = makeHarness();
    auth.supabase.findUserIdByEmail.mockResolvedValueOnce('existing-auth-id');
    await expect(
      auth.service.invite(
        actor(),
        { email: 'test@example.test', fullName: 'Test', role: 'STAFF' },
        'request',
      ),
    ).rejects.toBeInstanceOf(AuthIdentityExistsException);
    expect(auth.supabase.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('compensates a failed Neon insert and detects an uncompensated orphan', async () => {
    const compensated = makeHarness();
    compensated.tx.user.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      compensated.service.invite(
        actor(),
        { email: 'test@example.test', fullName: 'Test', role: 'STAFF' },
        'request',
      ),
    ).rejects.toBeInstanceOf(UserAlreadyExistsException);
    expect(compensated.supabase.deleteUser).toHaveBeenCalledTimes(1);

    const orphaned = makeHarness();
    orphaned.tx.user.create.mockRejectedValueOnce(new Error('database unavailable'));
    orphaned.supabase.deleteUser.mockResolvedValueOnce(false);
    await expect(
      orphaned.service.invite(
        actor(),
        { email: 'test@example.test', fullName: 'Test', role: 'STAFF' },
        'request',
      ),
    ).rejects.toBeInstanceOf(OrphanedAuthIdentityException);
  });

  it('maps Supabase outages to a stable availability error', async () => {
    const { service, supabase } = makeHarness();
    supabase.findUserIdByEmail.mockRejectedValueOnce(new SupabaseAdminRequestError());
    await expect(
      service.invite(
        actor(),
        { email: 'test@example.test', fullName: 'Test', role: 'STAFF' },
        'request',
      ),
    ).rejects.toBeInstanceOf(UserManagementUnavailableException);
  });

  it.each([
    ['ADMIN cannot invite SUPER_ADMIN', actor('ADMIN'), 'SUPER_ADMIN' as const],
    ['STAFF cannot invite users', actor('STAFF'), 'STAFF' as const],
  ])('%s', async (_label, actingUser, role) => {
    const { service } = makeHarness();
    await expect(
      service.invite(actingUser, { email: 'test@example.test', fullName: 'Test', role }, 'request'),
    ).rejects.toBeInstanceOf(UserManagementDeniedException);
  });

  it('requires a real department for a department manager', async () => {
    const { prisma, service } = makeHarness();
    prisma.department.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.invite(
        actor(),
        {
          departmentId: department.id,
          email: 'test@example.test',
          fullName: 'Test',
          role: 'DEPT_MANAGER',
        },
        'request',
      ),
    ).rejects.toThrow('The selected department does not exist');
  });

  it('rejects seed users, ADMIN-over-SUPER_ADMIN, and self role or department changes', async () => {
    const seed = makeHarness();
    seed.tx.user.findUnique.mockResolvedValueOnce(localUser({ isSeedData: true }));
    await expect(
      seed.service.update(actor(), 'target', { role: 'STAFF' }, 'request'),
    ).rejects.toBeInstanceOf(SeedUserProtectedException);

    const protectedAdmin = makeHarness();
    protectedAdmin.tx.user.findUnique.mockResolvedValueOnce(localUser({ role: 'SUPER_ADMIN' }));
    await expect(
      protectedAdmin.service.update(actor('ADMIN'), 'target', { role: 'STAFF' }, 'request'),
    ).rejects.toBeInstanceOf(UserManagementDeniedException);

    const self = makeHarness();
    self.tx.user.findUnique.mockResolvedValueOnce(localUser({ id: actor().id }));
    await expect(
      self.service.update(actor(), actor().id, { departmentId: null }, 'request'),
    ).rejects.toBeInstanceOf(UserManagementDeniedException);
  });

  it('protects the final active SUPER_ADMIN from demotion and deactivation', async () => {
    const demotion = makeHarness();
    demotion.tx.$queryRaw.mockResolvedValueOnce([{ id: 'only-admin' }]);
    demotion.tx.user.findUnique.mockResolvedValueOnce(localUser({ role: 'SUPER_ADMIN' }));
    await expect(
      demotion.service.update(actor(), 'target', { role: 'ADMIN' }, 'request'),
    ).rejects.toBeInstanceOf(LastSuperAdminException);

    const deactivation = makeHarness();
    deactivation.tx.$queryRaw.mockResolvedValueOnce([{ id: 'only-admin' }]);
    deactivation.tx.user.findUnique.mockResolvedValueOnce(localUser({ role: 'SUPER_ADMIN' }));
    await expect(
      deactivation.service.setActive(actor(), 'target', false, 'request'),
    ).rejects.toBeInstanceOf(LastSuperAdminException);
  });

  it('writes role and department audit rows inside the same transaction', async () => {
    const { audit, service, tx } = makeHarness();
    tx.user.findUnique.mockResolvedValueOnce(localUser({ departmentId: null, department: null }));
    tx.user.update.mockResolvedValueOnce(localUser({ role: 'ADMIN' }));
    await service.update(
      actor(),
      'target',
      { departmentId: department.id, role: 'ADMIN' },
      'request-2',
    );

    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'user.role_changed' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'user.department_changed' }),
    );
  });

  it('rolls back the user mutation when audit recording fails', async () => {
    const { audit, service } = makeHarness();
    audit.record.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(service.setActive(actor(), 'target', false, 'request')).rejects.toThrow(
      'audit insert failed',
    );
  });

  it('allows exactly one of two concurrent changes to the final two active SUPER_ADMINs', async () => {
    const { audit, prisma, service, tx } = makeHarness();
    const users = new Map([
      ['admin-a', localUser({ id: 'admin-a', role: 'SUPER_ADMIN' })],
      ['admin-b', localUser({ id: 'admin-b', role: 'SUPER_ADMIN' })],
    ]);
    let queue = Promise.resolve();
    prisma.$transaction.mockImplementation((callback: unknown) => {
      const run = queue.then(() => (callback as (transaction: typeof tx) => Promise<unknown>)(tx));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
    tx.$queryRaw.mockImplementation(async () =>
      [...users.values()]
        .filter((user) => user.role === 'SUPER_ADMIN' && user.isActive)
        .map((user) => ({ id: user.id })),
    );
    tx.user.findUnique.mockImplementation(async (arguments_: unknown) => {
      const { where } = arguments_ as { where: { id: string } };
      return users.get(where.id) ?? null;
    });
    tx.user.update.mockImplementation(async (arguments_: unknown) => {
      const { data, where } = arguments_ as {
        data: { isActive: boolean };
        where: { id: string };
      };
      const current = users.get(where.id)!;
      const updated = { ...current, isActive: data.isActive };
      users.set(where.id, updated);
      return updated;
    });
    audit.record.mockResolvedValue(undefined);

    const results = await Promise.allSettled([
      service.setActive(actor('SUPER_ADMIN'), 'admin-b', false, 'first'),
      service.setActive({ ...actor('SUPER_ADMIN'), id: 'admin-b' }, 'admin-a', false, 'second'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      [...users.values()].filter((user) => user.role === 'SUPER_ADMIN' && user.isActive),
    ).toHaveLength(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['deactivation', 'active'],
    ['role change', 'role'],
    ['department move', 'department'],
  ])('clears a managed department with an audit on %s', async (_label, change) => {
    const { audit, service, tx } = makeHarness();
    const manager = localUser({ role: 'DEPT_MANAGER' });
    tx.user.findUnique.mockResolvedValueOnce(manager);
    tx.department.findMany.mockResolvedValueOnce([{ ...department, managerUserId: manager.id }]);
    if (change === 'active') {
      tx.user.update.mockResolvedValueOnce({ ...manager, isActive: false });
      await service.setActive(actor(), manager.id, false, 'manager-change');
    } else if (change === 'role') {
      tx.user.update.mockResolvedValueOnce({ ...manager, role: 'STAFF' });
      await service.update(actor(), manager.id, { role: 'STAFF' }, 'manager-change');
    } else {
      const otherDepartment = '99999999-9999-4999-8999-999999999999';
      tx.user.update.mockResolvedValueOnce({ ...manager, departmentId: otherDepartment });
      await service.update(
        actor(),
        manager.id,
        { departmentId: otherDepartment },
        'manager-change',
      );
    }
    expect(tx.department.update).toHaveBeenCalledWith({
      data: { managerUserId: null },
      where: { id: department.id },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'department.manager_cleared', entityId: department.id }),
    );
  });
});
