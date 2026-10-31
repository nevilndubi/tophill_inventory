import { Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_SETTING_DEFAULTS,
  bookingSettingsSchema,
  updateBookingSettingsSchema,
  type BookingSettings,
  type UpdateBookingSettings,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BookingPolicyConflictException,
  BookingSettingsChangedException,
  BookingSettingsInvalidException,
} from './booking.errors';

export const BOOKING_SETTING_KEYS = Object.keys(BOOKING_SETTING_DEFAULTS) as Array<
  keyof typeof BOOKING_SETTING_DEFAULTS
>;
const logger = new Logger('BookingSettingsService');

export type SettingRow = {
  key: string;
  updatedAt: Date;
  value: Prisma.JsonValue;
};

const FIELD_TO_KEY = {
  maxDurationMinutes: 'booking.max_duration_minutes',
  minDurationMinutes: 'booking.min_duration_minutes',
  minLeadMinutes: 'booking.min_lead_minutes',
  maxAdvanceDays: 'booking.max_advance_days',
  defaultBufferMinutes: 'booking.default_buffer_minutes',
  noShowGraceMinutes: 'booking.no_show_grace_minutes',
  adhocGuardMinutes: 'checkout.adhoc_guard_minutes',
} as const;

const numberFrom = (row: SettingRow | undefined, key: string): number => {
  if (row === undefined || typeof row.value !== 'number' || !Number.isSafeInteger(row.value)) {
    logger.warn(`Invalid application setting key=${key}`);
    throw new BookingSettingsInvalidException(key);
  }
  return row.value;
};

export const settingsFromRows = (rows: readonly SettingRow[]): BookingSettings => {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const latest = rows.reduce<Date | null>(
    (value, row) => (value === null || row.updatedAt > value ? row.updatedAt : value),
    null,
  );
  if (latest === null) {
    const key = BOOKING_SETTING_KEYS[0];
    if (key === undefined) throw new Error('Booking setting keys are not configured');
    logger.warn(`Missing application setting key=${key}`);
    throw new BookingSettingsInvalidException(key);
  }
  const values = {
    adhocGuardMinutes: numberFrom(
      byKey.get(FIELD_TO_KEY.adhocGuardMinutes),
      FIELD_TO_KEY.adhocGuardMinutes,
    ),
    defaultBufferMinutes: numberFrom(
      byKey.get(FIELD_TO_KEY.defaultBufferMinutes),
      FIELD_TO_KEY.defaultBufferMinutes,
    ),
    maxAdvanceDays: numberFrom(byKey.get(FIELD_TO_KEY.maxAdvanceDays), FIELD_TO_KEY.maxAdvanceDays),
    maxDurationMinutes: numberFrom(
      byKey.get(FIELD_TO_KEY.maxDurationMinutes),
      FIELD_TO_KEY.maxDurationMinutes,
    ),
    minDurationMinutes: numberFrom(
      byKey.get(FIELD_TO_KEY.minDurationMinutes),
      FIELD_TO_KEY.minDurationMinutes,
    ),
    minLeadMinutes: numberFrom(byKey.get(FIELD_TO_KEY.minLeadMinutes), FIELD_TO_KEY.minLeadMinutes),
    noShowGraceMinutes: numberFrom(
      byKey.get(FIELD_TO_KEY.noShowGraceMinutes),
      FIELD_TO_KEY.noShowGraceMinutes,
    ),
    updatedAt: latest.toISOString(),
  };
  const parsed = bookingSettingsSchema.safeParse(values);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const key =
      typeof field === 'string' && field in FIELD_TO_KEY
        ? FIELD_TO_KEY[field as keyof typeof FIELD_TO_KEY]
        : FIELD_TO_KEY.maxDurationMinutes;
    logger.warn(`Invalid application setting key=${key}`);
    throw new BookingSettingsInvalidException(key);
  }
  return parsed.data;
};

@Injectable()
export class BookingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async read(): Promise<BookingSettings> {
    const rows = await this.prisma.appSetting.findMany({
      select: { key: true, updatedAt: true, value: true },
      where: { key: { in: BOOKING_SETTING_KEYS } },
    });
    return settingsFromRows(rows);
  }

  async update(
    actor: AuthenticatedUser,
    input: UpdateBookingSettings,
    requestId: string,
  ): Promise<BookingSettings> {
    const { expectedUpdatedAt, ...requested } = updateBookingSettingsSchema.parse(input);
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<SettingRow[]>`
        SELECT key, value, updated_at AS "updatedAt"
        FROM app_settings
        WHERE key IN (${Prisma.join(BOOKING_SETTING_KEYS)})
        ORDER BY key
        FOR UPDATE
      `;
      const current = settingsFromRows(rows);
      if (current.updatedAt !== expectedUpdatedAt) throw new BookingSettingsChangedException();

      const next = { ...current, ...requested };
      const validated = bookingSettingsSchema.safeParse(next);
      if (!validated.success) throw new BookingPolicyConflictException();
      const conflictingMaximum = await transaction.$queryRaw<Array<{ conflict: boolean }>>`
        SELECT (
          EXISTS (
            SELECT 1 FROM machines
            WHERE max_booking_minutes IS NOT NULL
              AND max_booking_minutes < ${validated.data.minDurationMinutes}
          )
          OR EXISTS (
            SELECT 1 FROM machine_categories
            WHERE default_max_booking_minutes IS NOT NULL
              AND default_max_booking_minutes < ${validated.data.minDurationMinutes}
          )
        ) AS conflict
      `;
      if (conflictingMaximum[0]?.conflict) throw new BookingPolicyConflictException();

      const changed = Object.entries(requested).filter(
        ([field, value]) => current[field as keyof BookingSettings] !== value,
      );
      if (changed.length === 0) return current;

      const before: Record<string, Prisma.InputJsonValue> = {};
      const after: Record<string, Prisma.InputJsonValue> = {};
      for (const [field, value] of changed) {
        const key = FIELD_TO_KEY[field as keyof typeof FIELD_TO_KEY];
        const previous = current[field as keyof BookingSettings];
        if (typeof previous !== 'number' || typeof value !== 'number') continue;
        before[key] = previous;
        after[key] = value;
        await transaction.appSetting.update({
          data: { value },
          where: { key },
        });
      }
      await this.audit.record(transaction, {
        action: 'settings.updated',
        actorUserId: actor.id,
        after,
        before,
        entityId: 'booking',
        entityType: 'app_settings',
        requestId,
      });
      const updatedRows = await transaction.appSetting.findMany({
        select: { key: true, updatedAt: true, value: true },
        where: { key: { in: BOOKING_SETTING_KEYS } },
      });
      return settingsFromRows(updatedRows);
    });
  }
}

export const settingFieldToKey = FIELD_TO_KEY;
