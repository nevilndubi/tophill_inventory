import { categoryIdParamsSchema, createCategorySchema, updateCategorySchema } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class CategoryIdParamsDto extends createZodDto(categoryIdParamsSchema) {
  declare id: string;
}

export class CreateCategoryDto extends createZodDto(createCategorySchema) {
  declare defaultMaxBookingMinutes?: number | null;
  declare defaultServiceIntervalDays?: number | null;
  declare description?: string | null;
  declare name: string;
}

export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {
  declare defaultMaxBookingMinutes?: number | null;
  declare defaultServiceIntervalDays?: number | null;
  declare description?: string | null;
  declare name?: string;
}
