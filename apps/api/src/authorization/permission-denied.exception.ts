import { ForbiddenException } from '@nestjs/common';

export class PermissionDeniedException extends ForbiddenException {
  constructor() {
    super({
      code: 'PERMISSION_DENIED',
      details: {},
      message: 'You do not have permission to perform this action',
    });
  }
}
