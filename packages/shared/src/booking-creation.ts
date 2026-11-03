import { z } from 'zod';

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const bookingInstant = z
  .string()
  .regex(OFFSET_DATE_TIME, 'Timestamp must be ISO-8601 with Z or an explicit offset')
  .refine((value) => Number.isFinite(Date.parse(value)), 'Timestamp must be valid');

const bookingPurpose = z
  .string()
  .superRefine((value, context) => {
    if (CONTROL_CHARACTER.test(value)) {
      context.addIssue({ code: 'custom', message: 'Purpose cannot contain control characters' });
    }
  })
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
  .pipe(
    z.string().min(1, 'Purpose is required').max(200, 'Purpose must be 200 characters or fewer'),
  );

export const createBookingSchema = z
  .object({
    ends_at: bookingInstant,
    machine_id: z.uuid(),
    purpose: bookingPurpose,
    starts_at: bookingInstant,
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x20-\x7e]+$/, 'Idempotency key must contain printable ASCII only');

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export type CreatedBooking = Readonly<{
  blocked_until: string;
  created_at: string;
  effective_buffer_minutes: number;
  ends_at: string;
  id: string;
  machine: Readonly<{ asset_tag: string; id: string; name: string }>;
  purpose: string;
  requires_approval: boolean;
  starts_at: string;
  status:
    'CONFIRMED' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'REJECTED' | 'NO_SHOW';
}>;
