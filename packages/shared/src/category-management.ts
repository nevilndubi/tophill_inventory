import { z } from 'zod';

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

const normalizedCategoryName = z
  .string()
  .superRefine((value, context) => {
    if (CONTROL_CHARACTER.test(value)) {
      context.addIssue({ code: 'custom', message: 'Name cannot contain control characters' });
    }
  })
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(1, 'Name is required').max(80, 'Name must be 80 characters or fewer'));

const normalizedDescription = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(500, 'Description must be 500 characters or fewer'))
  .transform((value) => (value === '' ? null : value));

const optionalPositiveInteger = (label: string, minimum: number, maximum: number) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(minimum, `${label} must be at least ${minimum}`)
    .max(maximum, `${label} must be at most ${maximum}`)
    .nullable();

const categoryFields = {
  defaultMaxBookingMinutes: optionalPositiveInteger('Maximum booking time', 5, 1440).optional(),
  defaultServiceIntervalDays: optionalPositiveInteger('Service interval', 1, 3650).optional(),
  description: normalizedDescription.nullable().optional(),
  name: normalizedCategoryName,
};

export const createCategorySchema = z.object(categoryFields).strict();

export const updateCategorySchema = z
  .object({
    defaultMaxBookingMinutes: categoryFields.defaultMaxBookingMinutes,
    defaultServiceIntervalDays: categoryFields.defaultServiceIntervalDays,
    description: categoryFields.description,
    name: categoryFields.name.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const categoryIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export type ManagedCategory = {
  defaultMaxBookingMinutes: number | null;
  defaultServiceIntervalDays: number | null;
  description: string | null;
  id: string;
  is_deletable: boolean;
  machine_count: number;
  name: string;
};
