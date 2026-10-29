import { z } from 'zod';

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const USAGE_EXPECTED_END_MINUTES_MIN = 1;
export const USAGE_EXPECTED_END_HOURS_MAX = 24;
export const USAGE_PURPOSE_MAX_LENGTH = 200;
export const USAGE_END_NOTE_MAX_LENGTH = 500;
export const USAGE_FORCE_REASON_MIN_LENGTH = 10;
export const USAGE_FORCE_REASON_MAX_LENGTH = 200;
export const USAGE_DEFAULT_PURPOSE = 'General equipment use';

const normalizedOptionalText = (label: string, maximum: number) =>
  z
    .string()
    .superRefine((value, context) => {
      if (CONTROL_CHARACTER.test(value)) {
        context.addIssue({ code: 'custom', message: `${label} cannot contain control characters` });
      }
    })
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(z.string().min(1, `${label} cannot be blank`).max(maximum))
    .optional();

const expectedEndAtSchema = z
  .string()
  .regex(ISO_DATE_TIME_WITH_OFFSET, 'Expected end must be ISO-8601 with Z or an explicit offset')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected end must be a valid date-time');

export const checkOutMachineSchema = z
  .object({
    expectedEndAt: expectedEndAtSchema.optional(),
    purpose: normalizedOptionalText('Purpose', USAGE_PURPOSE_MAX_LENGTH),
  })
  .strict();

export const checkInMachineSchema = z
  .object({
    force: z.boolean().optional().default(false),
    note: normalizedOptionalText('Check-in note', USAGE_END_NOTE_MAX_LENGTH),
    reason: normalizedOptionalText('Force-end reason', USAGE_FORCE_REASON_MAX_LENGTH),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.force && value.reason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A force-end reason is required',
        path: ['reason'],
      });
    }
    if (value.force && value.reason !== undefined && value.reason.length < 10) {
      context.addIssue({
        code: 'custom',
        message: `Force-end reason must be at least ${USAGE_FORCE_REASON_MIN_LENGTH} characters`,
        path: ['reason'],
      });
    }
    if (!value.force && value.reason !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Reason is accepted only for a forced check-in',
        path: ['reason'],
      });
    }
  });

export type CheckOutMachineInput = z.infer<typeof checkOutMachineSchema>;
export type CheckInMachineInput = z.infer<typeof checkInMachineSchema>;

export type UsageSessionDto = Readonly<{
  durationSeconds?: number;
  endedAt?: string;
  expectedEndAt: string | null;
  id: string;
  machineId: string;
  purpose: string;
  startedAt: string;
}>;

export type UsageSessionConflict = Readonly<{
  expectedEndAt: string | null;
  heldByCurrentUser: boolean;
  holder?: Readonly<{ fullName: string; id: string }>;
  id: string;
  startedAt: string;
}>;

export type UsageSessionEvent = Readonly<{
  actorUserId: string;
  forced: boolean;
  machineId: string;
  requestId: string;
  sessionId: string;
  timestamp: string;
  type: 'CHECKED_OUT' | 'CHECKED_IN' | 'FORCE_ENDED';
  userId: string;
}>;
