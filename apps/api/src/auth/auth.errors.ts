import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

const errorBody = (code: string, message: string) => ({ code, details: {}, message });

export class InvalidAuthenticationException extends UnauthorizedException {
  constructor() {
    super(errorBody('AUTH_INVALID', 'Authentication credentials are invalid'));
  }
}

export class AuthenticationUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(errorBody('AUTH_UNAVAILABLE', 'Authentication service is temporarily unavailable'));
  }
}

export class UserInactiveException extends ForbiddenException {
  constructor() {
    super(errorBody('USER_INACTIVE', 'User access is inactive'));
  }
}

export class UserNotProvisionedException extends ForbiddenException {
  constructor() {
    super(errorBody('USER_NOT_PROVISIONED', 'User access has not been provisioned'));
  }
}
