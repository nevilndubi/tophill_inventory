/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles intentionally model Prisma's generated delegate surface */
import { describe, expect, it, jest } from '@jest/globals';
import { resolveEffectivePolicy, type BookingSettings, type CreateBookingInput } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ActiveBookingLimitReachedException,
  BookingConflictException,
  BookingMachineBusyException,
  IdempotencyKeyInvalidException,
  IdempotencyKeyReusedException,
} from './booking-creation.errors';
import type { BookingPolicyService } from './booking-policy.service';
import { BookingService } from './booking.service';

type MachineFixture = {
  allowBookingWhenNeedsService: boolean;
  assetTag: string;
  bufferMinutes: number | null;
  condition: 'OPERATIONAL';
  defaultMaxBookingMinutes: number | null;
  deletedAt: Date | null;
  id: string;
  isBookable: boolean;
  maxBookingMinutes: number | null;
  name: string;
  requiresApproval: boolean;
};

const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role: 'STAFF',
};
const machineId = '22222222-2222-4222-8222-222222222222';
const bookingId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-03T10:00:00.000Z');
const input: CreateBookingInput = {
  ends_at: '2026-11-03T11:15:00.000Z',
  machine_id: machineId,
  purpose: 'Ward round',
  starts_at: '2026-11-03T10:15:00.000Z',
};
const settings: BookingSettings = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 15,
  maxActivePerUser: 10,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
  updatedAt: '2026-11-03T09:00:00.000Z',
};
const lockedMachine: MachineFixture = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  condition: 'OPERATIONAL' as const,
  defaultMaxBookingMinutes: null,
  deletedAt: null,
  id: machineId,
  isBookable: true,
  maxBookingMinutes: null,
  name: 'Ventilator',
  requiresApproval: false,
};

const record = (overrides: Record<string, unknown> = {}) => ({
  approvedByUserId: null,
  blockedUntil: new Date('2026-11-03T11:30:00.000Z'),
  cancelledReason: null,
  createdAt: now,
  decisionNote: null,
  endsAt: new Date(input.ends_at),
  id: bookingId,
  idempotencyKey: 'test-key-0001',
  machine: { assetTag: 'HM-000061', id: machineId, name: 'Ventilator' },
  machineId,
  purpose: input.purpose,
  requestedByUserId: actor.id,
  startsAt: new Date(input.starts_at),
  status: 'CONFIRMED' as const,
  updatedAt: now,
  ...overrides,
});

const setup = (machine: MachineFixture | null = lockedMachine) => {
  const queryResults: unknown[] = [
    machine === null ? [] : [machine],
    [{ id: actor.id }],
    [{ now }],
  ];
  const tx = {
    $executeRawUnsafe: jest.fn(async (_query: string) => 0),
    $queryRaw: jest.fn(async (_query: unknown): Promise<any> => queryResults.shift()),
    appSetting: { findMany: jest.fn() },
    auditLog: { findFirst: jest.fn(async () => null) },
    booking: {
      count: jest.fn(async (_args: any) => 0),
      create: jest.fn(async (_args: any): Promise<any> => record()),
      findFirst: jest.fn(async (): Promise<any> => null),
    },
    usageSession: { findFirst: jest.fn(async (): Promise<any> => null) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown, _options?: unknown) =>
      callback(tx),
    ),
    auditLog: { findFirst: jest.fn(async (): Promise<any> => null) },
    booking: { findFirst: jest.fn(async (): Promise<any> => null) },
  };
  const policies = {
    readSettings: jest.fn(async () => settings),
    resolve: jest.fn((policyMachine: any, category: any, loadedSettings: any) =>
      resolveEffectivePolicy(policyMachine, category, loadedSettings),
    ),
  };
  const audit = { record: jest.fn(async (..._args: any[]) => undefined) };
  const service = new BookingService(
    prisma as unknown as PrismaService,
    policies as unknown as BookingPolicyService,
    audit as unknown as AuditService,
  );
  return { audit, policies, prisma, service, tx };
};

