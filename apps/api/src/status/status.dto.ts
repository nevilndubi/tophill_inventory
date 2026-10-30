import { statusBoardQuerySchema, type DisplayStatus, type StatusBoardSortField } from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class StatusBoardQueryDto extends createZodDto(statusBoardQuerySchema) {
  declare category_id?: string;
  declare department_id?: string;
  declare location_id?: string;
  declare order: 'asc' | 'desc';
  declare page: number;
  declare page_size: number;
  declare q?: string;
  declare service_due?: true;
  declare sort: StatusBoardSortField;
  declare status?: DisplayStatus[];
}
