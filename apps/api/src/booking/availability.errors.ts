import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class AvailabilityMachineNotFoundException extends NotFoundException {
  constructor() {
    super(body('MACHINE_NOT_FOUND', 'Machine was not found'));
  }
}

export class AvailabilityRangeInvalidException extends BadRequestException {
  constructor(reason: string) {
    super(body('AVAILABILITY_RANGE_INVALID', 'Availability range is invalid', { reason }));
  }
}

export class AvailabilityPolicyInvalidException extends ServiceUnavailableException {
  constructor() {
    super(
      body('BOOKING_POLICY_INVALID', 'Booking policy is temporarily unavailable', {
        retryable: true,
      }),
    );
  }
}
