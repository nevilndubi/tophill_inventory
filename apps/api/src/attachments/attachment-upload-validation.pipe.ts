import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { requestAttachmentUploadSchema, type RequestAttachmentUploadInput } from '@app/shared';
import { AttachmentInvalidTypeException, AttachmentTooLargeException } from './attachments.errors';

@Injectable()
export class AttachmentUploadValidationPipe implements PipeTransform {
  transform(value: unknown): RequestAttachmentUploadInput {
    const result = requestAttachmentUploadSchema.safeParse(value);
    if (result.success) return result.data;
    if (result.error.issues.some((issue) => issue.path[0] === 'mimeType')) {
      throw new AttachmentInvalidTypeException();
    }
    if (
      result.error.issues.some((issue) => issue.path[0] === 'sizeBytes' && issue.code === 'too_big')
    ) {
      throw new AttachmentTooLargeException();
    }
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      details: {
        issues: result.error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.join('.'),
        })),
      },
      message: 'Validation failed',
    });
  }
}
