import { z } from 'zod';

export const MACHINE_IMPORT_TEMPLATE_VERSION = 'v1' as const;
export const MACHINE_IMPORT_MAX_BYTES = 1_048_576;
export const MACHINE_IMPORT_MAX_ROWS = 1_000;
export const MACHINE_IMPORT_MAX_CELL_CHARACTERS = 500;

export const MACHINE_IMPORT_HEADERS = [
  'name',
  'category',
  'manufacturer',
  'model',
  'serial_number',
  'department',
  'location_department',
  'location',
  'description',
  'purchase_date',
  'warranty_expires_on',
  'commissioned_on',
  'service_interval_days',
  'last_serviced_at',
  'is_bookable',
  'requires_approval',
  'allow_booking_when_needs_service',
  'max_booking_minutes',
  'buffer_minutes',
] as const;

export const MACHINE_IMPORT_MODES = ['dry_run', 'commit', 'partial'] as const;
export const MACHINE_IMPORT_ROW_STATUSES = [
  'create',
  'skipped_existing',
  'skipped_existing_deleted',
  'skipped_conflict',
  'rejected',
] as const;

export const machineImportQuerySchema = z
  .object({ mode: z.enum(MACHINE_IMPORT_MODES).default('dry_run') })
  .strict();

export const machineImportFileHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected file hash must be a lowercase SHA-256 value');

export type MachineImportHeader = (typeof MACHINE_IMPORT_HEADERS)[number];
export type MachineImportMode = (typeof MACHINE_IMPORT_MODES)[number];
export type MachineImportRowStatus = (typeof MACHINE_IMPORT_ROW_STATUSES)[number];

export type MachineImportIssue = {
  code: string;
  field: MachineImportHeader | 'row';
  message: string;
  value?: string;
};

export type MachineImportPreview = Partial<
  Record<MachineImportHeader, boolean | number | string | null>
>;

export type MachineImportRow = {
  errors: readonly MachineImportIssue[];
  preview: MachineImportPreview;
  row: number;
  status: MachineImportRowStatus;
  warnings: readonly MachineImportIssue[];
};

export type MachineImportSummary = Record<MachineImportRowStatus, number>;

export type MachineImportReport = {
  can_commit: boolean;
  committed_count: number;
  file_sha256: string;
  mode: MachineImportMode;
  rows: readonly MachineImportRow[];
  summary: MachineImportSummary;
  template_version: typeof MACHINE_IMPORT_TEMPLATE_VERSION;
};

const formulaLike = (value: string): boolean => {
  const leadingWhitespace = value.match(/^\s*/u)?.[0] ?? '';
  return (
    leadingWhitespace.includes('\t') ||
    leadingWhitespace.includes('\r') ||
    /^[=+\-@]/u.test(value.slice(leadingWhitespace.length))
  );
};

export const protectSpreadsheetCell = (value: string): string =>
  formulaLike(value) ? `'${value}` : value;

export const csvCell = (value: string): string => {
  const protectedValue = protectSpreadsheetCell(value);
  return /[",\r\n]/u.test(protectedValue)
    ? `"${protectedValue.replaceAll('"', '""')}"`
    : protectedValue;
};

export const csvRow = (values: readonly string[]): string => values.map(csvCell).join(',');

const EXAMPLE_ROWS: readonly (readonly string[])[] = [
  [
    'Portable ultrasound',
    'Ultrasound',
    'Acme Medical',
    'Echo 4',
    'EXAMPLE-001',
    'Radiology',
    'Radiology',
    'Ultrasound Room',
    'Demo row — do not import',
    '2025-01-15',
    '2028-01-15',
    '2025-01-20',
    '180',
    '2026-09-15T09:00:00+03:00',
    'true',
    'false',
    'false',
    '240',
    '15',
  ],
  [
    'Patient monitor',
    'Patient Monitors',
    'Acme Medical',
    'Watch 12',
    'EXAMPLE-002',
    'ICU',
    'ICU',
    'ICU Bay 1',
    'Demo row — do not import',
    '',
    '',
    '',
    '',
    '',
    'true',
    'true',
    'false',
    '',
    '',
  ],
  [
    'Infusion pump',
    'Infusion Pumps',
    'Acme Medical',
    'Flow 8',
    'EXAMPLE-003',
    'Maternity',
    'Maternity',
    'Labour Ward',
    'Demo row — do not import',
    '2024-06-01',
    '',
    '2024-06-10',
    '365',
    '',
    'true',
    'false',
    'true',
    '180',
    '10',
  ],
] as const;

export const machineImportCsv = (kind: 'example' | 'template'): string =>
  [
    csvRow(MACHINE_IMPORT_HEADERS),
    ...(kind === 'example' ? EXAMPLE_ROWS.map((row) => csvRow(row)) : []),
  ].join('\r\n') + '\r\n';
