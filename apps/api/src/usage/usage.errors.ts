import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { UsageSessionConflict } from '@app/shared';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class MachineNotAvailableException extends ConflictException {
  constructor() {
    super(body('MACHINE_NOT_AVAILABLE', 'Machine condition does not allow check-out'));
  }
}

export class MachineInUseException extends ConflictException {
  constructor(session: UsageSessionConflict) {
    super(
      body('MACHINE_IN_USE', 'Machine already has an open usage session', {
        expected_end_at: session.expectedEndAt,
        held_by_current_user: session.heldByCurrentUser,
        ...(session.holder === undefined
          ? {}
          : { holder: { full_name: session.holder.fullName, id: session.holder.id } }),
        session_id: session.id,
        started_at: session.startedAt,
      }),
    );
  }
}

export class UpcomingBookingConflictException extends ConflictException {
  constructor(startsAt: Date, alreadyStarted: boolean) {
    super(
      body('UPCOMING_BOOKING_CONFLICT', 'Another user has a conflicting confirmed booking', {
        already_started: alreadyStarted,
        starts_at: startsAt.toISOString(),
      }),
    );
  }
}

export class NoOpenSessionException extends ConflictException {
  constructor() {
    super(body('NO_OPEN_SESSION', 'Machine has no open usage session'));
  }
}

export class SessionNotHeldException extends ConflictException {
  constructor() {
    super(body('SESSION_NOT_HELD', 'The open session is held by another user'));
  }
}

export class ForceNotApplicableException extends BadRequestException {
  constructor() {
    super(body('FORCE_NOT_APPLICABLE', 'Force is not applicable to your own usage session'));
  }
}

export class UsageExpectedEndInvalidException extends UnprocessableEntityException {
  constructor() {
    super(
      body(
        'EXPECTED_END_INVALID',
        'Expected end must be between 1 minute and 24 hours after check-out',
      ),
    );
  }
}

export class MachineBusyException extends ServiceUnavailableException {
  constructor() {
    super(body('MACHINE_BUSY', 'Machine is busy; retry the request shortly'));
  }
}

export class UsageSettingsInvalidException extends ServiceUnavailableException {
  constructor() {
    super(body('SETTINGS_INVALID', 'Check-out settings are temporarily unavailable'));
  }
}
