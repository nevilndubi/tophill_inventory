import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../../src/generated/prisma/client';
import { assertSafeIntegrationDatabaseEnvironment } from './database-guard';

type PrismaError = Error & { code?: string };

const expectPrismaError = async (operation: Promise<unknown>, code: string): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    expect((error as PrismaError).code).toBe(code);
    return;
  }

  throw new Error(`Expected Prisma error ${code}`);
};

const pauseForTimestampPrecision = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('User, Department, and Location database integration', () => {
  const integration = assertSafeIntegrationDatabaseEnvironment(process.env);
  const runId = `t12-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const departmentIds = new Set<string>();
  const locationIds = new Set<string>();
  const userIds = new Set<string>();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: integration.url, max: 4 }),
  });

  const createDepartment = async (suffix: string) => {
    const department = await prisma.department.create({
      data: {
        code: `${runId}-${suffix}`,
        name: `${runId} Department ${suffix}`,
      },
    });
    departmentIds.add(department.id);
    return department;
  };

  const createUser = async (
    suffix: string,
    options: { departmentId?: string; email?: string; role?: Role } = {},
  ) => {
    const user = await prisma.user.create({
      data: {
        departmentId: options.departmentId,
        email: options.email ?? `${runId}-${suffix}@example.com`,
        fullName: `Task 1.2 User ${suffix}`,
        role: options.role ?? Role.STAFF,
        supabaseUserId: randomUUID(),
      },
    });
    userIds.add(user.id);
    return user;
  };

  const createLocation = async (departmentId: string, suffix: string) => {
    const location = await prisma.location.create({
      data: {
        building: 'North Wing',
        departmentId,
        floor: '3',
        name: `${runId} Location ${suffix}`,
        room: `Room ${suffix}`,
      },
    });
    locationIds.add(location.id);
    return location;
  };

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.location.deleteMany({ where: { id: { in: [...locationIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
    await prisma.department.deleteMany({ where: { id: { in: [...departmentIds] } } });
    await prisma.$disconnect();
  });

  it('inserts and reads every model with the named manager and member relations', async () => {
    const department = await createDepartment('relations');
    const manager = await createUser('manager', {
      departmentId: department.id,
      role: Role.DEPT_MANAGER,
    });
    const location = await createLocation(department.id, 'relations');

    await prisma.department.update({
      data: { managerUserId: manager.id },
      where: { id: department.id },
    });

    const stored = await prisma.department.findUniqueOrThrow({
      include: { locations: true, manager: true, members: true },
      where: { id: department.id },
    });

    expect(stored.manager?.id).toBe(manager.id);
    expect(stored.members.map((member) => member.id)).toContain(manager.id);
    expect(stored.locations.map((item) => item.id)).toContain(location.id);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toBeInstanceOf(Date);

    const previousUpdatedAt = stored.updatedAt;
    await pauseForTimestampPrecision();
    const updated = await prisma.department.update({
      data: { name: `${stored.name} updated` },
      where: { id: stored.id },
    });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(previousUpdatedAt.getTime());
  });

  it('enforces model uniqueness and normalizes email before case-insensitive comparison', async () => {
    const firstDepartment = await createDepartment('unique-a');
    const secondDepartment = await createDepartment('unique-b');

    await expectPrismaError(
      prisma.department.create({
        data: { code: `${runId}-unique-name`, name: firstDepartment.name },
      }),
      'P2002',
    );
    await expectPrismaError(
      prisma.department.create({
        data: { code: firstDepartment.code, name: `${runId} Other Department` },
      }),
      'P2002',
    );

    const firstLocation = await createLocation(firstDepartment.id, 'unique');
    await expectPrismaError(
      prisma.location.create({
        data: { departmentId: firstDepartment.id, name: firstLocation.name },
      }),
      'P2002',
    );
    const sameNameElsewhere = await prisma.location.create({
      data: { departmentId: secondDepartment.id, name: firstLocation.name },
    });
    locationIds.add(sameNameElsewhere.id);

    const mixedCaseEmail = `${runId}-Case@Example.com`;
    const firstUser = await createUser('case-email', { email: mixedCaseEmail });
    expect(firstUser.email).toBe(mixedCaseEmail.toLowerCase());

    await expectPrismaError(
      prisma.user.create({
        data: {
          email: mixedCaseEmail.toLowerCase(),
          fullName: 'Duplicate email',
          role: Role.VIEWER,
          supabaseUserId: randomUUID(),
        },
      }),
      'P2002',
    );
    await expectPrismaError(
      prisma.user.create({
        data: {
          email: `${runId}-other@example.com`,
          fullName: 'Duplicate identity',
          role: Role.VIEWER,
          supabaseUserId: firstUser.supabaseUserId,
        },
      }),
      'P2002',
    );
  });

  it('sets a department manager reference to null when the manager is deleted', async () => {
    const department = await createDepartment('manager-delete');
    const manager = await createUser('manager-delete');
    await prisma.department.update({
      data: { managerUserId: manager.id },
      where: { id: department.id },
    });

    await prisma.user.delete({ where: { id: manager.id } });
    const stored = await prisma.department.findUniqueOrThrow({ where: { id: department.id } });

    expect(stored.managerUserId).toBeNull();
  });

  it('blocks department deletion while members exist and never cascades users', async () => {
    const department = await createDepartment('member-delete');
    const member = await createUser('member-delete', { departmentId: department.id });

    await expectPrismaError(prisma.department.delete({ where: { id: department.id } }), 'P2003');
    expect(await prisma.user.findUnique({ where: { id: member.id } })).not.toBeNull();

    await prisma.user.update({
      data: { departmentId: null },
      where: { id: member.id },
    });
    await prisma.department.delete({ where: { id: department.id } });

    expect(await prisma.user.findUnique({ where: { id: member.id } })).not.toBeNull();
  });

  it('blocks department deletion while locations exist', async () => {
    const department = await createDepartment('location-delete');
    const location = await createLocation(department.id, 'delete-block');

    await expectPrismaError(prisma.department.delete({ where: { id: department.id } }), 'P2003');
    expect(await prisma.location.findUnique({ where: { id: location.id } })).not.toBeNull();
  });
});
