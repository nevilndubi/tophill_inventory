import { z } from 'zod';

export type ZodDtoConstructor = {
  new (): unknown;
  schema: z.ZodType;
};

export const createZodDto = <Schema extends z.ZodType>(schema: Schema) => {
  abstract class ZodDto {
    static readonly schema = schema;
  }

  return ZodDto;
};
