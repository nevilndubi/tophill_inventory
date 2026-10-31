import { z } from 'zod';
import { isBookableCondition, type MachineCondition } from './machine-management';

export const BOOKING_POLICY_BOUNDS = {
  maxDurationMinutes: { max: 1440, min: 5 },
  minDurationMinutes: { max: 120, min: 5 },
  minLeadMinutes: { max: 1440, min: 0 },
  maxAdvanceDays: { max: 365, min: 1 },
  bufferMinutes: { max: 240, min: 0 },
  noShowGraceMinutes: { max: 120, min: 0 },
  adhocGuardMinutes: { max: 240, min: 0 },
} as const;

export const BOOKING_SETTINGS_DEFAULTS = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 0,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
} as const;

export const BOOKING_SETTING_DEFAULTS = {
  'booking.max_duration_minutes': BOOKING_SETTINGS_DEFAULTS.maxDurationMinutes,
  'booking.min_duration_minutes': BOOKING_SETTINGS_DEFAULTS.minDurationMinutes,
  'booking.min_lead_minutes': BOOKING_SETTINGS_DEFAULTS.minLeadMinutes,
  'booking.max_advance_days': BOOKING_SETTINGS_DEFAULTS.maxAdvanceDays,
  'booking.default_buffer_minutes': BOOKING_SETTINGS_DEFAULTS.defaultBufferMinutes,
  'booking.no_show_grace_minutes': BOOKING_SETTINGS_DEFAULTS.noShowGraceMinutes,
  'checkout.adhoc_guard_minutes': BOOKING_SETTINGS_DEFAULTS.adhocGuardMinutes,
} as const;

export const bookingSettingsSchema = z
  .object({
    maxDurationMinutes: z.number().int().min(5).max(1440),
    minDurationMinutes: z.number().int().min(5).max(120),
    minLeadMinutes: z.number().int().min(0).max(1440),
    maxAdvanceDays: z.number().int().min(1).max(365),
    defaultBufferMinutes: z.number().int().min(0).max(240),
    noShowGraceMinutes: z.number().int().min(0).max(120),
    adhocGuardMinutes: z.number().int().min(0).max(240),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((value) => value.minDurationMinutes <= value.maxDurationMinutes, {
    message: 'Minimum duration cannot exceed maximum duration',
    path: ['minDurationMinutes'],
  });

export const updateBookingSettingsSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    maxDurationMinutes: bookingSettingsSchema.shape.maxDurationMinutes.optional(),
    minDurationMinutes: bookingSettingsSchema.shape.minDurationMinutes.optional(),
    minLeadMinutes: bookingSettingsSchema.shape.minLeadMinutes.optional(),
    maxAdvanceDays: bookingSettingsSchema.shape.maxAdvanceDays.optional(),
    defaultBufferMinutes: bookingSettingsSchema.shape.defaultBufferMinutes.optional(),
    noShowGraceMinutes: bookingSettingsSchema.shape.noShowGraceMinutes.optional(),
    adhocGuardMinutes: bookingSettingsSchema.shape.adhocGuardMinutes.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
    message: 'At least one setting is required',
  });

export type BookingSettings = z.infer<typeof bookingSettingsSchema>;
export type UpdateBookingSettings = z.infer<typeof updateBookingSettingsSchema>;
export type BookingPolicySource = 'machine' | 'category' | 'global';
export type SourcedValue<T> = { source: BookingPolicySource; value: T };

export type BookingPolicyMachine = {
  allowBookingWhenNeedsService: boolean;
  bufferMinutes: number | null;
  condition: MachineCondition;
  isBookable: boolean;
  maxBookingMinutes: number | null;
  requiresApproval: boolean;
};

export type BookingPolicyCategory = { defaultMaxBookingMinutes: number | null };

export type EffectiveBookingPolicy = {
  bufferMinutes: SourcedValue<number>;
  bookable: { reason: 'NOT_ENABLED' | 'CONDITION' | null; value: boolean };
  maxDurationMinutes: SourcedValue<number>;
  maxAdvanceDays: SourcedValue<number>;
  minDurationMinutes: SourcedValue<number>;
  minLeadMinutes: SourcedValue<number>;
  requiresApproval: SourcedValue<boolean>;
};

