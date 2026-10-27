import { z } from 'zod';

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const MACHINE_CONDITIONS = [
  'OPERATIONAL',
  'NEEDS_SERVICE',
  'UNDER_MAINTENANCE',
  'OUT_OF_SERVICE',
  'RETIRED',
] as const;

export const MACHINE_SORT_FIELDS = [
  'asset_tag',
  'name',
  'manufacturer',
  'serial_number',
  'condition',
  'next_service_due_at',
] as const;

export const MACHINE_PAGE_SIZE_DEFAULT = 25;
export const MACHINE_PAGE_SIZE_MAX = 100;

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

const nullableText = (label: string, maximum: number) =>
  z
    .string()
    .superRefine((value, context) => {
      if (CONTROL_CHARACTER.test(value)) {
        context.addIssue({ code: 'custom', message: `${label} cannot contain control characters` });
      }
    })
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(z.string().max(maximum, `${label} must be ${maximum} characters or fewer`))
    .transform((value) => (value === '' ? null : value));

const nullableInteger = (label: string, minimum: number, maximum: number) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(minimum, `${label} must be at least ${minimum}`)
    .max(maximum, `${label} must be at most ${maximum}`)
    .nullable();

const isoDate = (label: string) =>
  z
    .string()
    .regex(ISO_DATE, `${label} must use YYYY-MM-DD`)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
    }, `${label} must be a valid calendar date`);

const isoDateTime = z
  .string()
  .regex(ISO_DATE_TIME_WITH_OFFSET, 'Date-time must be ISO-8601 with Z or an explicit offset')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Date-time must be valid');

const machineFields = {
  allowBookingWhenNeedsService: z.boolean().optional(),
  bufferMinutes: nullableInteger('Buffer time', 1, 1440).optional(),
  categoryId: z.uuid(),
  commissionedOn: isoDate('Commissioned date').nullable().optional(),
  departmentId: z.uuid(),
  description: nullableText('Description', 2000).nullable().optional(),
  isBookable: z.boolean().optional(),
  lastServicedAt: isoDateTime.nullable().optional(),
  locationId: z.uuid(),
  manufacturer: normalizedText('Manufacturer', 120).transform((value) => value.toLowerCase()),
  maxBookingMinutes: nullableInteger('Maximum booking time', 5, 1440).optional(),
  model: normalizedText('Model', 120),
  name: normalizedText('Name', 120),
  purchaseDate: isoDate('Purchase date').nullable().optional(),
  requiresApproval: z.boolean().optional(),
  serialNumber: normalizedText('Serial number', 120).transform((value) => value.toLowerCase()),
  serviceIntervalDays: nullableInteger('Service interval', 1, 3650).optional(),
  warrantyExpiresOn: isoDate('Warranty expiry date').nullable().optional(),
};

const validateCreateDates = (
  value: {
    commissionedOn?: string | null;
    purchaseDate?: string | null;
    warrantyExpiresOn?: string | null;
  },
  context: z.RefinementCtx,
) => {
  const today = new Date().toISOString().slice(0, 10);
  if (
    value.purchaseDate !== undefined &&
    value.purchaseDate !== null &&
    value.purchaseDate > today
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Purchase date cannot be in the future',
      path: ['purchaseDate'],
    });
  }
  if (
    value.purchaseDate !== undefined &&
    value.purchaseDate !== null &&
    value.commissionedOn !== undefined &&
    value.commissionedOn !== null &&
    value.commissionedOn < value.purchaseDate
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Commissioned date cannot precede purchase date',
      path: ['commissionedOn'],
    });
  }
  if (
    value.commissionedOn !== undefined &&
    value.commissionedOn !== null &&
    value.warrantyExpiresOn !== undefined &&
    value.warrantyExpiresOn !== null &&
    value.warrantyExpiresOn < value.commissionedOn
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Warranty expiry cannot precede commissioned date',
      path: ['warrantyExpiresOn'],
    });
  }
};

export const createMachineSchema = z
  .object(machineFields)
  .strict()
  .superRefine(validateCreateDates);

export const updateMachineSchema = z
  .object({
    allowBookingWhenNeedsService: machineFields.allowBookingWhenNeedsService,
    bufferMinutes: machineFields.bufferMinutes,
    categoryId: machineFields.categoryId.optional(),
    commissionedOn: machineFields.commissionedOn,
    departmentId: machineFields.departmentId.optional(),
    description: machineFields.description,
    isBookable: machineFields.isBookable,
    lastServicedAt: machineFields.lastServicedAt,
    locationId: machineFields.locationId.optional(),
    manufacturer: machineFields.manufacturer.optional(),
    maxBookingMinutes: machineFields.maxBookingMinutes,
    model: machineFields.model.optional(),
    name: machineFields.name.optional(),
    purchaseDate: machineFields.purchaseDate,
    requiresApproval: machineFields.requiresApproval,
    serialNumber: machineFields.serialNumber.optional(),
    serviceIntervalDays: machineFields.serviceIntervalDays,
    warrantyExpiresOn: machineFields.warrantyExpiresOn,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listMachinesQuerySchema = z
  .object({
    category_id: z.uuid().optional(),
    condition: z.enum(MACHINE_CONDITIONS).optional(),
    department_id: z.uuid().optional(),
    direction: z.enum(['asc', 'desc']).default('asc'),
    is_bookable: queryBoolean.optional(),
    location_id: z.uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MACHINE_PAGE_SIZE_MAX)
      .default(MACHINE_PAGE_SIZE_DEFAULT),
    search: z.string().trim().min(2).max(100).optional(),
    service_due: queryBoolean.optional(),
    sort: z.enum(MACHINE_SORT_FIELDS).default('asset_tag'),
  })
  .strict();

export const machineIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const machineAssetTagSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.string().regex(/^HM-\d{6,}$/));

export const machineAssetTagParamsSchema = z.object({ assetTag: machineAssetTagSchema }).strict();

export type MachineCondition = (typeof MACHINE_CONDITIONS)[number];
export type MachineSortField = (typeof MACHINE_SORT_FIELDS)[number];
export type CreateMachineInput = z.infer<typeof createMachineSchema>;
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
export type ListMachinesQuery = z.infer<typeof listMachinesQuerySchema>;

export type MachineReference = { id: string; name: string };
export type MachineDepartmentReference = MachineReference & { code: string };

export type ManagedMachine = {
  allowBookingWhenNeedsService: boolean;
  assetTag: string;
  bufferMinutes: number | null;
  category: MachineReference;
  commissionedOn: string | null;
  condition: MachineCondition;
  department: MachineDepartmentReference;
  description: string | null;
  id: string;
  isBookable: boolean;
  lastServicedAt: string | null;
  location: MachineReference;
  manufacturer: string;
  maxBookingMinutes: number | null;
  model: string;
  name: string;
  nextServiceDueAt: string | null;
  purchaseDate: string | null;
  requiresApproval: boolean;
  serialNumber: string;
  serviceIntervalDays: number | null;
  warrantyExpiresOn: string | null;
};

export type ManagedMachinePage = {
  items: readonly ManagedMachine[];
  page: number;
  pageSize: number;
  total: number;
};
