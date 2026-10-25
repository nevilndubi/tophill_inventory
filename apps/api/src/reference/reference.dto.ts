import {
  createDepartmentSchema,
  createLocationSchema,
  departmentIdParamsSchema,
  listLocationsQuerySchema,
  locationIdParamsSchema,
  updateDepartmentSchema,
  updateLocationSchema,
} from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class ReferenceIdParamsDto extends createZodDto(departmentIdParamsSchema) {
  declare id: string;
}
export class LocationIdParamsDto extends createZodDto(locationIdParamsSchema) {
  declare id: string;
}
export class CreateDepartmentDto extends createZodDto(createDepartmentSchema) {
  declare code: string;
  declare managerUserId?: string | null;
  declare name: string;
}
export class UpdateDepartmentDto extends createZodDto(updateDepartmentSchema) {
  declare code?: string;
  declare managerUserId?: string | null;
  declare name?: string;
}
export class CreateLocationDto extends createZodDto(createLocationSchema) {
  declare building?: string | null;
  declare departmentId: string;
  declare floor?: string | null;
  declare name: string;
  declare room?: string | null;
}
export class UpdateLocationDto extends createZodDto(updateLocationSchema) {
  declare building?: string | null;
  declare departmentId?: string;
  declare floor?: string | null;
  declare name?: string;
  declare room?: string | null;
}
export class ListLocationsQueryDto extends createZodDto(listLocationsQuerySchema) {
  declare departmentId?: string;
  declare page: number;
  declare pageSize: number;
  declare search?: string;
}
