import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class MachineDeletedException extends ConflictException {
  constructor() {
    super(body('MACHINE_DELETED', 'A removed machine cannot change condition'));
  }
}

export class InvalidConditionTransitionException extends ConflictException {
  constructor() {
    super(body('INVALID_TRANSITION', 'That machine condition transition is not allowed'));
  }
}

export class ConditionUnchangedException extends ConflictException {
  constructor() {
    super(body('CONDITION_UNCHANGED', 'Machine is already in that condition'));
  }
}

export class ConditionChangedException extends ConflictException {
  constructor(currentCondition: string) {
    super(
      body('CONDITION_CHANGED', 'Machine condition changed since it was loaded', {
        current_condition: currentCondition,
      }),
    );
  }
}

export class ConditionForceInvalidException extends UnprocessableEntityException {
  constructor() {
    super(
      body(
        'CONDITION_FORCE_INVALID',
        'Force is available only for an unsafe in-use machine moving out of service',
      ),
    );
  }
}

export class ConditionTicketNotFoundException extends NotFoundException {
  constructor() {
    super(body('SERVICE_TICKET_NOT_FOUND', 'Service ticket was not found for this machine'));
  }
}

export class ConditionReasonInvalidException extends UnprocessableEntityException {
  constructor() {
    super(
      body('CONDITION_REASON_INVALID', 'A condition reason of 1 to 200 characters is required'),
    );
  }
}
