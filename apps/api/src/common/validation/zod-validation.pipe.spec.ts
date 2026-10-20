import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from './zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

class FixtureDto extends createZodDto(z.object({ name: z.string().min(1) }).strict()) {}

const metadata: ArgumentMetadata = {
  data: undefined,
  metatype: FixtureDto,
  type: 'body',
};

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  it('returns parsed data for a Zod DTO', () => {
    expect(pipe.transform({ name: 'Infusion Pump' }, metadata)).toEqual({
      name: 'Infusion Pump',
    });
  });

  it('throws the standard validation exception payload', () => {
    expect(() => pipe.transform({}, metadata)).toThrow(BadRequestException);

    try {
      pipe.transform({}, metadata);
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: {
          issues: [
            {
              path: 'name',
            },
          ],
        },
        message: 'Validation failed',
      });
    }
  });
});
