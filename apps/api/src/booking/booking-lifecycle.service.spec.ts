/* eslint-disable @typescript-eslint/no-explicit-any -- focused Prisma doubles model generated delegates */
import { describe, expect, it, jest } from '@jest/globals';
import { resolveEffectivePolicy, type BookingSettings } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BookingChangedException,
  BookingNotFoundException,
  BookingNotModifiableException,
  BookingRequesterInactiveException,
  BookingSelfApprovalDeniedException,
  BookingStartPassedException,
} from './booking.errors';
import type { BookingPolicyService } from './booking-policy.service';
import { BookingService } from './booking.service';

const machineId = '11111111-1111-4111-8111-111111111111';
const bookingId = '22222222-2222-4222-8222-222222222222';
const requesterId = '33333333-3333-4333-8333-333333333333';
const managerId = '44444444-4444-4444-8444-444444444444';
const departmentId = '55555555-5555-4555-8555-555555555555';
const otherDepartmentId = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-11-04T08:00:00.000Z');
const start = new Date('2026-11-04T10:00:00.000Z');
const end = new Date('2026-11-04T11:00:00.000Z');
const updatedAt = new Date('2026-11-04T07:00:00.000Z');

const settings: BookingSettings = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 15,
  maxActivePerUser: 10,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
  updatedAt: '2026-11-04T07:00:00.000Z',
};

