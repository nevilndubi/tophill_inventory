import { createBookingSchema } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class CreateBookingDto extends createZodDto(createBookingSchema) {
  declare ends_at: string;
  declare machine_id: string;
  declare purpose: string;
  declare starts_at: string;
}
