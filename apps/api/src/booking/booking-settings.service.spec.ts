import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BOOKING_SETTING_DEFAULTS, type UpdateBookingSettings } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingPolicyConflictException, BookingSettingsChangedException } from './booking.errors';
import {
  BOOKING_SETTING_KEYS,
  BookingSettingsService,
  type SettingRow,
} from './booking-settings.service';

const originalUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
const changedUpdatedAt = new Date('2026-02-01T00:00:00.000Z');
const rows = (): SettingRow[] =>
  Object.entries(BOOKING_SETTING_DEFAULTS).map(([key, value]) => ({
    key,
    updatedAt: originalUpdatedAt,
    value,
  }));
const actor = {
  department: null,
  email: 'admin@example.test',
  fullName: 'Admin',
  id: 'user-id',
  isActive: true,
  role: 'ADMIN',
} as AuthenticatedUser;

describe('BookingSettingsService', () => {
  const transaction = {
    $queryRaw: jest.fn(async () => [] as unknown[]),
    appSetting: {
      findMany: jest.fn(async () => rows()),
      update: jest.fn(async (_input: unknown) => ({})),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
    appSetting: { findMany: jest.fn(async () => rows()) },
  };
  const audit = { record: jest.fn(async (_transaction: unknown, _record: unknown) => undefined) };
  let service: BookingSettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.$queryRaw.mockResolvedValue(rows());
    transaction.appSetting.findMany.mockResolvedValue(
      rows().map((row) => ({ ...row, updatedAt: changedUpdatedAt })),
    );
    transaction.appSetting.update.mockResolvedValue({});
    service = new BookingSettingsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  it('updates validated settings and writes a transactional audit record', async () => {
    const input: UpdateBookingSettings = {
      expectedUpdatedAt: originalUpdatedAt.toISOString(),
      maxAdvanceDays: 90,
    };
    transaction.$queryRaw
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce([{ conflict: false }]);
    transaction.appSetting.findMany.mockResolvedValue(
      rows().map((row) => ({
        ...row,
        updatedAt: changedUpdatedAt,
        ...(row.key === 'booking.max_advance_days' ? { value: 90 } : {}),
      })),
    );
    await expect(service.update(actor, input, 'request-id')).resolves.toMatchObject({
      maxAdvanceDays: 90,
      updatedAt: changedUpdatedAt.toISOString(),
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction.appSetting.update).toHaveBeenCalledTimes(1);
    expect(transaction.appSetting.update).toHaveBeenCalledWith({
      data: { value: 90 },
      where: { key: 'booking.max_advance_days' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: 'settings.updated',
        after: { 'booking.max_advance_days': 90 },
        before: { 'booking.max_advance_days': 60 },
        entityId: 'booking',
        entityType: 'app_settings',
        requestId: 'request-id',
      }),
    );
    expect(BOOKING_SETTING_KEYS).toContain('booking.max_advance_days');
  });

  it('rejects stale writes before mutation or audit', async () => {
    await expect(
      service.update(
        actor,
        { expectedUpdatedAt: '2025-12-01T00:00:00.000Z', maxAdvanceDays: 90 },
        'request-id',
      ),
    ).rejects.toBeInstanceOf(BookingSettingsChangedException);
    expect(transaction.appSetting.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a minimum duration that conflicts with saved overrides', async () => {
    transaction.$queryRaw.mockResolvedValueOnce(rows()).mockResolvedValueOnce([{ conflict: true }]);
    await expect(
      service.update(
        actor,
        {
          expectedUpdatedAt: originalUpdatedAt.toISOString(),
          minDurationMinutes: 45,
        },
        'request-id',
      ),
    ).rejects.toBeInstanceOf(BookingPolicyConflictException);
    expect(transaction.appSetting.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
