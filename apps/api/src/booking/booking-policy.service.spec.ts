import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BOOKING_SETTING_DEFAULTS,
  bookingSettingsSchema,
  resolveEffectivePolicy,
  validateBookingWindow,
  type BookingPolicyMachine,
  type BookingSettings,
} from '@app/shared';
import { PrismaService } from '../prisma/prisma.service';
import { BookingMachineNotFoundException, BookingSettingsInvalidException } from './booking.errors';
import { BookingPolicyService } from './booking-policy.service';
import {
  BOOKING_SETTING_KEYS,
  settingsFromRows,
  type SettingRow,
} from './booking-settings.service';

const settings: BookingSettings = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 0,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const machine: BookingPolicyMachine = {
  allowBookingWhenNeedsService: false,
  bufferMinutes: null,
  condition: 'OPERATIONAL',
  isBookable: true,
  maxBookingMinutes: null,
  requiresApproval: false,
};

const policyFor = (overrides: Partial<BookingPolicyMachine> = {}) =>
  resolveEffectivePolicy(
    { ...machine, ...overrides },
    { defaultMaxBookingMinutes: null },
    settings,
  );

describe('effective booking policy', () => {
  it('resolves machine then category then global maximum and machine then global buffer', () => {
    const category = resolveEffectivePolicy(
      { ...machine, bufferMinutes: 20 },
      { defaultMaxBookingMinutes: 180 },
      settings,
    );
    expect(category.maxDurationMinutes).toEqual({ source: 'category', value: 180 });
    expect(category.bufferMinutes).toEqual({ source: 'machine', value: 20 });
    expect(
      resolveEffectivePolicy(
        { ...machine, maxBookingMinutes: 90, bufferMinutes: 10 },
        { defaultMaxBookingMinutes: 180 },
        settings,
      ).maxDurationMinutes,
    ).toEqual({ source: 'machine', value: 90 });
    expect(policyFor().maxDurationMinutes).toEqual({ source: 'global', value: 240 });
    expect(policyFor().bufferMinutes).toEqual({ source: 'global', value: 0 });
  });

  it('uses global-only limits and the machine approval flag', () => {
    const policy = policyFor({ requiresApproval: true });
    expect(policy.minDurationMinutes).toEqual({ source: 'global', value: 15 });
    expect(policy.minLeadMinutes).toEqual({ source: 'global', value: 15 });
    expect(policy.maxAdvanceDays).toEqual({ source: 'global', value: 60 });
    expect(policy.requiresApproval).toEqual({ source: 'machine', value: true });
  });

  it.each([
    ['OPERATIONAL', false, true, null],
    ['NEEDS_SERVICE', false, false, 'CONDITION'],
    ['NEEDS_SERVICE', true, true, null],
    ['UNDER_MAINTENANCE', true, false, 'CONDITION'],
    ['OUT_OF_SERVICE', true, false, 'CONDITION'],
    ['RETIRED', true, false, 'CONDITION'],
  ] as const)(
    'evaluates %s condition with needs-service override=%s',
    (condition, allowBookingWhenNeedsService, value, reason) => {
      expect(policyFor({ condition, allowBookingWhenNeedsService }).bookable).toEqual({
        reason,
        value,
      });
    },
  );

  it('reports a disabled machine without changing approval behavior', () => {
    expect(policyFor({ isBookable: false }).bookable).toEqual({
      reason: 'NOT_ENABLED',
      value: false,
    });
  });
});

