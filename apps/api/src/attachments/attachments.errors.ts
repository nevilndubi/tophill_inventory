import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class AttachmentNotFoundException extends NotFoundException {
  constructor() {
    super(body('ATTACHMENT_NOT_FOUND', 'Attachment was not found'));
  }
}

export class AttachmentObjectMissingException extends NotFoundException {
  constructor() {
    super(body('ATTACHMENT_OBJECT_MISSING', 'Uploaded object was not found'));
  }
}

export class AttachmentLimitReachedException extends ConflictException {
  constructor(limit: number) {
    super(body('ATTACHMENT_LIMIT_REACHED', 'Machine attachment limit has been reached', { limit }));
  }
}

export class AttachmentConfirmationConflictException extends ConflictException {
  constructor() {
    super(body('ATTACHMENT_CONFIRMATION_CONFLICT', 'Upload confirmation is invalid or conflicts'));
  }
}

export class AttachmentUploadExpiredException extends GoneException {
  constructor() {
    super(body('ATTACHMENT_UPLOAD_EXPIRED', 'Upload confirmation has expired'));
  }
}

export class AttachmentContentInvalidException extends UnprocessableEntityException {
  constructor(
    code: 'ATTACHMENT_INVALID_TYPE' | 'ATTACHMENT_SIZE_MISMATCH' | 'ATTACHMENT_INVALID_CONTENT',
  ) {
    const messages = {
      ATTACHMENT_INVALID_CONTENT: 'Uploaded file content does not match its declared type',
      ATTACHMENT_INVALID_TYPE: 'Uploaded file type is not allowed',
      ATTACHMENT_SIZE_MISMATCH: 'Uploaded file size does not match the declared size',
    } as const;
    super(body(code, messages[code]));
  }
}

export class AttachmentInvalidTypeException extends BadRequestException {
  constructor() {
    super(body('ATTACHMENT_INVALID_TYPE', 'File type is not allowed'));
  }
}

export class AttachmentTooLargeException extends BadRequestException {
  constructor() {
    super(body('ATTACHMENT_TOO_LARGE', 'File must be 10 MiB or smaller'));
  }
}

export class StorageUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(body('STORAGE_UNAVAILABLE', 'Attachment storage is temporarily unavailable'));
  }
}
