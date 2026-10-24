import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@app/shared';

export const REQUIRED_PERMISSION = Symbol('required-permission');

export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);
