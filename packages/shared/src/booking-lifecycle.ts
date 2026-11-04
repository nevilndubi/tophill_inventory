import { z } from 'zod';

export const BOOKING_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'NO_SHOW',
] as const;

export type BookingStatusValue = (typeof BOOKING_STATUSES)[number];

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const instant = z
  .string()
  .regex(OFFSET_DATE_TIME, 'Timestamp must be ISO-8601 with Z or an explicit offset')
  .refine((value) => Number.isFinite(Date.parse(value)), 'Timestamp must be valid');

const normalizedText = (label: string, maximum: number, required: boolean) =>
  z
    .string()
    .superRefine((value, context) => {
      if (CONTROL_CHARACTER.test(value)) {
        context.addIssue({ code: 'custom', message: `${label} cannot contain control characters` });
      }
    })
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(
      required ? z.string().min(1, `${label} is required`).max(maximum) : z.string().max(maximum),
    );

const repeatableStatus = z.preprocess(
  (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
  z.array(z.enum(BOOKING_STATUSES)).min(1).optional(),
);

export const bookingIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listBookingsQuerySchema = z
  .object({
    machine_id: z.uuid().optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(['starts_at', 'created_at']).default('starts_at'),
    status: repeatableStatus,
    view: z.enum(['mine', 'managed', 'all']).default('mine'),
    when: z.enum(['upcoming', 'past', 'all']).default('all'),
  })
  .strict();

export const updateBookingSchema = z
  .object({
    ends_at: instant.optional(),
    expected_updated_at: instant,
    purpose: normalizedText('Purpose', 200, true).optional(),
    starts_at: instant.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.starts_at !== undefined || value.ends_at !== undefined || value.purpose !== undefined,
    { message: 'At least one booking field must be supplied' },
  );

export const cancelBookingSchema = z
  .object({ reason: normalizedText('Reason', 500, true) })
  .strict();

export const approveBookingSchema = z
  .object({ note: normalizedText('Note', 500, false).optional() })
  .strict();

export const rejectBookingSchema = z.object({ note: normalizedText('Note', 500, true) }).strict();

export const canBookingTransition = (from: BookingStatusValue, to: BookingStatusValue): boolean =>
  (from === 'PENDING' && ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(to)) ||
  (from === 'CONFIRMED' && ['PENDING', 'CANCELLED'].includes(to));

export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type ApproveBookingInput = z.infer<typeof approveBookingSchema>;
export type RejectBookingInput = z.infer<typeof rejectBookingSchema>;

export type BookingCapabilities = Readonly<{
  can_approve: boolean;
  can_cancel: boolean;
  can_reject: boolean;
  can_reschedule: boolean;
}>;

export type ManagedBooking = Readonly<{
  approved_or_decided_by: Readonly<{ full_name: string; id: string }> | null;
  as_of: string;
  blocked_until: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  capabilities: BookingCapabilities;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  effective_buffer_minutes: number;
  ends_at: string;
  id: string;
  late_cancelled: boolean;
  machine: Readonly<{
    asset_tag: string | null;
    id: string;
    is_removed: boolean;
    name: string | null;
    owning_department: Readonly<{ code: string; id: string; name: string }> | null;
  }>;
  purpose: string;
  requester: Readonly<{ full_name: string; id: string }>;
  requires_approval: boolean;
  stale: boolean;
  starts_at: string;
  status: BookingStatusValue;
  updated_at: string;
}>;

export type ManagedBookingPage = Readonly<{
  items: ManagedBooking[];
  meta: Readonly<{ page: number; page_size: number; total: number }>;
}>;
