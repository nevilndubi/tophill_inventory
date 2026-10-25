import { z } from 'zod';

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

const normalizedText = (label: string, maximum: number) =>
  z
    .string()
    .superRefine((value, context) => {
      if (CONTROL_CHARACTER.test(value)) {
        context.addIssue({ code: 'custom', message: `${label} cannot contain control characters` });
      }
    })
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(maximum, `${label} must be ${maximum} characters or fewer`),
    );

const optionalLocationText = (label: string) =>
  z
    .string()
    .superRefine((value, context) => {
      if (CONTROL_CHARACTER.test(value)) {
        context.addIssue({ code: 'custom', message: `${label} cannot contain control characters` });
      }
    })
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(z.string().max(40, `${label} must be 40 characters or fewer`))
    .transform((value) => (value === '' ? null : value));

const departmentFields = {
  code: z
    .string()
    .transform((value) => value.normalize('NFC').trim().toUpperCase())
    .pipe(
      z
        .string()
        .min(2, 'Code must be at least 2 characters')
        .max(12, 'Code must be 12 characters or fewer')
        .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Use only A-Z, 0-9, and single hyphens'),
    ),
  managerUserId: z.uuid().nullable().optional(),
  name: normalizedText('Name', 80),
};

const locationFields = {
  building: optionalLocationText('Building').nullable().optional(),
  departmentId: z.uuid(),
  floor: optionalLocationText('Floor').nullable().optional(),
  name: normalizedText('Name', 80),
  room: optionalLocationText('Room').nullable().optional(),
};

export const createDepartmentSchema = z.object(departmentFields).strict();
export const updateDepartmentSchema = z
  .object({
    code: departmentFields.code.optional(),
    managerUserId: departmentFields.managerUserId,
    name: departmentFields.name.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createLocationSchema = z.object(locationFields).strict();
export const updateLocationSchema = z
  .object({
    building: locationFields.building,
    departmentId: z.uuid().optional(),
    floor: locationFields.floor,
    name: locationFields.name.optional(),
    room: locationFields.room,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const departmentIdParamsSchema = z.object({ id: z.uuid() }).strict();
export const locationIdParamsSchema = departmentIdParamsSchema;
export const listLocationsQuerySchema = z
  .object({
    departmentId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    search: z.string().trim().max(80).optional(),
  })
  .strict();

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;

export type DepartmentSummary = { code: string; id: string; name: string };
export type EligibleManager = { full_name: string; id: string };
export type ManagedDepartmentReference = DepartmentSummary & {
  is_deletable: boolean;
  location_count: number;
  machine_count: number;
  manager: { full_name: string; id: string } | null;
  user_count: number;
};
export type ManagedLocation = {
  building: string | null;
  department: DepartmentSummary;
  floor: string | null;
  id: string;
  is_deletable: boolean;
  machine_count: number;
  name: string;
  room: string | null;
};
export type ManagedLocationPage = {
  items: readonly ManagedLocation[];
  page: number;
  pageSize: number;
  total: number;
};
