import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { ApiEnvironment } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UserInactiveException, UserNotProvisionedException } from './auth.errors';
import { SupabaseAdminService } from './supabase-admin.service';
import { UserSessionService } from './user-session.service';

const subject = '11111111-1111-4111-8111-111111111111';
const differentSubject = '66666666-6666-4666-8666-666666666666';
const userId = '22222222-2222-4222-8222-222222222222';
const bootstrapEmail = 'first.admin@hospital.test';

const baseUser = {
  department: { code: 'ICU', id: '33333333-3333-4333-8333-333333333333', name: 'ICU' },
  email: 'staff@hospital.test',
  fullName: 'Hospital Staff',
  id: userId,
  isActive: true,
  isSeedData: false,
  lastLoginAt: null,
  role: 'STAFF' as const,
  supabaseUserId: subject,
};

type UpdateArguments = {
  data: { lastLoginAt: Date };
  where: {
    OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: Date } }];
    id: string;
  };
};

const configWithBootstrap = (email?: string) =>
  ({
    get: jest.fn((key: keyof ApiEnvironment) =>
      key === 'BOOTSTRAP_SUPER_ADMIN_EMAIL' ? email : undefined,
    ),
  }) as unknown as ConfigService<ApiEnvironment, true>;

const createPrisma = () => ({
  $transaction: jest.fn<(callback: unknown) => Promise<unknown>>(),
  user: {
    findUnique: jest.fn<(arguments_: unknown) => Promise<unknown>>(),
    updateMany: jest.fn<(arguments_: UpdateArguments) => Promise<{ count: number }>>(async () => ({
      count: 1,
    })),
  },
});

const createAdmin = () => ({
  getVerifiedUser: jest.fn<(userId: string) => Promise<unknown>>(),
});

