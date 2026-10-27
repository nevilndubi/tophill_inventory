import {
  attachmentIdParamsSchema,
  confirmAttachmentUploadSchema,
  machineAttachmentParamsSchema,
  requestAttachmentUploadSchema,
} from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class AttachmentIdParamsDto extends createZodDto(attachmentIdParamsSchema) {
  declare id: string;
}

export class MachineAttachmentParamsDto extends createZodDto(machineAttachmentParamsSchema) {
  declare machineId: string;
}

export class RequestAttachmentUploadDto extends createZodDto(requestAttachmentUploadSchema) {
  declare fileName: string;
  declare mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  declare sizeBytes: number;
}

export class ConfirmAttachmentUploadDto extends createZodDto(confirmAttachmentUploadSchema) {
  declare intentToken: string;
}
