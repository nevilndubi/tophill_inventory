import { jest } from '@jest/globals';
import { checkInMachineSchema, checkOutMachineSchema, type MachineCondition } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MachineNotFoundException } from '../machines/machines.errors';
import type { UsageClockService } from './usage-clock.service';
import {
  ForceNotApplicableException,
  MachineBusyException,
  MachineInUseException,
  MachineNotAvailableException,
  NoOpenSessionException,
  SessionNotHeldException,
  UpcomingBookingConflictException,
  UsageExpectedEndInvalidException,
  UsageSettingsInvalidException,
} from './usage.errors';
import type { UsageEventsService } from './usage-events.service';
import { UsageService } from './usage.service';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const HOLDER_ID = '33333333-3333-4333-8333-333333333333';
const DEPARTMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DEPARTMENT_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-29T09:00:00.000Z');

const actor = (
  role: AuthenticatedUser['role'] = 'STAFF',
  id = ACTOR_ID,
  departmentId: string | null = DEPARTMENT_ID,
): AuthenticatedUser => ({
  department:
    departmentId === null ? null : { code: 'ICU', id: departmentId, name: 'Intensive Care Unit' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id,
  isActive: true,
  role,
});

const makeHarness = (
  options: {
    allowBookingWhenNeedsService?: boolean;
    condition?: MachineCondition;
    deletedAt?: Date | null;
    machineExists?: boolean;
    sessionUserId?: string | null;
  } = {},
) => {
  const sessionUserId = options.sessionUserId;
  const machine = {
    allowBookingWhenNeedsService: options.allowBookingWhenNeedsService ?? false,
    condition: options.condition ?? ('OPERATIONAL' as MachineCondition),
    deletedAt: options.deletedAt ?? null,
    departmentId: DEPARTMENT_ID,
    id: MACHINE_ID,
  };
  const openSession =
    sessionUserId === undefined || sessionUserId === null
      ? null
      : {
          endedAt: null,
          expectedEndAt: new Date('2026-10-29T11:00:00.000Z'),
          id: SESSION_ID,
          machineId: MACHINE_ID,
          purpose: 'Ward round',
          startedAt: new Date('2026-10-29T08:00:00.000Z'),
          user: { fullName: 'Session Holder', id: sessionUserId },
          userId: sessionUserId,
        };
  const created = {
    endedAt: null,
    expectedEndAt: null as Date | null,
    id: SESSION_ID,
    machineId: MACHINE_ID,
    purpose: 'General equipment use',
    startedAt: NOW,
    userId: ACTOR_ID,
  };
  const tx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => (options.machineExists === false ? [] : [machine])),
    appSetting: {
      findUnique: jest.fn<() => Promise<{ value: unknown } | null>>(async () => ({ value: 30 })),
    },
    auditLog: { create: jest.fn(async () => undefined) },
    booking: {
      findFirst: jest.fn<() => Promise<{ startsAt: Date } | null>>(async () => null),
    },
    usageSession: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(created, data);
        return created;
      }),
      findFirst: jest.fn(async () => openSession),
      update: jest.fn(async ({ data }: { data: { endedAt: Date; endNote?: string } }) => ({
        ...openSession!,
        ...data,
      })),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    usageSession: { findFirst: jest.fn(async () => openSession) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const events = { emit: jest.fn(async () => undefined) };
  const clock = { now: jest.fn(async () => NOW) };
  const service = new UsageService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    events as unknown as UsageEventsService,
    clock as unknown as UsageClockService,
  );
  return { audit, clock, created, events, machine, openSession, prisma, service, tx };
};

describe('usage session schemas', () => {
  it('normalizes purpose and rejects unknown fields/control characters', () => {
    expect(checkOutMachineSchema.parse({ purpose: '  Ward   round  ' })).toEqual({
      purpose: 'Ward round',
    });
    expect(() => checkOutMachineSchema.parse({ extra: true })).toThrow();
    expect(() => checkOutMachineSchema.parse({ purpose: 'unsafe\u0000text' })).toThrow();
  });

  it('requires offset-bearing timestamps and validates force reason semantics', () => {
    expect(() => checkOutMachineSchema.parse({ expectedEndAt: '2026-10-29T10:00:00' })).toThrow();
    expect(checkInMachineSchema.parse({})).toEqual({ force: false });
    expect(() => checkInMachineSchema.parse({ force: true, reason: 'short' })).toThrow();
    expect(() => checkInMachineSchema.parse({ reason: 'Not a forced end' })).toThrow();
  });
});

