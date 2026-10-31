import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { BookingPolicyConflictException, BookingSettingsInvalidException } from './booking.errors';

type Transaction = Pick<Prisma.TransactionClient, '$queryRaw'>;
const logger = new Logger('BookingPolicyValidation');

export const assertMaximumMeetsMinimum = async (
  transaction: Transaction,
  maximum: number | null,
): Promise<void> => {
  if (maximum === null) return;
  const rows = await transaction.$queryRaw<Array<{ value: Prisma.JsonValue }>>`
    SELECT value
    FROM app_settings
    WHERE key = 'booking.min_duration_minutes'
    FOR SHARE
  `;
  const row = rows[0];
  if (row === undefined || typeof row.value !== 'number' || !Number.isSafeInteger(row.value)) {
    logger.warn('Invalid application setting key=booking.min_duration_minutes');
    throw new BookingSettingsInvalidException('booking.min_duration_minutes');
  }
  if (maximum < row.value) throw new BookingPolicyConflictException();
};
