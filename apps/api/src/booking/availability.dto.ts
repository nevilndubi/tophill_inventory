import { availabilitySearchQuerySchema, machineAvailabilityQuerySchema } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class MachineAvailabilityQueryDto extends createZodDto(machineAvailabilityQuerySchema) {
  declare from: string;
  declare to: string;
}

export class AvailabilitySearchQueryDto extends createZodDto(availabilitySearchQuerySchema) {
  declare category_id?: string;
  declare department_id?: string;
  declare end: string;
  declare page: number;
  declare page_size: number;
  declare start: string;
}
