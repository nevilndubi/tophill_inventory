import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class MachineImportInvalidCsvException extends BadRequestException {
  constructor(message = 'The file is not valid comma-delimited UTF-8 CSV') {
    super(body('IMPORT_INVALID_CSV', message));
  }
}

export class MachineImportTooLargeException extends PayloadTooLargeException {
  constructor(limitBytes: number) {
    super(body('IMPORT_FILE_TOO_LARGE', 'The CSV file exceeds the upload limit', { limitBytes }));
  }
}

export class MachineImportTooManyRowsException extends PayloadTooLargeException {
  constructor(limitRows: number) {
    super(body('IMPORT_TOO_MANY_ROWS', 'The CSV file contains too many data rows', { limitRows }));
  }
}

export class MachineImportHeadersException extends BadRequestException {
  constructor(code: 'IMPORT_DUPLICATE_HEADERS' | 'IMPORT_INVALID_HEADERS', message: string) {
    super(body(code, message));
  }
}

export class MachineImportInvalidRowsException extends UnprocessableEntityException {
  constructor() {
    super(body('IMPORT_INVALID_ROWS', 'Resolve the blocking row errors before committing'));
  }
}

export class MachineImportFileChangedException extends ConflictException {
  constructor() {
    super(body('IMPORT_FILE_CHANGED', 'The selected file changed after it was previewed'));
  }
}

export class MachineImportConflictException extends ConflictException {
  constructor() {
    super(body('IMPORT_CONFLICT', 'The import conflicted with a concurrent machine registration'));
  }
}
