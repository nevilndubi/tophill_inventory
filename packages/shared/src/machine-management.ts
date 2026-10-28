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

export const MACHINE_STATUS_SOURCES = ['MANUAL', 'SERVICE_TICKET', 'SCHEDULE', 'SYSTEM'] as const;

export const MACHINE_ALLOWED_TRANSITIONS = {
  OPERATIONAL: ['NEEDS_SERVICE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED'],
  NEEDS_SERVICE: ['OPERATIONAL', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED'],
  UNDER_MAINTENANCE: ['OPERATIONAL', 'OUT_OF_SERVICE', 'RETIRED'],
  OUT_OF_SERVICE: ['UNDER_MAINTENANCE', 'RETIRED'],
  RETIRED: ['UNDER_MAINTENANCE'],
} as const satisfies Record<MachineCondition, readonly MachineCondition[]>;

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
export const MACHINE_REGISTRY_STATES = ['active', 'deleted', 'all'] as const;

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
const includeDeleted = z.literal('true').transform(() => true as const);

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
    registry: z.enum(MACHINE_REGISTRY_STATES).default('active'),
    search: z.string().trim().min(2).max(100).optional(),
    service_due: queryBoolean.optional(),
    sort: z.enum(MACHINE_SORT_FIELDS).default('asset_tag'),
  })
  .strict();

export const machineDetailQuerySchema = z
  .object({ include_deleted: includeDeleted.optional() })
  .strict();

export const machineRegistryMutationSchema = z
  .object({ reason: normalizedText('Reason', 200).optional() })
  .strict()
  .default({});

export const machineIdParamsSchema = z.object({ id: z.uuid() }).strict();

const transitionReason = normalizedText('Reason', 200);

export const machineConditionTransitionSchema = z
  .object({
    force: z.boolean().optional().default(false),
    fromCondition: z.enum(MACHINE_CONDITIONS),
    reason: transitionReason,
    toCondition: z.enum(MACHINE_CONDITIONS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.force && value.reason.length < 10) {
      context.addIssue({
        code: 'custom',
        message: 'A forced safety transition needs a reason of at least 10 characters',
        path: ['reason'],
      });
    }
  });

export const machineHistoryQuerySchema = z
  .object({
    include_deleted: includeDeleted.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const machineAssetTagSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.string().regex(/^HM-\d{6,}$/));

export const machineAssetTagParamsSchema = z.object({ assetTag: machineAssetTagSchema }).strict();

export type MachineCondition = (typeof MACHINE_CONDITIONS)[number];
export type MachineStatusSource = (typeof MACHINE_STATUS_SOURCES)[number];
export type MachineRegistryState = (typeof MACHINE_REGISTRY_STATES)[number];
export type MachineSortField = (typeof MACHINE_SORT_FIELDS)[number];
export type CreateMachineInput = z.infer<typeof createMachineSchema>;
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
export type ListMachinesQuery = z.infer<typeof listMachinesQuerySchema>;
export type MachineDetailQuery = z.infer<typeof machineDetailQuerySchema>;
export type MachineRegistryMutationInput = z.infer<typeof machineRegistryMutationSchema>;
export type MachineConditionTransitionInput = z.infer<typeof machineConditionTransitionSchema>;
export type MachineHistoryQuery = z.infer<typeof machineHistoryQuerySchema>;

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
  registryStatus: 'ACTIVE' | 'DELETED';
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

export type MachineConditionHistoryItem = {
  actor: { fullName: string };
  createdAt: string;
  fromCondition: MachineCondition | null;
  id: string;
  reason: string;
  source: MachineStatusSource;
  toCondition: MachineCondition;
};

export type MachineConditionHistoryPage = {
  items: readonly MachineConditionHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
};

export type MachineConditionTransitionEvent = {
  forced: boolean;
  from: MachineCondition;
  machineId: string;
  requestId: string;
  source: MachineStatusSource;
  timestamp: string;
  to: MachineCondition;
};

export type MachineConditionTransitionResult = {
  condition: MachineCondition;
  machineId: string;
  retiredOn: string | null;
};
