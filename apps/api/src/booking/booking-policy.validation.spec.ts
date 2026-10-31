import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '../generated/prisma/client';
import { BookingPolicyConflictException, BookingSettingsInvalidException } from './booking.errors';
import { assertMaximumMeetsMinimum } from './booking-policy.validation';

const transactionFor = (value: unknown) => ({
  $queryRaw: jest.fn(async () => (value === undefined ? [] : [{ value }])),
});

describe('assertMaximumMeetsMinimum', () => {
  it('accepts a maximum at the global minimum and rejects a smaller value', async () => {
    const transaction = transactionFor(15);
    await expect(
      assertMaximumMeetsMinimum(transaction as unknown as Prisma.TransactionClient, 15),
    ).resolves.toBeUndefined();
    await expect(
      assertMaximumMeetsMinimum(transaction as unknown as Prisma.TransactionClient, 14),
    ).rejects.toBeInstanceOf(BookingPolicyConflictException);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid stored minimums and skips inherited maximums', async () => {
    const invalid = transactionFor('15');
    await expect(
      assertMaximumMeetsMinimum(invalid as unknown as Prisma.TransactionClient, 30),
    ).rejects.toBeInstanceOf(BookingSettingsInvalidException);
    const inherited = transactionFor(undefined);
    await expect(
      assertMaximumMeetsMinimum(inherited as unknown as Prisma.TransactionClient, null),
    ).resolves.toBeUndefined();
    expect(inherited.$queryRaw).not.toHaveBeenCalled();
  });
});
