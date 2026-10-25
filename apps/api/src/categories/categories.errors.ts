import { ConflictException, NotFoundException } from '@nestjs/common';

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
  message,
});

export class CategoryNameTakenException extends ConflictException {
  constructor() {
    super(body('CATEGORY_NAME_TAKEN', 'A category with this name already exists'));
  }
}

export class CategoryInUseException extends ConflictException {
  constructor(machineCount: number) {
    super(
      body('CATEGORY_IN_USE', 'The category is referenced by machines', {
        machine_count: machineCount,
      }),
    );
  }
}

export class CategoryNotFoundException extends NotFoundException {
  constructor() {
    super(body('CATEGORY_NOT_FOUND', 'Category was not found'));
  }
}
