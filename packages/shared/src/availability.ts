import { z } from 'zod';
import type { BookingPolicySource } from './booking-policy';
import type { MachineDepartmentReference, MachineReference } from './machine-management';

const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const offsetDateTime = z
  .string()
  .regex(OFFSET_DATE_TIME, 'Timestamp must be ISO-8601 with Z or an explicit offset')
  .refine((value) => Number.isFinite(Date.parse(value)), 'Timestamp must be valid');

export const AVAILABILITY_DETAIL_MINUTES_MIN = 1;
export const AVAILABILITY_DETAIL_DAYS_MAX = 62;
export const AVAILABILITY_SEARCH_HOURS_MAX = 24;
export const AVAILABILITY_SEARCH_PAST_TOLERANCE_MINUTES = 1;
export const AVAILABILITY_SEARCH_PAGE_SIZE_DEFAULT = 25;
export const AVAILABILITY_SEARCH_PAGE_SIZE_MAX = 100;

export const machineAvailabilityQuerySchema = z
  .object({ from: offsetDateTime, to: offsetDateTime })
  .strict();

export const availabilitySearchQuerySchema = z
  .object({
    category_id: z.uuid().optional(),
    department_id: z.uuid().optional(),
    end: offsetDateTime,
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce
      .number()
      .int()
      .min(1)
      .max(AVAILABILITY_SEARCH_PAGE_SIZE_MAX)
      .default(AVAILABILITY_SEARCH_PAGE_SIZE_DEFAULT),
    start: offsetDateTime,
  })
  .strict();

export type MachineAvailabilityQuery = z.infer<typeof machineAvailabilityQuerySchema>;
export type AvailabilitySearchQuery = z.infer<typeof availabilitySearchQuerySchema>;

export const candidateBlockedRange = (
  start: Date,
  end: Date,
  bufferMinutes: number,
): Readonly<{ end: Date; start: Date }> => {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    !Number.isSafeInteger(bufferMinutes) ||
    bufferMinutes < 0
  ) {
    throw new RangeError('Candidate booking range is invalid');
  }
  return { end: new Date(end.getTime() + bufferMinutes * 60_000), start: new Date(start) };
};

export type AvailabilityReason =
  | 'ACTIVE_BOOKING'
  | 'BEFORE_LEAD_TIME'
  | 'BEYOND_ADVANCE_WINDOW'
  | 'CONDITION_NOT_BOOKABLE'
  | 'MACHINE_NOT_BOOKABLE'
  | 'OPEN_SESSION';

export type AvailabilityBlock =
  | Readonly<{
      blocked_until: string;
      buffer_minutes: number;
      ends_at: string;
      own: boolean;
      reason: 'ACTIVE_BOOKING';
      starts_at: string;
      status: 'CONFIRMED' | 'IN_PROGRESS' | 'PENDING';
      type: 'BOOKING';
    }>
  | Readonly<{
      end: string;
      estimated: boolean;
      own: boolean;
      reason: 'OPEN_SESSION';
      start: string;
      type: 'USAGE';
    }>
  | Readonly<{
      end: string;
      reason:
        | 'BEFORE_LEAD_TIME'
        | 'BEYOND_ADVANCE_WINDOW'
        | 'CONDITION_NOT_BOOKABLE'
        | 'MACHINE_NOT_BOOKABLE';
      start: string;
      type: 'POLICY';
    }>;

export type AvailabilityPolicySummary = Readonly<{
  bookable: boolean;
  effective_buffer_minutes: number;
  max_duration_minutes: number;
  min_duration_minutes: number;
  requires_approval: boolean;
  sources: Readonly<{
    buffer: BookingPolicySource;
    max_duration: BookingPolicySource;
  }>;
}>;

export type AvailabilityMachineReference = Readonly<{
  asset_tag: string;
  category: MachineReference;
  department: MachineDepartmentReference;
  id: string;
  location: MachineReference;
  name: string;
}>;

export type MachineAvailability = Readonly<{
  as_of: string;
  available_for_entire_range: boolean;
  blocks: readonly AvailabilityBlock[];
  free_windows: readonly Readonly<{ end: string; start: string }>[];
  machine: AvailabilityMachineReference;
  policy: AvailabilityPolicySummary;
  range: Readonly<{ end: string; semantics: '[start,end)'; start: string }>;
  reasons: readonly AvailabilityReason[];
}>;

export type AvailabilitySearchItem = AvailabilityMachineReference &
  Readonly<{
    effective_buffer_minutes: number;
    requires_approval: boolean;
  }>;

export type AvailabilitySearchResult = Readonly<{
  as_of: string;
  items: readonly AvailabilitySearchItem[];
  meta: Readonly<{ page: number; page_size: number; total: number }>;
  range: Readonly<{ end: string; semantics: '[start,end)'; start: string }>;
}>;
