import {
  createMachineSchema,
  listMachinesQuerySchema,
  machineDetailQuerySchema,
  machineConditionTransitionSchema,
  machineHistoryQuerySchema,
  machineImportQuerySchema,
  machineIdParamsSchema,
  machineRegistryMutationSchema,
  type MachineRegistryState,
  updateMachineSchema,
  type MachineCondition,
  type MachineSortField,
} from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class MachineIdParamsDto extends createZodDto(machineIdParamsSchema) {
  declare id: string;
}

export class CreateMachineDto extends createZodDto(createMachineSchema) {
  declare allowBookingWhenNeedsService?: boolean;
  declare bufferMinutes?: number | null;
  declare categoryId: string;
  declare commissionedOn?: string | null;
  declare departmentId: string;
  declare description?: string | null;
  declare isBookable?: boolean;
  declare lastServicedAt?: string | null;
  declare locationId: string;
  declare manufacturer: string;
  declare maxBookingMinutes?: number | null;
  declare model: string;
  declare name: string;
  declare purchaseDate?: string | null;
  declare requiresApproval?: boolean;
  declare serialNumber: string;
  declare serviceIntervalDays?: number | null;
  declare warrantyExpiresOn?: string | null;
}

export class UpdateMachineDto extends createZodDto(updateMachineSchema) {
  declare allowBookingWhenNeedsService?: boolean;
  declare bufferMinutes?: number | null;
  declare categoryId?: string;
  declare commissionedOn?: string | null;
  declare departmentId?: string;
  declare description?: string | null;
  declare isBookable?: boolean;
  declare lastServicedAt?: string | null;
  declare locationId?: string;
  declare manufacturer?: string;
  declare maxBookingMinutes?: number | null;
  declare model?: string;
  declare name?: string;
  declare purchaseDate?: string | null;
  declare requiresApproval?: boolean;
  declare serialNumber?: string;
  declare serviceIntervalDays?: number | null;
  declare warrantyExpiresOn?: string | null;
}

export class ListMachinesQueryDto extends createZodDto(listMachinesQuerySchema) {
  declare category_id?: string;
  declare condition?: MachineCondition;
  declare department_id?: string;
  declare direction: 'asc' | 'desc';
  declare is_bookable?: boolean;
  declare location_id?: string;
  declare page: number;
  declare pageSize: number;
  declare registry: MachineRegistryState;
  declare search?: string;
  declare service_due?: boolean;
  declare sort: MachineSortField;
}

export class MachineDetailQueryDto extends createZodDto(machineDetailQuerySchema) {
  declare include_deleted?: true;
}

export class MachineRegistryMutationDto extends createZodDto(machineRegistryMutationSchema) {
  declare reason?: string;
}

export class MachineConditionTransitionDto extends createZodDto(machineConditionTransitionSchema) {
  declare force: boolean;
  declare fromCondition: MachineCondition;
  declare reason: string;
  declare toCondition: MachineCondition;
}

export class MachineHistoryQueryDto extends createZodDto(machineHistoryQuerySchema) {
  declare include_deleted?: true;
  declare page: number;
  declare pageSize: number;
}

export class MachineImportQueryDto extends createZodDto(machineImportQuerySchema) {
  declare mode: 'commit' | 'dry_run' | 'partial';
}
