import { describe, expect, it } from '@jest/globals';
import {
  BOOKING_STATUSES,
  approveBookingSchema,
  canBookingTransition,
  cancelBookingSchema,
  listBookingsQuerySchema,
  rejectBookingSchema,
  updateBookingSchema,
  type BookingStatusValue,
} from '@app/shared';

const allowed: ReadonlySet<string> = new Set([
  'PENDING:CONFIRMED',
  'PENDING:REJECTED',
  'PENDING:CANCELLED',
  'CONFIRMED:PENDING',
  'CONFIRMED:CANCELLED',
]);

describe('booking lifecycle contracts', () => {
  it('fails closed against the independently enumerated transition matrix', () => {
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        const actual = canBookingTransition(from, to);
        const expected = allowed.has(`${from}:${to}`);
        if (actual !== expected)
          throw new Error(`Unexpected transition result for ${from} -> ${to}`);
        expect(actual).toBe(expected);
      }
    }
  });

  it('normalizes lifecycle text and rejects control characters', () => {
    expect(cancelBookingSchema.parse({ reason: '  Plans   changed  ' })).toEqual({
      reason: 'Plans changed',
    });
    expect(approveBookingSchema.parse({ note: '  Looks   safe  ' })).toEqual({
      note: 'Looks safe',
    });
    expect(rejectBookingSchema.safeParse({ note: '\u0000unsafe' }).success).toBe(false);
  });

  it('requires an optimistic token and at least one editable PATCH field', () => {
    const expected_updated_at = '2026-11-04T08:00:00.000Z';
    expect(updateBookingSchema.parse({ expected_updated_at, purpose: '  Ward   round  ' })).toEqual(
      { expected_updated_at, purpose: 'Ward round' },
    );
    expect(updateBookingSchema.safeParse({ expected_updated_at }).success).toBe(false);
    expect(
      updateBookingSchema.safeParse({ expected_updated_at, purpose: 'Valid', status: 'CANCELLED' })
        .success,
    ).toBe(false);
  });

  it('parses repeatable status filters and rejects unknown list query parameters', () => {
    expect(
      listBookingsQuerySchema.parse({ status: ['PENDING', 'CONFIRMED'], view: 'managed' }),
    ).toMatchObject({ status: ['PENDING', 'CONFIRMED'], view: 'managed' });
    expect(listBookingsQuerySchema.parse({ status: 'PENDING' }).status).toEqual(['PENDING']);
    expect(listBookingsQuerySchema.safeParse({ surprise: true }).success).toBe(false);
  });

  it('contains the complete persisted status set', () => {
    const expected: BookingStatusValue[] = [
      'PENDING',
      'CONFIRMED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'REJECTED',
      'NO_SHOW',
    ];
    expect(BOOKING_STATUSES).toEqual(expected);
  });
});