describe(BookingService.name, () => {
  it('locks machine then requester, reads one post-lock clock and creates an atomic confirmed booking', async () => {
    const { audit, service, tx } = setup();
    const result = await service.create(actor, input, 'request-1', 'test-key-0001');

    expect(result).toEqual({
      booking: expect.objectContaining({
        effective_buffer_minutes: 15,
        id: bookingId,
        requires_approval: false,
        status: 'CONFIRMED',
      }),
      replayed: false,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(String(tx.$queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE OF m');
    expect(String(tx.$queryRaw.mock.calls[1]?.[0])).toContain('FOR NO KEY UPDATE');
    expect(String(tx.$queryRaw.mock.calls[2]?.[0])).toContain('clock_timestamp()');
    expect(tx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockedUntil: new Date('2026-11-03T11:30:00.000Z'),
          status: 'CONFIRMED',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'booking.created',
        entityId: bookingId,
        entityType: 'booking',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('test-key-0001');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(input.purpose);
  });

  it('creates PENDING when approval is required and keeps the buffer snapshot', async () => {
    const configured = setup({ ...lockedMachine, bufferMinutes: 20, requiresApproval: true });
    configured.tx.booking.create.mockResolvedValueOnce(
      record({
        blockedUntil: new Date('2026-11-03T11:35:00.000Z'),
        status: 'PENDING',
      }),
    );
    const result = await configured.service.create(actor, input, 'request-2');
    expect(result.booking).toMatchObject({
      effective_buffer_minutes: 20,
      requires_approval: true,
      status: 'PENDING',
    });
  });

  it('fails closed at the active-booking limit using future pending/confirmed plus every in-progress booking', async () => {
    const limited = setup();
    limited.tx.booking.count.mockResolvedValueOnce(10);
    await expect(limited.service.create(actor, input, 'request-3')).rejects.toBeInstanceOf(
      ActiveBookingLimitReachedException,
    );
    expect(limited.tx.booking.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { endsAt: { gt: now }, status: { in: ['PENDING', 'CONFIRMED'] } },
          { status: 'IN_PROGRESS' },
        ],
        requestedByUserId: actor.id,
      },
    });
  });

  it('evaluates lead time from the clock read after both locks rather than transaction start', async () => {
    const delayed = setup();
    delayed.tx.$queryRaw.mockImplementation(async (_query: unknown): Promise<any> => {
      const value = String(_query);
      if (value.includes('FOR UPDATE OF m')) return [lockedMachine];
      if (value.includes('FOR NO KEY UPDATE')) return [{ id: actor.id }];
      return [{ now: new Date('2026-11-03T10:00:02.000Z') }];
    });
    await expect(delayed.service.create(actor, input, 'request-clock')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BOOKING_TOO_SOON' }),
    });
    expect(delayed.tx.booking.count).not.toHaveBeenCalled();
  });

  it.each([
    [new Date('2026-11-03T11:00:00.000Z'), false, '2026-11-03T11:00:00.000Z'],
    [null, true, '2026-11-03T14:00:00.000Z'],
    [new Date('2026-11-03T09:00:00.000Z'), true, '2026-11-03T14:00:00.000Z'],
  ] as const)('uses the Task 5.2 open-session estimate', async (expectedEndAt, estimated, end) => {
    const occupied = setup();
    occupied.tx.usageSession.findFirst.mockResolvedValueOnce({ expectedEndAt });
    const conflicting = { ...input, starts_at: '2026-11-03T10:30:00.000Z' };
    await expect(occupied.service.create(actor, conflicting, 'request-4')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'MACHINE_IN_USE',
        details: { block_end: end, estimated },
      }),
    });
  });

  it('allows a far-future slot after an estimated open-session block', async () => {
    const occupied = setup();
    occupied.tx.usageSession.findFirst.mockResolvedValueOnce({ expectedEndAt: null });
    const future = {
      ...input,
      ends_at: '2026-11-10T11:00:00.000Z',
      starts_at: '2026-11-10T10:00:00.000Z',
    };
    await expect(occupied.service.create(actor, future, 'request-5')).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('returns the same current booking for a numerically equivalent replay and writes no audit', async () => {
    const replay = setup();
    replay.prisma.booking.findFirst.mockResolvedValueOnce(record({ status: 'CANCELLED' }));
    replay.prisma.auditLog.findFirst.mockResolvedValueOnce({
      after: { context: { requiresApproval: true } },
    });
    const equivalent = {
      ...input,
      ends_at: '2026-11-03T14:15:00.000+03:00',
      starts_at: '2026-11-03T13:15:00.000+03:00',
    };
    const result = await replay.service.create(actor, equivalent, 'request-6', 'test-key-0001');
    expect(result).toMatchObject({
      booking: { id: bookingId, requires_approval: true, status: 'CANCELLED' },
      replayed: true,
    });
    expect(replay.prisma.$transaction).not.toHaveBeenCalled();
    expect(replay.audit.record).not.toHaveBeenCalled();
  });

  it('rejects changed-payload reuse and malformed keys without exposing the key', async () => {
    const reused = setup();
    reused.prisma.booking.findFirst.mockResolvedValueOnce(record());
    await expect(
      reused.service.create(
        actor,
        { ...input, purpose: 'Pre-op check' },
        'request-7',
        'test-key-0001',
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedException);
    await expect(reused.service.create(actor, input, 'request-8', 'short')).rejects.toBeInstanceOf(
      IdempotencyKeyInvalidException,
    );
  });

  it('maps existing booking overlap, lock timeout and a database exclusion race safely', async () => {
    const existing = setup();
    existing.tx.booking.findFirst.mockResolvedValueOnce({
      blockedUntil: new Date('2026-11-03T11:45:00.000Z'),
      endsAt: new Date('2026-11-03T11:30:00.000Z'),
      startsAt: new Date('2026-11-03T10:30:00.000Z'),
      status: 'CONFIRMED',
    });
    await expect(existing.service.create(actor, input, 'request-9')).rejects.toBeInstanceOf(
      BookingConflictException,
    );

    const busy = setup();
    busy.tx.$queryRaw.mockRejectedValueOnce({ code: '55P03', message: 'lock timeout' });
    await expect(busy.service.create(actor, input, 'request-10')).rejects.toBeInstanceOf(
      BookingMachineBusyException,
    );

    const raced = setup();
    raced.tx.booking.create.mockRejectedValueOnce({
      code: '23P01',
      constraint: 'bookings_no_overlap',
    });
    raced.prisma.booking.findFirst.mockResolvedValueOnce({
      blockedUntil: new Date('2026-11-03T11:45:00.000Z'),
      endsAt: new Date('2026-11-03T11:30:00.000Z'),
      startsAt: new Date('2026-11-03T10:30:00.000Z'),
      status: 'CONFIRMED',
    });
    await expect(raced.service.create(actor, input, 'request-11')).rejects.toBeInstanceOf(
      BookingConflictException,
    );
  });

  it('rolls back when the in-transaction audit fails', async () => {
    const failed = setup();
    failed.audit.record.mockRejectedValueOnce(new Error('forced audit failure'));
    await expect(failed.service.create(actor, input, 'request-12')).rejects.toThrow(
      'forced audit failure',
    );
  });

  it('hides missing and soft-deleted machines', async () => {
    for (const machine of [null, { ...lockedMachine, deletedAt: now }]) {
      const hidden = setup(machine);
      await expect(hidden.service.create(actor, input, 'request-13')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'MACHINE_NOT_FOUND' }),
      });
    }
  });
});
