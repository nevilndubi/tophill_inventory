import {
  inviteUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamsSchema,
} from '@app/shared';
import type { AppRole } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class InviteUserDto extends createZodDto(inviteUserSchema) {
  declare departmentId?: string | null;
  declare email: string;
  declare fullName: string;
  declare role: AppRole;
}
export class ListUsersQueryDto extends createZodDto(listUsersQuerySchema) {
  declare active?: boolean;
  declare departmentId?: string;
  declare page: number;
  declare pageSize: number;
  declare role?: AppRole;
  declare search?: string;
}
export class UpdateUserDto extends createZodDto(updateUserSchema) {
  declare departmentId?: string | null;
  declare fullName?: string;
  declare role?: AppRole;
}
export class UserIdParamsDto extends createZodDto(userIdParamsSchema) {
  declare id: string;
}
