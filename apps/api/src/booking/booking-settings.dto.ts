import { updateBookingSettingsSchema, type UpdateBookingSettings } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class UpdateBookingSettingsDto extends createZodDto(updateBookingSettingsSchema) {
  declare expectedUpdatedAt: string;
  declare maxDurationMinutes?: number;
  declare minDurationMinutes?: number;
  declare minLeadMinutes?: number;
  declare maxAdvanceDays?: number;
  declare defaultBufferMinutes?: number;
  declare noShowGraceMinutes?: number;
  declare adhocGuardMinutes?: number;
}

export type { UpdateBookingSettings };
