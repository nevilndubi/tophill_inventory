import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BOOKING_SETTING_DEFAULTS,
  availabilitySearchQuerySchema,
  candidateBlockedRange,
  machineAvailabilityQuerySchema,
  type BookingPolicyCategory,
  type BookingPolicyMachine,
  type BookingSettings,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { AvailabilityRangeInvalidException } from './availability.errors';
import { AvailabilityService, coalesceIntervals, subtractIntervals } from './availability.service';
import { BookingPolicyService } from './booking-policy.service';

const actor = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role: 'STAFF',
} satisfies AuthenticatedUser;

const settings: BookingSettings = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 15,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
  maxActivePerUser: 10,
  updatedAt: '2026-11-02T06:00:00.000Z',
};

const detailRow = (overrides: Record<string, unknown> = {}) => ({
  allow_booking_when_needs_service: false,
  as_of: new Date('2026-11-02T06:00:00.000Z'),
  asset_tag: 'HM-000001',
  bookings: [],
  buffer_minutes: null,
  category: { id: '22222222-2222-4222-8222-222222222222', name: 'Ventilator' },
  condition: 'OPERATIONAL',
  default_max_booking_minutes: null,
  department: {
    code: 'ICU',
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Intensive Care',
  },
  id: '44444444-4444-4444-8444-444444444444',
  is_bookable: true,
  location: { id: '55555555-5555-4555-8555-555555555555', name: 'Bay 1' },
  max_booking_minutes: null,
  name: 'Ventilator One',
  open_session: null,
  requires_approval: false,
  ...overrides,
});

