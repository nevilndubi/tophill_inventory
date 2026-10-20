import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodDtoConstructor } from './zod-dto';

const getZodDto = (metatype: ArgumentMetadata['metatype']): ZodDtoConstructor | undefined => {
  if (typeof metatype !== 'function') {
    return undefined;
  }

  const candidate = metatype as unknown as Partial<ZodDtoConstructor>;
  return candidate.schema && typeof candidate.schema.safeParse === 'function'
    ? (candidate as ZodDtoConstructor)
    : undefined;
};

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const dto = getZodDto(metadata.metatype);

    if (!dto) {
      return value;
    }

    const result = dto.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          issues: result.error.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path.join('.'),
          })),
        },
      });
    }

    return result.data;
  }
}