describe('UserSessionService', () => {
  it('resolves a non-seed active user by Supabase identity and returns only the public view', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(baseUser);
    const service = new UserSessionService(
      configWithBootstrap(),
      prisma as unknown as PrismaService,
      createAdmin() as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(subject)).resolves.toEqual({
      department: baseUser.department,
      email: baseUser.email,
      fullName: baseUser.fullName,
      id: baseUser.id,
      isActive: true,
      role: 'STAFF',
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { supabaseUserId: subject } }),
    );
  });

  it('rejects inactive users without updating last login', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue({ ...baseUser, isActive: false });
    const service = new UserSessionService(
      configWithBootstrap(),
      prisma as unknown as PrismaService,
      createAdmin() as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(subject)).rejects.toBeInstanceOf(UserInactiveException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('defensively refuses seed data even if an identity were returned', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue({ ...baseUser, isSeedData: true });
    const service = new UserSessionService(
      configWithBootstrap(),
      prisma as unknown as PrismaService,
      createAdmin() as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(subject)).rejects.toBeInstanceOf(UserNotProvisionedException);
  });

  it('does not auto-provision or attempt email linking when identity is missing', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const admin = createAdmin();
    const service = new UserSessionService(
      configWithBootstrap(),
      prisma as unknown as PrismaService,
      admin as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(subject)).rejects.toBeInstanceOf(UserNotProvisionedException);
    expect(admin.getVerifiedUser).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('uses one conditional write for rapid last-login resolutions', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(baseUser);
    let persistedLastLogin: Date | null = null;
    let writes = 0;
    prisma.user.updateMany.mockImplementation(async (arguments_: UpdateArguments) => {
      const cutoff = arguments_.where.OR[1].lastLoginAt.lt;

      if (persistedLastLogin === null || persistedLastLogin < cutoff) {
        persistedLastLogin = arguments_.data.lastLoginAt;
        writes += 1;
        return { count: 1 };
      }

      return { count: 0 };
    });
    const service = new UserSessionService(
      configWithBootstrap(),
      prisma as unknown as PrismaService,
      createAdmin() as unknown as SupabaseAdminService,
    );
    const now = new Date('2026-10-24T08:00:00.000Z');

    await service.resolve(subject, now);
    await service.resolve(subject, new Date(now.getTime() + 60_000));

    expect(writes).toBe(1);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      data: { lastLoginAt: now },
      where: {
        id: userId,
        OR: [
          { lastLoginAt: null },
          { lastLoginAt: { lt: new Date(now.getTime() - 5 * 60 * 1_000) } },
        ],
      },
    });
  });

  it('bootstraps the first verified real SUPER_ADMIN inside the locked transaction', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const admin = createAdmin();
    admin.getVerifiedUser.mockResolvedValue({ email: bootstrapEmail, id: subject });
    const bootstrapped = {
      ...baseUser,
      email: bootstrapEmail,
      fullName: 'Initial Super Administrator',
      lastLoginAt: new Date('2026-10-24T08:00:00.000Z'),
      role: 'SUPER_ADMIN' as const,
    };
    const transaction = {
      $queryRaw: jest.fn(async () => [{ lock_result: '' }]),
      user: {
        create: jest.fn(async () => bootstrapped),
        findFirst: jest
          .fn<(arguments_: unknown) => Promise<unknown>>()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        findUnique: jest.fn(async () => null),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: unknown) =>
      (callback as (client: typeof transaction) => Promise<unknown>)(transaction),
    );
    const service = new UserSessionService(
      configWithBootstrap(bootstrapEmail),
      prisma as unknown as PrismaService,
      admin as unknown as SupabaseAdminService,
    );

    await expect(
      service.resolve(subject, new Date('2026-10-24T08:00:00.000Z')),
    ).resolves.toMatchObject({ id: userId, role: 'SUPER_ADMIN' });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isSeedData: false,
          role: 'SUPER_ADMIN',
          supabaseUserId: subject,
        }),
      }),
    );
  });

  it.each([
    ['unverified or missing Admin identity', null],
    ['different verified email', { email: 'other@hospital.test', id: subject }],
    ['reserved seed address', { email: 'seed@example.invalid', id: subject }],
  ])('refuses bootstrap for %s', async (_name, verifiedUser) => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const admin = createAdmin();
    admin.getVerifiedUser.mockResolvedValue(verifiedUser);
    const configuredEmail =
      verifiedUser !== null && verifiedUser.email.endsWith('.invalid')
        ? verifiedUser.email
        : bootstrapEmail;
    const service = new UserSessionService(
      configWithBootstrap(configuredEmail),
      prisma as unknown as PrismaService,
      admin as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(subject)).rejects.toBeInstanceOf(UserNotProvisionedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('makes the bootstrap variable ineffective for a different identity once an active real SUPER_ADMIN exists', async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const admin = createAdmin();
    admin.getVerifiedUser.mockResolvedValue({ email: bootstrapEmail, id: subject });
    const transaction = {
      $queryRaw: jest.fn(async () => [{ lock_result: '' }]),
      user: {
        create: jest.fn(),
        findFirst: jest
          .fn<(arguments_: unknown) => Promise<unknown>>()
          .mockResolvedValueOnce({ id: 'existing-super-admin' })
          .mockResolvedValueOnce(null),
        findUnique: jest.fn(async () => null),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: unknown) =>
      (callback as (client: typeof transaction) => Promise<unknown>)(transaction),
    );
    const service = new UserSessionService(
      configWithBootstrap(bootstrapEmail),
      prisma as unknown as PrismaService,
      admin as unknown as SupabaseAdminService,
    );

    await expect(service.resolve(differentSubject)).rejects.toBeInstanceOf(
      UserNotProvisionedException,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { supabaseUserId: differentSubject } }),
    );
    expect(admin.getVerifiedUser).toHaveBeenCalledWith(differentSubject);
    expect(transaction.user.create).not.toHaveBeenCalled();
  });
});
