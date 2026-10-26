import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class MachineNotFoundException extends NotFoundException {
  constructor() {
    super(body('MACHINE_NOT_FOUND', 'Machine was not found'));
  }
}

export class MachineIdentityTakenException extends ConflictException {
  constructor() {
    super(
      body(
        'MACHINE_IDENTITY_TAKEN',
        'A machine with this manufacturer and serial number already exists',
      ),
    );
  }
}

export class MachineCategoryNotFoundException extends NotFoundException {
  constructor() {
    super(body('MACHINE_CATEGORY_NOT_FOUND', 'Machine category was not found'));
  }
}

export class MachineDepartmentNotFoundException extends NotFoundException {
  constructor() {
    super(body('MACHINE_DEPARTMENT_NOT_FOUND', 'Machine department was not found'));
  }
}

export class MachineLocationNotFoundException extends NotFoundException {
  constructor() {
    super(body('MACHINE_LOCATION_NOT_FOUND', 'Machine location was not found'));
  }
}

export class MachineAlreadyDeletedException extends ConflictException {
  constructor() {
    super(body('MACHINE_ALREADY_DELETED', 'Machine is already removed from the active registry'));
  }
}

export class MachineHasOpenSessionException extends ConflictException {
  constructor() {
    super(body('MACHINE_HAS_OPEN_SESSION', 'Machine has an open usage session'));
  }
}

export class MachineHasActiveBookingsException extends ConflictException {
  constructor(count: number) {
    super(
      body('MACHINE_HAS_ACTIVE_BOOKINGS', 'Machine has active bookings', {
        booking_count: count,
      }),
    );
  }
}

export class MachineDatesInvalidException extends UnprocessableEntityException {
  constructor(field: string, message: string) {
    super(body('MACHINE_DATES_INVALID', 'Machine lifecycle dates are invalid', { field, message }));
  }
}

export class MachineConstraintViolationException extends UnprocessableEntityException {
  constructor() {
    super(body('MACHINE_VALUES_INVALID', 'One or more machine values violate a business rule'));
  }
}