describe('UsageService', () => {
  it.each([
    ['OPERATIONAL', false, true],
    ['NEEDS_SERVICE', true, true],
    ['NEEDS_SERVICE', false, false],
    ['UNDER_MAINTENANCE', true, false],
    ['OUT_OF_SERVICE', true, false],
    ['RETIRED', true, false],
  ] as const)(
    'checks out condition %s with allow=%s only when eligible',
    async (condition, allow, ok) => {
      const harness = makeHarness({ allowBookingWhenNeedsService: allow, condition });
      const result = harness.service.checkOut(actor(), MACHINE_ID, {}, 'request-1');
      if (ok) await expect(result).resolves.toMatchObject({ machineId: MACHINE_ID });
      else await expect(result).rejects.toBeInstanceOf(MachineNotAvailableException);
    },
  );

  it('hides missing and soft-deleted machines behind MACHINE_NOT_FOUND', async () => {
    const missing = makeHarness({ machineExists: false });
    await expect(
      missing.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(MachineNotFoundException);
    const deleted = makeHarness({ deletedAt: new Date() });
    await expect(
      deleted.service.checkIn(actor(), MACHINE_ID, { force: false }, 'request-1'),
    ).rejects.toBeInstanceOf(MachineNotFoundException);
  });

  it('uses the generic non-PHI purpose and one database timestamp', async () => {
    const harness = makeHarness();
    const result = await harness.service.checkOut(actor(), MACHINE_ID, {}, 'request-1');
    expect(result).toMatchObject({
      purpose: 'General equipment use',
      startedAt: NOW.toISOString(),
    });
    expect(harness.clock.now).toHaveBeenCalledTimes(1);
    expect(harness.tx.usageSession.create.mock.calls[0]![0].data).not.toHaveProperty('bookingId');
  });

  it.each([
    ['2026-10-29T09:00:59.999Z', false],
    ['2026-10-29T09:01:00.000Z', true],
    ['2026-10-30T09:00:00.000Z', true],
    ['2026-10-30T09:00:00.001Z', false],
  ] as const)('enforces expected-end bounds for %s', async (expectedEndAt, ok) => {
    const harness = makeHarness();
    const result = harness.service.checkOut(actor(), MACHINE_ID, { expectedEndAt }, 'request-1');
    if (ok) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toBeInstanceOf(UsageExpectedEndInvalidException);
  });

  it('reports current-holder double submits without identity and other holders with minimized identity', async () => {
    const own = makeHarness({ sessionUserId: ACTOR_ID });
    await expect(own.service.checkOut(actor(), MACHINE_ID, {}, 'request-1')).rejects.toMatchObject({
      response: {
        details: expect.objectContaining({ held_by_current_user: true }),
      },
    });
    const ownError = await own.service
      .checkOut(actor(), MACHINE_ID, {}, 'request-2')
      .catch((error) => error);
    expect(ownError.response.details).not.toHaveProperty('holder');

    const other = makeHarness({ sessionUserId: HOLDER_ID });
    await expect(
      other.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toMatchObject({
      response: {
        details: expect.objectContaining({
          held_by_current_user: false,
          holder: { full_name: 'Session Holder', id: HOLDER_ID },
        }),
      },
    });
  });

  it('blocks confirmed bookings through the exact boundary and excludes own/PENDING bookings', async () => {
    const exact = makeHarness();
    exact.tx.booking.findFirst.mockResolvedValue({
      startsAt: new Date('2026-10-29T09:30:00.000Z'),
    });
    await expect(
      exact.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(UpcomingBookingConflictException);
    expect(exact.tx.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestedByUserId: { not: ACTOR_ID },
          startsAt: { lte: new Date('2026-10-29T09:30:00.000Z') },
          status: 'CONFIRMED',
        }),
      }),
    );
  });

  it('uses expected end when it extends the booking guard and reports already-started safely', async () => {
    const harness = makeHarness();
    harness.tx.booking.findFirst.mockResolvedValue({
      startsAt: new Date('2026-10-29T08:55:00.000Z'),
    });
    const error = await harness.service
      .checkOut(actor(), MACHINE_ID, { expectedEndAt: '2026-10-29T11:00:00.000Z' }, 'request-1')
      .catch((caught) => caught);
    expect(error.response.details).toEqual({
      already_started: true,
      starts_at: '2026-10-29T08:55:00.000Z',
    });
    expect(harness.tx.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ startsAt: { lte: new Date('2026-10-29T11:00:00.000Z') } }),
      }),
    );
  });

  it.each([undefined, -1, 241, 1.5, '30'])('fails closed for invalid setting %p', async (value) => {
    const harness = makeHarness();
    harness.tx.appSetting.findUnique.mockResolvedValue(value === undefined ? null : { value });
    await expect(
      harness.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(UsageSettingsInvalidException);
  });

  it('keeps already-started protection when the guard is zero', async () => {
    const harness = makeHarness();
    harness.tx.appSetting.findUnique.mockResolvedValue({ value: 0 });
    await harness.service.checkOut(actor(), MACHINE_ID, {}, 'request-1');
    expect(harness.tx.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ startsAt: { lte: NOW } }) }),
    );
  });

  it.each([
    'OPERATIONAL',
    'NEEDS_SERVICE',
    'UNDER_MAINTENANCE',
    'OUT_OF_SERVICE',
    'RETIRED',
  ] as const)('lets the holder check in while condition is %s', async (condition) => {
    const harness = makeHarness({ condition, sessionUserId: ACTOR_ID });
    await expect(
      harness.service.checkIn(actor(), MACHINE_ID, { force: false, note: 'Finished' }, 'request-1'),
    ).resolves.toMatchObject({
      durationSeconds: 3600,
      endedAt: NOW.toISOString(),
    });
  });

  it('returns stable absent, ordinary non-holder and force-not-applicable errors', async () => {
    const absent = makeHarness();
    await expect(
      absent.service.checkIn(actor(), MACHINE_ID, { force: false }, 'request-1'),
    ).rejects.toBeInstanceOf(NoOpenSessionException);
    const other = makeHarness({ sessionUserId: HOLDER_ID });
    await expect(
      other.service.checkIn(actor('ADMIN'), MACHINE_ID, { force: false }, 'request-1'),
    ).rejects.toBeInstanceOf(SessionNotHeldException);
    const own = makeHarness({ sessionUserId: ACTOR_ID });
    await expect(
      own.service.checkIn(
        actor('ADMIN'),
        MACHINE_ID,
        { force: true, reason: 'Safety reason' },
        'request-1',
      ),
    ).rejects.toBeInstanceOf(ForceNotApplicableException);
  });

  it.each([
    ['SUPER_ADMIN', DEPARTMENT_ID, true],
    ['ADMIN', OTHER_DEPARTMENT_ID, true],
    ['DEPT_MANAGER', DEPARTMENT_ID, true],
    ['DEPT_MANAGER', OTHER_DEPARTMENT_ID, false],
    ['DEPT_MANAGER', null, false],
    ['BIOMED_TECH', DEPARTMENT_ID, false],
    ['STAFF', DEPARTMENT_ID, false],
    ['VIEWER', DEPARTMENT_ID, false],
  ] as const)('enforces force-end scope for %s in %s', async (role, departmentId, allowed) => {
    const harness = makeHarness({ sessionUserId: HOLDER_ID });
    const result = harness.service.checkIn(
      actor(role, ACTOR_ID, departmentId),
      MACHINE_ID,
      { force: true, reason: 'Safety handover required' },
      'request-1',
    );
    if (allowed) await expect(result).resolves.toBeDefined();
    else
      await expect(result).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      });
  });

  it('writes usage-session audit conventions and emits only after commit', async () => {
    const harness = makeHarness({ sessionUserId: ACTOR_ID });
    await harness.service.checkIn(
      actor(),
      MACHINE_ID,
      { force: false, note: 'Finished safely' },
      'request-1',
    );
    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'usage.checked_in',
        entityId: SESSION_ID,
        entityType: 'usage_session',
      }),
    );
    expect(harness.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.events.emit.mock.invocationCallOrder[0]!,
    );
  });

  it('rolls session and audit together and emits nothing after a failed audit', async () => {
    const harness = makeHarness();
    const failure = new Error('audit failed');
    harness.audit.record.mockRejectedValueOnce(failure);
    await expect(harness.service.checkOut(actor(), MACHINE_ID, {}, 'request-1')).rejects.toBe(
      failure,
    );
    expect(harness.events.emit).not.toHaveBeenCalled();
  });

  it('maps open-session uniqueness and lock timeout races', async () => {
    const duplicate = makeHarness();
    duplicate.tx.usageSession.create.mockRejectedValueOnce({
      code: '23505',
      constraint: 'usage_sessions_one_open_per_machine',
    });
    duplicate.prisma.usageSession.findFirst.mockResolvedValue({
      endedAt: null,
      expectedEndAt: new Date('2026-10-29T10:00:00.000Z'),
      id: SESSION_ID,
      machineId: MACHINE_ID,
      purpose: 'Ward round',
      startedAt: NOW,
      user: { fullName: 'Session Holder', id: HOLDER_ID },
      userId: HOLDER_ID,
    });
    await expect(
      duplicate.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(MachineInUseException);

    const busy = makeHarness();
    busy.tx.$queryRaw.mockRejectedValueOnce({ code: '55P03', message: 'lock timeout' });
    await expect(
      busy.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(MachineBusyException);

    const contended = makeHarness();
    contended.tx.$queryRaw.mockRejectedValueOnce({ code: '55P03', message: 'lock timeout' });
    contended.prisma.usageSession.findFirst.mockResolvedValueOnce({
      endedAt: null,
      expectedEndAt: new Date('2026-10-29T10:00:00.000Z'),
      id: SESSION_ID,
      machineId: MACHINE_ID,
      purpose: 'Ward round',
      startedAt: NOW,
      user: { fullName: 'Session Holder', id: HOLDER_ID },
      userId: HOLDER_ID,
    });
    await expect(
      contended.service.checkOut(actor(), MACHINE_ID, {}, 'request-1'),
    ).rejects.toBeInstanceOf(MachineInUseException);
  });
});
