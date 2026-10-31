import {
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