export const resolveEffectivePolicy = (
  machine: BookingPolicyMachine,
  category: BookingPolicyCategory,
  settings: BookingSettings,
): EffectiveBookingPolicy => ({
  bufferMinutes:
    machine.bufferMinutes === null
      ? { source: 'global', value: settings.defaultBufferMinutes }
      : { source: 'machine', value: machine.bufferMinutes },
  bookable: {
    reason: !machine.isBookable
      ? 'NOT_ENABLED'
      : isBookableCondition(machine.condition, machine.allowBookingWhenNeedsService)
        ? null
        : 'CONDITION',
    value:
      machine.isBookable &&
      isBookableCondition(machine.condition, machine.allowBookingWhenNeedsService),
  },
  maxDurationMinutes:
    machine.maxBookingMinutes !== null
      ? { source: 'machine', value: machine.maxBookingMinutes }
      : category.defaultMaxBookingMinutes !== null
        ? { source: 'category', value: category.defaultMaxBookingMinutes }
        : { source: 'global', value: settings.maxDurationMinutes },
  maxAdvanceDays: { source: 'global', value: settings.maxAdvanceDays },
  minDurationMinutes: { source: 'global', value: settings.minDurationMinutes },
  minLeadMinutes: { source: 'global', value: settings.minLeadMinutes },
  requiresApproval: { source: 'machine', value: machine.requiresApproval },
});

export type BookingWindowErrorCode =
  | 'BOOKING_WINDOW_INVALID'
  | 'BOOKING_TOO_SHORT'
  | 'BOOKING_TOO_LONG'
  | 'BOOKING_TOO_SOON'
  | 'BOOKING_TOO_FAR_AHEAD'
  | 'MACHINE_NOT_BOOKABLE'
  | 'POLICY_INVALID';

export type BookingWindowResult =
  | { bufferMinutes: number; ok: true }
  | {
      code: BookingWindowErrorCode;
      ok: false;
      reason?: 'NOT_ENABLED' | 'CONDITION';
    };

const isValidDate = (value: Date): boolean => Number.isFinite(value.getTime());
const isWholeMinute = (value: Date): boolean =>
  value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;

export const validateBookingWindow = (
  policy: EffectiveBookingPolicy,
  start: Date,
  end: Date,
  now: Date,
): BookingWindowResult => {
  const maxDuration = policy.maxDurationMinutes.value;
  const minDuration = policy.minDurationMinutes.value;
  const minLead = policy.minLeadMinutes.value;
  const maxAdvance = policy.maxAdvanceDays.value;
  const buffer = policy.bufferMinutes.value;
  if (
    !Number.isInteger(maxDuration) ||
    maxDuration < BOOKING_POLICY_BOUNDS.maxDurationMinutes.min ||
    maxDuration > BOOKING_POLICY_BOUNDS.maxDurationMinutes.max ||
    !Number.isInteger(minDuration) ||
    minDuration < BOOKING_POLICY_BOUNDS.minDurationMinutes.min ||
    minDuration > BOOKING_POLICY_BOUNDS.minDurationMinutes.max ||
    minDuration > maxDuration ||
    !Number.isInteger(minLead) ||
    minLead < BOOKING_POLICY_BOUNDS.minLeadMinutes.min ||
    minLead > BOOKING_POLICY_BOUNDS.minLeadMinutes.max ||
    !Number.isInteger(maxAdvance) ||
    maxAdvance < BOOKING_POLICY_BOUNDS.maxAdvanceDays.min ||
    maxAdvance > BOOKING_POLICY_BOUNDS.maxAdvanceDays.max ||
    !Number.isInteger(buffer) ||
    buffer < BOOKING_POLICY_BOUNDS.bufferMinutes.min ||
    buffer > BOOKING_POLICY_BOUNDS.bufferMinutes.max
  )
    return { code: 'POLICY_INVALID', ok: false };
  if (!policy.bookable.value)
    return {
      code: 'MACHINE_NOT_BOOKABLE',
      ok: false,
      ...(policy.bookable.reason === null ? {} : { reason: policy.bookable.reason }),
    };
  if (
    !isValidDate(start) ||
    !isValidDate(end) ||
    !isValidDate(now) ||
    end.getTime() <= start.getTime()
  )
    return { code: 'BOOKING_WINDOW_INVALID', ok: false };

  if (start.getTime() < now.getTime() + minLead * 60_000)
    return { code: 'BOOKING_TOO_SOON', ok: false };
  if (start.getTime() > now.getTime() + maxAdvance * 86_400_000)
    return { code: 'BOOKING_TOO_FAR_AHEAD', ok: false };
  const duration = end.getTime() - start.getTime();
  if (duration < minDuration * 60_000) return { code: 'BOOKING_TOO_SHORT', ok: false };
  if (duration > maxDuration * 60_000) return { code: 'BOOKING_TOO_LONG', ok: false };
  if (!isWholeMinute(start) || !isWholeMinute(end))
    return { code: 'BOOKING_WINDOW_INVALID', ok: false };
  return { bufferMinutes: buffer, ok: true };
};