describe('availability interval arithmetic', () => {
  it('coalesces overlapping and adjacent facts before subtraction', () => {
    expect(
      coalesceIntervals([
        { end: 20, start: 10 },
        { end: 30, start: 20 },
        { end: 25, start: 15 },
      ]),
    ).toEqual([{ end: 30, start: 10 }]);
    expect(subtractIntervals({ end: 40, start: 0 }, [{ end: 30, start: 10 }])).toEqual([
      { end: 10, start: 0 },
      { end: 40, start: 30 },
    ]);
  });

  it('uses half-open adjacency', () => {
    const candidate = candidateBlockedRange(
      new Date('2026-11-02T07:00:00.000Z'),
      new Date('2026-11-02T08:00:00.000Z'),
      0,
    );
    expect(candidate.start.getTime()).toBe(Date.parse('2026-11-02T07:00:00.000Z'));
    expect(candidate.end.getTime()).toBe(Date.parse('2026-11-02T08:00:00.000Z'));
  });

  it('strictly requires offset timestamps and the documented search parameter names', () => {
    expect(
      machineAvailabilityQuerySchema.safeParse({
        from: '2026-11-02T09:00:00',
        to: '2026-11-02T10:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      availabilitySearchQuerySchema.parse({
        end: '2026-11-02T10:00:00Z',
        start: '2026-11-02T09:00:00+03:00',
      }),
    ).toMatchObject({ page: 1, page_size: 25 });
    expect(
      availabilitySearchQuerySchema.safeParse({
        category: '22222222-2222-4222-8222-222222222222',
        end: '2026-11-02T10:00:00Z',
        start: '2026-11-02T09:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe(AvailabilityService.name, () => {
  const raw = jest.fn<(...parameters: unknown[]) => Promise<unknown[]>>();
  const transactionClient = {
    $queryRawUnsafe: raw,
    appSetting: { findMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient),
    ),
  };
  const policies = {
    readSettings: jest.fn(async () => settings),
    resolve: jest.fn(
      (
        machine: BookingPolicyMachine,
        category: BookingPolicyCategory,
        loadedSettings: BookingSettings,
      ) => new BookingPolicyService({} as PrismaService).resolve(machine, category, loadedSettings),
    ),
  };
  let service: AvailabilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    policies.readSettings.mockResolvedValue(settings);
    raw.mockResolvedValue([detailRow()]);
    service = new AvailabilityService(
      prisma as unknown as PrismaService,
      policies as unknown as BookingPolicyService,
    );
  });

  it('returns minimized policy, one database clock and a complete free window', async () => {
    const result = await service.detail(actor, detailRow().id, {
      from: '2026-11-02T06:15:00.000Z',
      to: '2026-11-02T07:15:00.000Z',
    });
    expect(result).toMatchObject({
      as_of: '2026-11-02T06:00:00.000Z',
      available_for_entire_range: true,
      blocks: [],
      policy: {
        bookable: true,
        effective_buffer_minutes: 15,
        max_duration_minutes: 240,
        min_duration_minutes: 15,
      },
      range: { semantics: '[start,end)' },
    });
    expect(result.machine).not.toHaveProperty('deleted_at');
    expect(JSON.stringify(result)).not.toMatch(/email|purpose|session_id|requested_by/u);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(policies.readSettings).toHaveBeenCalledTimes(1);
  });

  it('preserves booking facts, ownership and the persisted buffer tail', async () => {
    raw.mockResolvedValueOnce([
      detailRow({
        bookings: [
          {
            blocked_until: '2026-11-02T07:15:00.000Z',
            ends_at: '2026-11-02T07:00:00.000Z',
            own: true,
            starts_at: '2026-11-02T06:30:00.000Z',
            status: 'CONFIRMED',
          },
        ],
      }),
    ]);
    const result = await service.detail(actor, detailRow().id, {
      from: '2026-11-02T06:15:00.000Z',
      to: '2026-11-02T07:00:00.000Z',
    });
    expect(result.available_for_entire_range).toBe(false);
    expect(result.blocks[0]).toMatchObject({
      buffer_minutes: 15,
      own: true,
      status: 'CONFIRMED',
      type: 'BOOKING',
    });
  });

  it.each([
    ['future', '2026-11-02T08:00:00.000Z', false, '2026-11-02T08:00:00.000Z'],
    ['missing', null, true, '2026-11-02T10:00:00.000Z'],
    ['overdue', '2026-11-02T05:00:00.000Z', true, '2026-11-02T10:00:00.000Z'],
  ])(
    'maps a %s open session using the conservative estimate rule',
    async (_kind, expected, estimated, end) => {
      raw.mockResolvedValueOnce([
        detailRow({
          open_session: {
            expected_end_at: expected,
            own: false,
            started_at: '2026-11-01T06:00:00.000Z',
          },
        }),
      ]);
      const result = await service.detail(actor, detailRow().id, {
        from: '2026-11-02T06:15:00.000Z',
        to: '2026-11-09T06:15:00.000Z',
      });
      expect(result.blocks).toContainEqual(
        expect.objectContaining({ end, estimated, own: false, reason: 'OPEN_SESSION' }),
      );
    },
  );

  it.each([
    ['disabled', { is_bookable: false }, 'MACHINE_NOT_BOOKABLE'],
    ['maintenance', { condition: 'UNDER_MAINTENANCE' }, 'CONDITION_NOT_BOOKABLE'],
    ['out of service', { condition: 'OUT_OF_SERVICE' }, 'CONDITION_NOT_BOOKABLE'],
    ['retired', { condition: 'RETIRED' }, 'CONDITION_NOT_BOOKABLE'],
    ['needs service opt-out', { condition: 'NEEDS_SERVICE' }, 'CONDITION_NOT_BOOKABLE'],
  ])('blocks the whole range when %s', async (_label, override, reason) => {
    raw.mockResolvedValueOnce([detailRow(override)]);
    const result = await service.detail(actor, detailRow().id, {
      from: '2026-11-02T06:15:00.000Z',
      to: '2026-11-02T07:15:00.000Z',
    });
    expect(result.reasons).toContain(reason);
    expect(result.free_windows).toEqual([]);
  });

  it('allows NEEDS_SERVICE only with the persisted opt-in', async () => {
    raw.mockResolvedValueOnce([
      detailRow({ allow_booking_when_needs_service: true, condition: 'NEEDS_SERVICE' }),
    ]);
    await expect(
      service.detail(actor, detailRow().id, {
        from: '2026-11-02T06:15:00.000Z',
        to: '2026-11-02T07:15:00.000Z',
      }),
    ).resolves.toMatchObject({ available_for_entire_range: true });
  });

  it('adds lead and advance policy blocks at database-clock boundaries', async () => {
    const result = await service.detail(actor, detailRow().id, {
      from: '2026-11-02T05:00:00.000Z',
      to: '2027-01-02T06:00:00.002Z',
    });
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'BEFORE_LEAD_TIME' }),
        expect.objectContaining({ reason: 'BEYOND_ADVANCE_WINDOW' }),
      ]),
    );
  });

  it.each([
    ['short detail', '2026-11-02T06:00:00.000Z', '2026-11-02T06:00:59.999Z'],
    ['long detail', '2026-11-02T06:00:00.000Z', '2027-01-04T06:00:00.001Z'],
  ])('rejects a %s range', async (_label, from, to) => {
    await expect(service.detail(actor, detailRow().id, { from, to })).rejects.toBeInstanceOf(
      AvailabilityRangeInvalidException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns one set-based, deterministically paged search result', async () => {
    raw.mockResolvedValueOnce([
      {
        asOf: new Date('2026-11-02T06:00:00.000Z'),
        invalidPolicyCount: 0,
        items: [
          {
            asset_tag: 'HM-000001',
            category: detailRow().category,
            department: detailRow().department,
            effective_buffer_minutes: 15,
            id: detailRow().id,
            location: detailRow().location,
            name: detailRow().name,
            requires_approval: false,
          },
        ],
        total: 1,
      },
    ]);
    const result = await service.search(actor, {
      category_id: detailRow().category.id,
      department_id: detailRow().department.id,
      end: '2026-11-02T07:15:00.000Z',
      page: 1,
      page_size: 25,
      start: '2026-11-02T06:15:00.000Z',
    });
    expect(result.meta).toEqual({ page: 1, page_size: 25, total: 1 });
    expect(result.items[0]).not.toHaveProperty('condition');
    expect(raw).toHaveBeenCalledTimes(1);
    const sql = String(raw.mock.calls[0]?.[0]);
    expect(sql).toContain('b.blocked_until > $1::timestamptz');
    expect(sql).toContain('usage_sessions');
    expect(sql).toContain('ORDER BY e.asset_tag, e.id');
  });

  it('rejects past, undersized and oversized search windows', async () => {
    const invalidRanges: Array<readonly [string, string]> = [
      ['2026-11-02T05:58:59.999Z', '2026-11-02T06:30:00.000Z'],
      ['2026-11-02T06:15:00.000Z', '2026-11-02T06:20:00.000Z'],
      ['2026-11-02T06:15:00.000Z', '2026-11-03T06:15:00.001Z'],
    ];
    for (const [start, end] of invalidRanges) {
      raw.mockResolvedValueOnce([
        { asOf: new Date('2026-11-02T06:00:00.000Z'), invalidPolicyCount: 0, items: [], total: 0 },
      ]);
      await expect(
        service.search(actor, { end, page: 1, page_size: 25, start }),
      ).rejects.toBeInstanceOf(AvailabilityRangeInvalidException);
    }
  });

  it('loads exactly the eight settings once per request', async () => {
    raw.mockResolvedValueOnce([
      { asOf: new Date('2026-11-02T06:00:00.000Z'), invalidPolicyCount: 0, items: [], total: 0 },
    ]);
    await service.search(actor, {
      end: '2026-11-02T07:15:00.000Z',
      page: 1,
      page_size: 25,
      start: '2026-11-02T06:15:00.000Z',
    });
    expect(policies.readSettings).toHaveBeenCalledTimes(1);
    expect(Object.keys(BOOKING_SETTING_DEFAULTS)).toHaveLength(8);
  });
});
