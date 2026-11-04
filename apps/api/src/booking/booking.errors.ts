import {
  ForbiddenException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

const errorBody = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class BookingMachineNotFoundException extends NotFoundException {
  constructor() {
    super(errorBody('MACHINE_NOT_FOUND', 'Machine was not found'));
  }
}

export class BookingSettingsInvalidException extends ServiceUnavailableException {
  constructor(key: string) {
    super(
      errorBody('SETTINGS_INVALID', 'Booking settings are temporarily unavailable', {
        key,
        retryable: true,
      }),
    );
  }
}

export class BookingSettingsChangedException extends ConflictException {
  constructor() {
    super(errorBody('SETTINGS_CHANGED', 'Booking settings changed; reload and try again'));
  }
}

export class BookingPolicyConflictException extends UnprocessableEntityException {
  constructor() {
    super(
      errorBody('POLICY_CONFLICT', 'The minimum booking duration conflicts with a saved maximum'),
    );
  }
}

export class BookingNotFoundException extends NotFoundException {
  constructor() {
    super(errorBody('BOOKING_NOT_FOUND', 'Booking was not found'));
  }
}

export class BookingChangedException extends ConflictException {
  constructor() {
    super(errorBody('BOOKING_CHANGED', 'Booking changed; reload and try again'));
  }
}

export class BookingNotModifiableException extends ConflictException {
  constructor() {
    super(errorBody('BOOKING_NOT_MODIFIABLE', 'Booking cannot be modified in its current state'));
  }
}

export class BookingNotPendingException extends ConflictException {
  constructor() {
    super(errorBody('BOOKING_NOT_PENDING', 'Booking is no longer pending'));
  }
}

export class BookingStartPassedException extends ConflictException {
  constructor() {
    super(errorBody('BOOKING_START_PASSED', 'Booking start time has passed'));
  }
}

export class BookingSelfApprovalDeniedException extends ForbiddenException {
  constructor() {
    super(errorBody('BOOKING_SELF_APPROVAL_DENIED', 'You cannot decide your own booking'));
  }
}

export class BookingRequesterInactiveException extends ConflictException {
  constructor() {
    super(errorBody('BOOKING_REQUESTER_INACTIVE', 'Booking requester is inactive'));
  }
}