describe('booking window validation', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('accepts the exact lead-time boundary and rejects one millisecond before it', () => {
    const policy = policyFor();
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:15:00.000Z'),
        new Date('2026-01-01T00:30:00.000Z'),
        now,
      ),
    ).toEqual({ bufferMinutes: 0, ok: true });
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:14:59.999Z'),
        new Date('2026-01-01T00:30:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_TOO_SOON', ok: false });
  });

  const updatedAt = new Date('2026-01-01T00:00:00.000Z');
  const settingRows: SettingRow[] = Object.entries(BOOKING_SETTING_DEFAULTS).map(
    ([key, value]) => ({
      key,
      updatedAt,
      value,
    }),
  );

  describe('BookingPolicyService', () => {
    const machineRecord = {
      allowBookingWhenNeedsService: false,
      bufferMinutes: null,
      category: { defaultMaxBookingMinutes: 180 },
      condition: 'OPERATIONAL',
      deletedAt: null,
      isBookable: true,
      maxBookingMinutes: null,
      requiresApproval: true,
    };
    const prisma = {
      appSetting: { findMany: jest.fn(async (_query: unknown) => settingRows) },
      machine: {
        findFirst: jest.fn(async (_query: unknown) => machineRecord as typeof machineRecord | null),
      },
    };
    let service: BookingPolicyService;

    beforeEach(() => {
      jest.clearAllMocks();
      prisma.machine.findFirst.mockResolvedValue(machineRecord);
      prisma.appSetting.findMany.mockResolvedValue(settingRows);
      service = new BookingPolicyService(prisma as unknown as PrismaService);
    });

    it('resolves policy with one machine read and one settings read', async () => {
      await expect(service.get('machine-id')).resolves.toMatchObject({
        bufferMinutes: { source: 'global', value: 0 },
        maxDurationMinutes: { source: 'category', value: 180 },
        requiresApproval: { source: 'machine', value: true },
      });
      expect(prisma.machine.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.machine.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, id: 'machine-id' } }),
      );
      expect(prisma.appSetting.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.appSetting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: { in: BOOKING_SETTING_KEYS } } }),
      );
    });

    it('hides deleted and missing machines without reading settings', async () => {
      prisma.machine.findFirst.mockResolvedValueOnce(null);
      await expect(service.get('deleted-id')).rejects.toBeInstanceOf(
        BookingMachineNotFoundException,
      );
      expect(prisma.appSetting.findMany).not.toHaveBeenCalled();
    });
  });

  describe('settingsFromRows', () => {
    it('rejects missing and malformed settings', () => {
      expect(() => settingsFromRows(settingRows.slice(1))).toThrow(BookingSettingsInvalidException);
      expect(() =>
        settingsFromRows(
          settingRows.map((row) =>
            row.key === 'booking.min_duration_minutes' ? { ...row, value: '15' } : row,
          ),
        ),
      ).toThrow(BookingSettingsInvalidException);
    });
  });

  it('accepts the exact maximum and rejects one minute over', () => {
    const policy = policyFor();
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T04:30:00.000Z'),
        now,
      ).ok,
    ).toBe(true);
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T04:31:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_TOO_LONG', ok: false });
  });

  it('validates minimum duration, the exact advance limit and one millisecond over', () => {
    const policy = policyFor();
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T00:44:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_TOO_SHORT', ok: false });
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-03-02T00:00:00.000Z'),
        new Date('2026-03-02T00:15:00.000Z'),
        now,
      ).ok,
    ).toBe(true);
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-03-02T00:00:00.001Z'),
        new Date('2026-03-02T00:15:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_TOO_FAR_AHEAD', ok: false });
  });

  it('rejects invalid ordering and non-whole-minute windows', () => {
    const policy = policyFor();
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T00:30:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_WINDOW_INVALID', ok: false });
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.001Z'),
        new Date('2026-01-01T00:45:00.001Z'),
        now,
      ),
    ).toEqual({ code: 'BOOKING_WINDOW_INVALID', ok: false });
  });

  it('reports machine bookability reasons and rejects malformed policies', () => {
    expect(
      validateBookingWindow(
        policyFor({ condition: 'OUT_OF_SERVICE' }),
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T00:45:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'MACHINE_NOT_BOOKABLE', ok: false, reason: 'CONDITION' });
    const policy = policyFor();
    policy.bufferMinutes.value = 241;
    expect(
      validateBookingWindow(
        policy,
        new Date('2026-01-01T00:30:00.000Z'),
        new Date('2026-01-01T00:45:00.000Z'),
        now,
      ),
    ).toEqual({ code: 'POLICY_INVALID', ok: false });
  });

  it('rejects missing and malformed settings', () => {
    expect(bookingSettingsSchema.safeParse({ ...settings, maxAdvanceDays: '60' }).success).toBe(
      false,
    );
    const { updatedAt: _updatedAt, ...missing } = settings;
    expect(bookingSettingsSchema.safeParse(missing).success).toBe(false);
  });
});
