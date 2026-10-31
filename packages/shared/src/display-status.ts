import { z } from 'zod';
import type {
  MachineCondition,
  MachineDepartmentReference,
  MachineReference,
} from './machine-management';
import { isBookableCondition } from './machine-management';

export const DISPLAY_STATUSES = [
  'RETIRED',
  'OUT_OF_SERVICE',
  'UNDER_MAINTENANCE',
  'IN_USE',
  'AVAILABLE_NEEDS_SERVICE',
  'AVAILABLE_OK',
] as const;

export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export const MACHINE_STATUS_STYLE_NAMES = [
  'available',
  'in-use',
  'needs-service',
  'maintenance',
  'out-of-service',
  'retired',
] as const;

export type MachineStatusStyleName = (typeof MACHINE_STATUS_STYLE_NAMES)[number];

export const DISPLAY_STATUS_METADATA = {
  RETIRED: { label: 'Retired', style: 'retired' },
  OUT_OF_SERVICE: { label: 'Out of service', style: 'out-of-service' },
  UNDER_MAINTENANCE: { label: 'Under maintenance', style: 'maintenance' },
  IN_USE: { label: 'In use', style: 'in-use' },
  AVAILABLE_NEEDS_SERVICE: { label: 'Available — needs service', style: 'needs-service' },
  AVAILABLE_OK: { label: 'Available', style: 'available' },
} as const satisfies Record<
  DisplayStatus,
  Readonly<{ label: string; style: MachineStatusStyleName }>
>;

export const DISPLAY_STATUS_PRIORITY = Object.fromEntries(
  DISPLAY_STATUSES.map((status, index) => [status, index + 1]),
) as Record<DisplayStatus, number>;

export const deriveDisplayStatus = (
  condition: MachineCondition,
  hasOpenSession: boolean,
): DisplayStatus => {
  if (condition === 'RETIRED') return 'RETIRED';
  if (condition === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  if (condition === 'UNDER_MAINTENANCE') return 'UNDER_MAINTENANCE';
  if (hasOpenSession) return 'IN_USE';
  if (condition === 'NEEDS_SERVICE') return 'AVAILABLE_NEEDS_SERVICE';
  return 'AVAILABLE_OK';
};

export const isMachineUsable = (input: {
  allowBookingWhenNeedsService: boolean;
  condition: MachineCondition;
  hasOpenSession: boolean;
}): boolean =>
  !input.hasOpenSession && isBookableCondition(input.condition, input.allowBookingWhenNeedsService);

const repeatableDisplayStatus = z.preprocess(
  (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
  z.array(z.enum(DISPLAY_STATUSES)).min(1).optional(),
);

export const STATUS_BOARD_PAGE_SIZE_DEFAULT = 50;
export const STATUS_BOARD_PAGE_SIZE_MAX = 200;
export const STATUS_BOARD_SORT_FIELDS = ['asset_tag', 'name', 'status'] as const;

export const statusBoardQuerySchema = z
  .object({
    category_id: z.uuid().optional(),
    department_id: z.uuid().optional(),
    location_id: z.uuid().optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce
      .number()
      .int()
      .min(1)
      .max(STATUS_BOARD_PAGE_SIZE_MAX)
      .default(STATUS_BOARD_PAGE_SIZE_DEFAULT),
    q: z.string().trim().min(2).max(100).optional(),
    service_due: z
      .literal('true')
      .transform(() => true as const)
      .optional(),
    sort: z.enum(STATUS_BOARD_SORT_FIELDS).default('asset_tag'),
    status: repeatableDisplayStatus,
  })
  .strict();

export type StatusBoardQuery = z.infer<typeof statusBoardQuerySchema>;
export type StatusBoardSortField = (typeof STATUS_BOARD_SORT_FIELDS)[number];

export type MachineOpenSessionStatus = Readonly<{
  expected_end_at: string | null;
  held_by_current_user: boolean;
  holder: Readonly<{ full_name: string; id: string }>;
  id: string;
  overdue: boolean;
  started_at: string;
}>;

export type MachineLiveStatus = Readonly<{
  as_of: string;
  asset_tag: string;
  category: MachineReference;
  department: MachineDepartmentReference;
  display_status: DisplayStatus;
  id: string;
  location: MachineReference;
  name: string;
  next_booking_at: string | null;
  open_session: MachineOpenSessionStatus | null;
  service_due: boolean;
  stored_condition: MachineCondition;
  usable: boolean;
}>;

export type MachineStatusCounts = Readonly<Record<DisplayStatus, number>>;

export type MachineStatusBoard = Readonly<{
  as_of: string;
  counts: MachineStatusCounts;
  items: readonly MachineLiveStatus[];
  page: number;
  page_size: number;
  total: number;
}>;
