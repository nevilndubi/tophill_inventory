import {
  checkInMachineSchema,
  checkOutMachineSchema,
  type CheckInMachineInput,
  type CheckOutMachineInput,
} from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class CheckOutMachineDto
  extends createZodDto(checkOutMachineSchema)
  implements CheckOutMachineInput
{
  declare expectedEndAt?: string;
  declare purpose?: string;
}

export class CheckInMachineDto
  extends createZodDto(checkInMachineSchema)
  implements CheckInMachineInput
{
  declare force: boolean;
  declare note?: string;
  declare reason?: string;
}
