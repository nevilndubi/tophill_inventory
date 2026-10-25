import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class DepartmentNameTakenException extends ConflictException {
  constructor() {
    super({ code: 'DEPARTMENT_NAME_TAKEN', message: 'A department with this name already exists' });
  }
}
export class DepartmentCodeTakenException extends ConflictException {
  constructor() {
    super({ code: 'DEPARTMENT_CODE_TAKEN', message: 'A department with this code already exists' });
  }
}
export class LocationNameTakenException extends ConflictException {
  constructor() {
    super({
      code: 'LOCATION_NAME_TAKEN',
      message: 'A location with this name already exists in the department',
    });
  }
}
export class DepartmentNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });
  }
}
export class LocationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'LOCATION_NOT_FOUND', message: 'Location not found' });
  }
}
export class UserNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'USER_NOT_FOUND', message: 'User not found' });
  }
}
export class ManagerNotEligibleException extends UnprocessableEntityException {
  constructor() {
    super({
      code: 'MANAGER_NOT_ELIGIBLE',
      message: 'The selected user is not eligible to manage this department',
    });
  }
}
export class DepartmentInUseException extends ConflictException {
  constructor(counts: { location_count: number; machine_count: number; user_count: number }) {
    super({
      code: 'DEPARTMENT_IN_USE',
      details: counts,
      message: 'Department is still referenced',
    });
  }
}
export class LocationInUseException extends ConflictException {
  constructor(machineCount: number) {
    super({
      code: 'LOCATION_IN_USE',
      details: { machine_count: machineCount },
      message: 'Location is still referenced',
    });
  }
}
export class LocationDepartmentImmutableException extends BadRequestException {
  constructor() {
    super({
      code: 'LOCATION_DEPARTMENT_IMMUTABLE',
      message: 'A location cannot be moved to another department',
    });
  }
}
