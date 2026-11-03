import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { BookingWindowErrorCode } from '@app/shared';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class BookingWindowException extends UnprocessableEntityException {
  constructor(code: Exclude<BookingWindowErrorCode, 'BOOKING_WINDOW_INVALID' | 'POLICY_INVALID'>) {
    const messages = {
      BOOKING_TOO_FAR_AHEAD: 'Booking starts beyond the permitted advance window',
      BOOKING_TOO_LONG: 'Booking duration exceeds the permitted maximum',
      BOOKING_TOO_SHORT: 'Booking duration is below the permitted minimum',
      BOOKING_TOO_SOON: 'Booking does not meet the minimum lead time',
      MACHINE_NOT_BOOKABLE: 'Machine is not currently bookable',
    } as const;
    super(body(code, messages[code]));
  }
}

export class BookingWindowInvalidException extends BadRequestException {
  constructor() {
    super(body('BOOKING_WINDOW_INVALID', 'Booking window is invalid'));
  }
}

export class BookingPolicyUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(
      body('BOOKING_POLICY_INVALID', 'Booking policy is temporarily unavailable', {
        retryable: true,
      }),
    );
  }
}

export class BookingConflictException extends ConflictException {
  constructor(conflict: {
    blocked_until: string;
    ends_at: string;
    starts_at: string;
    status: string;
  }) {
    super(
      body('BOOKING_CONFLICT', 'The requested booking window is no longer available', conflict),
    );
  }
}

export class BookingMachineInUseException extends ConflictException {
  constructor(blockEnd: Date, estimated: boolean) {
    super(
      body('MACHINE_IN_USE', 'Machine is currently in use', {
        block_end: blockEnd.toISOString(),
        estimated,
      }),
    );
  }
}

export class ActiveBookingLimitReachedException extends ConflictException {
  constructor(limit: number, currentCount: number) {
    super(
      body('ACTIVE_BOOKING_LIMIT_REACHED', 'Active booking limit has been reached', {
        current_count: currentCount,
        limit,
      }),
    );
  }
}

export class IdempotencyKeyInvalidException extends BadRequestException {
  constructor() {
    super(body('IDEMPOTENCY_KEY_INVALID', 'Idempotency key is invalid'));
  }
}

export class IdempotencyKeyReusedException extends ConflictException {
  constructor() {
    super(body('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request'));
  }
}

export class BookingMachineBusyException extends ServiceUnavailableException {
  constructor() {
    super(body('MACHINE_BUSY', 'Machine is busy; retry the request', { retryable: true }));
  }
}