const user = (
  role: AuthenticatedUser['role'],
  id = requesterId,
  department = departmentId,
): AuthenticatedUser => ({
  department: department === '' ? null : { code: 'ICU', id: department, name: 'Intensive Care' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id,
  isActive: true,
  role,
});

const lockedMachine = (deletedAt: Date | null = null) => ({
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: 15,
  condition: 'OPERATIONAL' as const,
  defaultMaxBookingMinutes: null,
  deletedAt,
  departmentId,
  id: machineId,
  isBookable: true,
  maxBookingMinutes: null,
  name: 'Ventilator',
  requiresApproval: true,
});

const lifecycleBooking = (overrides: Record<string, unknown> = {}) => ({
  approvedByUser: null,
  approvedByUserId: null,
  blockedUntil: new Date('2026-11-04T11:15:00.000Z'),
  cancelledReason: null,
  createdAt: new Date('2026-11-03T08:00:00.000Z'),
  decisionNote: null,
  endsAt: end,
  id: bookingId,
  idempotencyKey: null,
  machine: {
    ...lockedMachine(),
    categoryId: '77777777-7777-4777-8777-777777777777',
    commissionedOn: null,
    createdAt: now,
    deletedAt: null,
    department: { code: 'ICU', id: departmentId, name: 'Intensive Care' },
    description: null,
    lastServicedAt: null,
    locationId: null,
    manufacturer: 'Maker',
    model: null,
    nextServiceDueAt: null,
    purchaseDate: null,
    retiredOn: null,
    serialNumber: 'SERIAL-1',
    serviceIntervalDays: null,
    updatedAt: now,
    warrantyExpiresOn: null,
  },
  machineId,
  purpose: 'Ward round',
  requestedByUser: { fullName: 'Requester', id: requesterId, isActive: true },
  requestedByUserId: requesterId,
  startsAt: start,
  status: 'CONFIRMED' as const,
  updatedAt,
  ...overrides,
});

const setup = (
  options: {
    booking?: ReturnType<typeof lifecycleBooking>;
    deletedAt?: Date | null;
    requesterActive?: boolean;
  } = {},
) => {
  let booking: any = options.booking ?? lifecycleBooking();
  const machine = lockedMachine(options.deletedAt ?? null);
  if (options.deletedAt !== undefined) {
    booking = {
      ...booking,
      machine: { ...booking.machine, deletedAt: options.deletedAt },
    };
  }
  const queryResults: unknown[] = [
    [machine],
    [{ id: requesterId, isActive: options.requesterActive ?? true }],
    [{ id: bookingId }],
    [{ now }],
  ];
  const tx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRaw: jest.fn(async (..._args: any[]): Promise<any> => queryResults.shift()),
    appSetting: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
    booking: {
      findFirst: jest.fn(async (): Promise<any> => null),
      findUnique: jest.fn(async (args: any): Promise<any> =>
        args.select === undefined ? booking : { machineId, requestedByUserId: requesterId },
      ),
      update: jest.fn(async (args: any): Promise<any> => {
        booking = {
          ...booking,
          ...args.data,
          approvedByUser:
            args.data.approvedByUserId === managerId
              ? { fullName: 'Approver', id: managerId }
              : null,
        };
        return booking;
      }),
    },
    usageSession: { findFirst: jest.fn(async (): Promise<any> => null) },
  };
  const prisma = {
    $queryRaw: jest.fn(async (query: unknown, ..._args: any[]) =>
      Array.isArray(query) ? [{ now }] : [],
    ),
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    booking: {
      count: jest.fn(async (..._args: any[]) => 0),
      findMany: jest.fn(async (..._args: any[]): Promise<any[]> => []),
      findUnique: jest.fn(async (..._args: any[]) => booking),
    },
  };
  const policies = {
    readSettings: jest.fn(async () => settings),
    resolve: jest.fn((policyMachine: any, category: any, loaded: any) =>
      resolveEffectivePolicy(policyMachine, category, loaded),
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

describe('BookingService lifecycle', () => {
  it('uses machine, requester, booking, then post-lock clock order for every mutation', async () => {
    const cases = [
      (service: BookingService) =>
        service.update(
          user('STAFF'),
          bookingId,
          { expected_updated_at: updatedAt.toISOString(), purpose: 'Routine monitoring' },
          'request-update',
        ),
      (service: BookingService) =>
        service.cancel(user('VIEWER'), bookingId, { reason: 'Plans changed' }, 'request-cancel'),
      (service: BookingService) =>
        service.approve(user('ADMIN', managerId), bookingId, {}, 'request-approve'),
      (service: BookingService) =>
        service.reject(
          user('ADMIN', managerId),
          bookingId,
          { note: 'Capacity unavailable' },
          'request-reject',
        ),
    ];
    for (const run of cases) {
      const pending = setup({ booking: lifecycleBooking({ status: 'PENDING' }) });
      await run(pending.service);
      const queries = pending.tx.$queryRaw.mock.calls.map((call) => String(call[0]));
      expect(queries[0]).toContain('FOR UPDATE OF m');
      expect(queries[1]).toContain('FOR NO KEY UPDATE');
      expect(queries[2]).toContain('FROM bookings');
      expect(queries[3]).toContain('clock_timestamp()');
    }
  });

  it('updates purpose without policy/conflict work and advances the optimistic token', async () => {
    const fixture = setup();
    const result = await fixture.service.update(
      user('STAFF'),
      bookingId,
      { expected_updated_at: updatedAt.toISOString(), purpose: 'Routine monitoring' },
      'request-purpose',
    );
    expect(result.purpose).toBe('Routine monitoring');
    expect(result.updated_at).toBe('2026-11-04T08:00:00.000Z');
    expect(fixture.policies.readSettings).not.toHaveBeenCalled();
    expect(fixture.tx.usageSession.findFirst).not.toHaveBeenCalled();
    expect(fixture.tx.booking.findFirst).not.toHaveBeenCalled();
    expect(fixture.audit.record).toHaveBeenCalledWith(
      fixture.tx,
      expect.objectContaining({ action: 'booking.rescheduled' }),
    );
  });

  it('returns a semantic no-op without updating or auditing', async () => {
    const fixture = setup();
    const result = await fixture.service.update(
      user('STAFF'),
      bookingId,
      { expected_updated_at: updatedAt.toISOString(), purpose: 'Ward round' },
      'request-noop',
    );
    expect(result.updated_at).toBe(updatedAt.toISOString());
    expect(fixture.tx.booking.update).not.toHaveBeenCalled();
    expect(fixture.audit.record).not.toHaveBeenCalled();
  });

  it('rejects stale optimistic tokens and bookings that already started', async () => {
    const stale = setup();
    await expect(
      stale.service.update(
        user('STAFF'),
        bookingId,
        { expected_updated_at: '2026-11-04T06:00:00.000Z', purpose: 'Changed' },
        'request-stale',
      ),
    ).rejects.toBeInstanceOf(BookingChangedException);

    const past = setup({
      booking: lifecycleBooking({ startsAt: new Date('2026-11-04T07:00:00Z') }),
    });
    await expect(
      past.service.update(
        user('STAFF'),
        bookingId,
        { expected_updated_at: updatedAt.toISOString(), purpose: 'Changed' },
        'request-past',
      ),
    ).rejects.toBeInstanceOf(BookingNotModifiableException);
  });

  it('keeps approval when shrinking inside the approved window and resets it when expanding', async () => {
    const approved = lifecycleBooking({
      approvedByUser: { fullName: 'Approver', id: managerId },
      approvedByUserId: managerId,
      decisionNote: 'Approved',
    });
    const shrink = setup({ booking: approved });
    await shrink.service.update(
      user('STAFF'),
      bookingId,
      {
        ends_at: '2026-11-04T10:45:00.000Z',
        expected_updated_at: updatedAt.toISOString(),
      },
      'request-shrink',
    );
    expect(shrink.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedByUserId: managerId, status: 'CONFIRMED' }),
      }),
    );

    const expand = setup({ booking: approved });
    await expand.service.update(
      user('STAFF'),
      bookingId,
      {
        ends_at: '2026-11-04T11:30:00.000Z',
        expected_updated_at: updatedAt.toISOString(),
      },
      'request-expand',
    );
    expect(expand.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvedByUserId: null,
          decisionNote: null,
          status: 'PENDING',
        }),
      }),
    );
  });

  it.each(['DEPT_MANAGER', 'ADMIN', 'SUPER_ADMIN'] as const)(
    'denies %s self-approval and self-rejection',
    async (role) => {
      for (const action of ['approve', 'reject'] as const) {
        const fixture = setup({ booking: lifecycleBooking({ status: 'PENDING' }) });
        const promise =
          action === 'approve'
            ? fixture.service.approve(user(role), bookingId, {}, 'request-self')
            : fixture.service.reject(
                user(role),
                bookingId,
                { note: 'Cannot approve own request' },
                'request-self',
              );
        await expect(promise).rejects.toBeInstanceOf(BookingSelfApprovalDeniedException);
        expect(fixture.audit.record).not.toHaveBeenCalled();
      }
    },
  );

  it('allows a different global approver and rejects approval after start or for an inactive requester', async () => {
    const fallback = setup({ booking: lifecycleBooking({ status: 'PENDING' }) });
    await expect(
      fallback.service.approve(user('ADMIN', managerId), bookingId, {}, 'request-fallback'),
    ).resolves.toMatchObject({ status: 'CONFIRMED' });

    const past = setup({
      booking: lifecycleBooking({
        startsAt: new Date('2026-11-04T07:00:00.000Z'),
        status: 'PENDING',
      }),
    });
    await expect(
      past.service.approve(user('ADMIN', managerId), bookingId, {}, 'request-past'),
    ).rejects.toBeInstanceOf(BookingStartPassedException);

    const inactive = setup({
      booking: lifecycleBooking({ status: 'PENDING' }),
      requesterActive: false,
    });
    await expect(
      inactive.service.approve(user('ADMIN', managerId), bookingId, {}, 'request-inactive'),
    ).rejects.toBeInstanceOf(BookingRequesterInactiveException);
  });

  it('allows cancellation and rejection after registry removal but minimizes removed machine data', async () => {
    const deletedAt = new Date('2026-11-04T07:30:00.000Z');
    const cancellation = setup({ deletedAt });
    const cancelled = await cancellation.service.cancel(
      user('VIEWER'),
      bookingId,
      { reason: 'Plans changed' },
      'request-cancel-deleted',
    );
    expect(cancelled.machine).toEqual({
      asset_tag: null,
      id: machineId,
      is_removed: true,
      name: null,
      owning_department: null,
    });

    const rejection = setup({
      booking: lifecycleBooking({ status: 'PENDING' }),
      deletedAt,
    });
    await expect(
      rejection.service.reject(
        user('ADMIN', managerId),
        bookingId,
        { note: 'Machine removed' },
        'request-reject-deleted',
      ),
    ).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('makes repeated cancellation idempotent with no second update or audit', async () => {
    const fixture = setup({ booking: lifecycleBooking({ status: 'CANCELLED' }) });
    await expect(
      fixture.service.cancel(
        user('VIEWER'),
        bookingId,
        { reason: 'Repeated request' },
        'request-repeat',
      ),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(fixture.tx.booking.update).not.toHaveBeenCalled();
    expect(fixture.audit.record).not.toHaveBeenCalled();
  });

  it('allows rejecting a past pending request while refusing cross-department management', async () => {
    const pendingPast = setup({
      booking: lifecycleBooking({
        startsAt: new Date('2026-11-04T07:00:00.000Z'),
        status: 'PENDING',
      }),
    });
    await expect(
      pendingPast.service.reject(
        user('DEPT_MANAGER', managerId),
        bookingId,
        { note: 'Request expired' },
        'request-reject-past',
      ),
    ).resolves.toMatchObject({ status: 'REJECTED' });

    const crossDepartment = setup({ booking: lifecycleBooking({ status: 'PENDING' }) });
    await expect(
      crossDepartment.service.reject(
        user('DEPT_MANAGER', managerId, otherDepartmentId),
        bookingId,
        { note: 'Not in scope' },
        'request-cross',
      ),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it.each(['update', 'cancel', 'approve', 'reject'] as const)(
    'rolls back %s when its audit write fails',
    async (action) => {
      const fixture = setup({ booking: lifecycleBooking({ status: 'PENDING' }) });
      fixture.audit.record.mockRejectedValueOnce(new Error('forced audit failure'));
      const operation = {
        approve: () =>
          fixture.service.approve(user('ADMIN', managerId), bookingId, {}, 'request-fail'),
        cancel: () =>
          fixture.service.cancel(
            user('VIEWER'),
            bookingId,
            { reason: 'Plans changed' },
            'request-fail',
          ),
        reject: () =>
          fixture.service.reject(
            user('ADMIN', managerId),
            bookingId,
            { note: 'Cannot support request' },
            'request-fail',
          ),
        update: () =>
          fixture.service.update(
            user('STAFF'),
            bookingId,
            { expected_updated_at: updatedAt.toISOString(), purpose: 'Changed purpose' },
            'request-fail',
          ),
      }[action];
      await expect(operation()).rejects.toThrow('forced audit failure');
    },
  );

  it('uses bounded list queries plus one audit lookup and protects managed scope in SQL', async () => {
    const fixture = setup();
    fixture.prisma.booking.findMany.mockResolvedValueOnce([lifecycleBooking()]);
    fixture.prisma.booking.count.mockResolvedValueOnce(1);
    await fixture.service.list(user('DEPT_MANAGER', managerId), {
      order: 'asc',
      page: 1,
      page_size: 25,
      sort: 'starts_at',
      view: 'managed',
      when: 'all',
    });
    expect(fixture.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { machine: { departmentId }, status: 'PENDING' },
      }),
    );
    expect(fixture.prisma.booking.count).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
