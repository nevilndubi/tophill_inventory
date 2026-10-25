import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

const body = (code: string, message: string) => ({ code, details: {}, message });

export class UserAlreadyExistsException extends ConflictException {
  constructor() {
    super(body('USER_ALREADY_EXISTS', 'A local user already exists for this address'));
  }
}

export class AuthIdentityExistsException extends ConflictException {
  constructor() {
    super(body('AUTH_IDENTITY_EXISTS', 'An authentication identity already exists'));
  }
}

export class UserNotFoundException extends NotFoundException {
  constructor() {
    super(body('USER_NOT_FOUND', 'User was not found'));
  }
}

export class SeedUserProtectedException extends ForbiddenException {
  constructor() {
    super(body('SEED_USER_PROTECTED', 'Seed users cannot be managed'));
  }
}

export class UserManagementDeniedException extends ForbiddenException {
  constructor(code = 'USER_MANAGEMENT_DENIED', message = 'This user change is not permitted') {
    super(body(code, message));
  }
}

export class LastSuperAdminException extends ConflictException {
  constructor() {
    super(body('LAST_SUPER_ADMIN', 'The final active super administrator is protected'));
  }
}

export class DepartmentNotFoundException extends ConflictException {
  constructor() {
    super(body('DEPARTMENT_NOT_FOUND', 'The selected department does not exist'));
  }
}

export class OrphanedAuthIdentityException extends BadGatewayException {
  constructor() {
    super(body('ORPHANED_AUTH_IDENTITY', 'User invitation could not be reconciled'));
  }
}

export class UserManagementUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(body('USER_MANAGEMENT_UNAVAILABLE', 'User management is temporarily unavailable'));
  }
}
