import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  createMachineSchema,
  MACHINE_IMPORT_HEADERS,
  MACHINE_IMPORT_MAX_BYTES,
  MACHINE_IMPORT_MAX_CELL_CHARACTERS,
  MACHINE_IMPORT_MAX_ROWS,
  MACHINE_IMPORT_TEMPLATE_VERSION,
  machineImportFileHashSchema,
  type CreateMachineInput,
  type MachineImportHeader,
  type MachineImportIssue,
  type MachineImportMode,
  type MachineImportPreview,
  type MachineImportReport,
  type MachineImportRow,
  type MachineImportSummary,
} from '@app/shared';
import { parse } from 'csv-parse/sync';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { Machine, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MachineImportConflictException,
  MachineImportFileChangedException,
  MachineImportHeadersException,
  MachineImportInvalidCsvException,
  MachineImportInvalidRowsException,
  MachineImportTooLargeException,
  MachineImportTooManyRowsException,
} from './machine-import.errors';

const IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;
const IMPORT_WRITE_CHUNK_SIZE = 100;
const DAY_IN_MILLISECONDS = 86_400_000;
const SCIENTIFIC_NUMBER = /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/iu;
const FORMULA_PREFIX = /^\s*[=+\-@]|^[\t\r]/u;

type ParsedRow = {
  input?: CreateMachineInput;
  row: MachineImportRow;
};

type ReferenceMaps = {
  categories: Map<string, readonly string[]>;
  departments: Map<string, readonly string[]>;
  locations: Map<string, readonly string[]>;
};

type ExistingIdentity = {
  deletedAt: Date | null;
  fields: Record<string, unknown>;
  id: string;
};

const emptySummary = (): MachineImportSummary => ({
  create: 0,
  rejected: 0,
  skipped_conflict: 0,
  skipped_existing: 0,
  skipped_existing_deleted: 0,
});

const normalizeLookup = (value: string): string =>
  value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');

const identityKey = (manufacturer: string, serialNumber: string): string =>
  `${normalizeLookup(manufacturer)}\u0000${normalizeLookup(serialNumber)}`;

const locationKey = (department: string, location: string): string =>
  `${normalizeLookup(department)}\u0000${normalizeLookup(location)}`;

const addMapValue = (map: Map<string, readonly string[]>, key: string, id: string): void => {
  const existing = map.get(key) ?? [];
  if (!existing.includes(id)) map.set(key, [...existing, id]);
};

const nullable = (value: string): string | null => (value.trim() === '' ? null : value);

const optionalInteger = (value: string): number | null =>
  value.trim() === '' ? null : Number(value.trim());

const optionalBoolean = (value: string): boolean | undefined => {
  if (value.trim() === '') return undefined;
  if (value.trim().toLocaleLowerCase('en') === 'true') return true;
  if (value.trim().toLocaleLowerCase('en') === 'false') return false;
  return undefined;
};

const issue = (
  field: MachineImportHeader | 'row',
  code: string,
  message: string,
  value?: string,
): MachineImportIssue => ({
  code,
  field,
  message,
  ...(value === undefined ? {} : { value: value.slice(0, 80) }),
});

const prismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const parseDate = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(`${value}T00:00:00.000Z`);

const parseTimestamp = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

const nextServiceDue = (
  lastServicedAt: Date | null,
  serviceIntervalDays: number | null,
): Date | null =>
  lastServicedAt === null || serviceIntervalDays === null
    ? null
    : new Date(lastServicedAt.getTime() + serviceIntervalDays * DAY_IN_MILLISECONDS);

const inputToData = (input: CreateMachineInput): Prisma.MachineCreateManyInput => {
  const lastServicedAt = parseTimestamp(input.lastServicedAt);
  const serviceIntervalDays = input.serviceIntervalDays ?? null;
  return {
    allowBookingWhenNeedsService: input.allowBookingWhenNeedsService ?? false,
    bufferMinutes: input.bufferMinutes ?? null,
    categoryId: input.categoryId,
    commissionedOn: parseDate(input.commissionedOn),
    departmentId: input.departmentId,
    description: input.description ?? null,
    isBookable: input.isBookable ?? true,
    lastServicedAt,
    locationId: input.locationId,
    manufacturer: input.manufacturer,
    maxBookingMinutes: input.maxBookingMinutes ?? null,
    model: input.model,
    name: input.name,
    nextServiceDueAt: nextServiceDue(lastServicedAt, serviceIntervalDays),
    purchaseDate: parseDate(input.purchaseDate),
    requiresApproval: input.requiresApproval ?? false,
    serialNumber: input.serialNumber,
    serviceIntervalDays,
    warrantyExpiresOn: parseDate(input.warrantyExpiresOn),
  };
};

const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const auditAfter = (machine: Machine): Prisma.InputJsonObject => ({
  allowBookingWhenNeedsService: machine.allowBookingWhenNeedsService,
  assetTag: machine.assetTag,
  bufferMinutes: machine.bufferMinutes,
  categoryId: machine.categoryId,
  commissionedOn: dateOnly(machine.commissionedOn),
  condition: machine.condition,
  departmentId: machine.departmentId,
  description: machine.description,
  isBookable: machine.isBookable,
  lastServicedAt: machine.lastServicedAt?.toISOString() ?? null,
  locationId: machine.locationId,
  manufacturer: machine.manufacturer,
  maxBookingMinutes: machine.maxBookingMinutes,
  model: machine.model,
  name: machine.name,
  nextServiceDueAt: machine.nextServiceDueAt?.toISOString() ?? null,
  purchaseDate: dateOnly(machine.purchaseDate),
  requiresApproval: machine.requiresApproval,
  serialNumber: machine.serialNumber,
  serviceIntervalDays: machine.serviceIntervalDays,
  source: 'import',
  warrantyExpiresOn: dateOnly(machine.warrantyExpiresOn),
});

const differingFields = (existing: ExistingIdentity, input: CreateMachineInput): string[] => {
  const expected = inputToData(input);
  const comparable = [
    'name',
    'categoryId',
    'model',
    'description',
    'departmentId',
    'locationId',
    'isBookable',
    'requiresApproval',
    'allowBookingWhenNeedsService',
    'maxBookingMinutes',
    'bufferMinutes',
    'serviceIntervalDays',
  ] as const;
  return comparable.filter((field) => existing.fields[field] !== expected[field]);
};

@Injectable()
export class MachineImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(
    request: Request,
    actor: AuthenticatedUser,
    mode: MachineImportMode,
    requestId: string,
    expectedHash: string | undefined,
  ): Promise<MachineImportReport> {
    const bytes = await this.readBounded(request);
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    if (mode !== 'dry_run') {
      const parsedHash = machineImportFileHashSchema.safeParse(expectedHash);
      if (!parsedHash.success || parsedHash.data !== fileHash) {
        throw new MachineImportFileChangedException();
      }
    }
    const records = this.parseCsv(bytes);
    const maps = await this.referenceMaps();
    const parsedRows = records.map((cells, index) => this.parseRow(cells, index + 2, maps));
    this.markFileDuplicates(parsedRows);
    await this.markExisting(parsedRows);
    let report = this.report(mode, fileHash, parsedRows, 0);
    if (mode === 'dry_run') return report;
    if (mode === 'commit' && !report.can_commit) throw new MachineImportInvalidRowsException();
    report = await this.commit(actor, mode, requestId, fileHash, parsedRows);
    return report;
  }

  private async readBounded(request: Request): Promise<Buffer> {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/csv' && contentType !== 'application/csv') {
      throw new MachineImportInvalidCsvException('Upload a comma-delimited CSV UTF-8 file');
    }
    const announced = Number(request.headers['content-length']);
    if (Number.isFinite(announced) && announced > MACHINE_IMPORT_MAX_BYTES) {
      throw new MachineImportTooLargeException(MACHINE_IMPORT_MAX_BYTES);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.byteLength;
      if (total > MACHINE_IMPORT_MAX_BYTES) {
        throw new MachineImportTooLargeException(MACHINE_IMPORT_MAX_BYTES);
      }
      chunks.push(bytes);
    }
    if (total === 0) throw new MachineImportInvalidCsvException('The CSV file is empty');
    return Buffer.concat(chunks);
  }

  private parseCsv(bytes: Buffer): string[][] {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      throw new MachineImportInvalidCsvException(
        'Spreadsheet files are not supported; export CSV UTF-8',
      );
    }
    if (bytes.includes(0)) throw new MachineImportInvalidCsvException();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new MachineImportInvalidCsvException(
        'Invalid UTF-8; save the file as CSV UTF-8 (Comma delimited)',
      );
    }
    const firstLine = text.replace(/^\uFEFF/u, '').split(/\r?\n/u, 1)[0] ?? '';
    if (!firstLine.includes(',') && (firstLine.includes(';') || firstLine.includes('\t'))) {
      throw new MachineImportInvalidCsvException(
        firstLine.includes('\t')
          ? 'Tab-delimited files are not supported; use CSV UTF-8 (Comma delimited)'
          : 'Semicolon-delimited files are not supported; use CSV UTF-8 (Comma delimited)',
      );
    }
    let rows: string[][];
    try {
      rows = parse(text, {
        bom: true,
        delimiter: ',',
        max_record_size: MACHINE_IMPORT_HEADERS.length * (MACHINE_IMPORT_MAX_CELL_CHARACTERS + 8),
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][];
    } catch {
      throw new MachineImportInvalidCsvException(
        'The CSV structure is malformed or has unmatched quotes',
      );
    }
    const header = rows.shift();
    if (header === undefined)
      throw new MachineImportInvalidCsvException('The CSV header row is missing');
    this.validateHeaders(header);
    if (rows.length > MACHINE_IMPORT_MAX_ROWS) {
      throw new MachineImportTooManyRowsException(MACHINE_IMPORT_MAX_ROWS);
    }
    const headerOrder = MACHINE_IMPORT_HEADERS.map((expected) =>
      header.findIndex((value) => value.trim().toLocaleLowerCase('en') === expected),
    );
    for (const row of rows) {
      if (row.length > header.length) {
        throw new MachineImportInvalidCsvException('A row contains more cells than the header');
      }
      if (row.some((cell) => cell.length > MACHINE_IMPORT_MAX_CELL_CHARACTERS)) {
        throw new MachineImportInvalidCsvException(
          `Each CSV cell must be ${MACHINE_IMPORT_MAX_CELL_CHARACTERS} characters or fewer`,
        );
      }
      while (row.length < header.length) row.push('');
    }
    return rows.map((row) => headerOrder.map((index) => row[index] ?? ''));
  }

  private validateHeaders(headers: readonly string[]): void {
    const normalized = headers.map((header) => header.trim().toLocaleLowerCase('en'));
    if (new Set(normalized).size !== normalized.length) {
      throw new MachineImportHeadersException(
        'IMPORT_DUPLICATE_HEADERS',
        'The CSV contains duplicate headers',
      );
    }
    if (
      normalized.length !== MACHINE_IMPORT_HEADERS.length ||
      normalized.some((header) => !MACHINE_IMPORT_HEADERS.includes(header as MachineImportHeader))
    ) {
      throw new MachineImportHeadersException(
        'IMPORT_INVALID_HEADERS',
        'Use the current versioned template with the required headers',
      );
    }
  }

  private async referenceMaps(): Promise<ReferenceMaps> {
    const [categories, departments, locations] = await Promise.all([
      this.prisma.machineCategory.findMany({ select: { id: true, name: true } }),
      this.prisma.department.findMany({ select: { code: true, id: true, name: true } }),
      this.prisma.location.findMany({
        select: { department: { select: { code: true, name: true } }, id: true, name: true },
      }),
    ]);
    const maps: ReferenceMaps = {
      categories: new Map(),
      departments: new Map(),
      locations: new Map(),
    };
    for (const category of categories)
      addMapValue(maps.categories, normalizeLookup(category.name), category.id);
    for (const department of departments) {
      addMapValue(maps.departments, normalizeLookup(department.name), department.id);
      addMapValue(maps.departments, normalizeLookup(department.code), department.id);
    }
    for (const location of locations) {
      addMapValue(
        maps.locations,
        locationKey(location.department.name, location.name),
        location.id,
      );
      addMapValue(
        maps.locations,
        locationKey(location.department.code, location.name),
        location.id,
      );
    }
    return maps;
  }

  private parseRow(cells: readonly string[], rowNumber: number, maps: ReferenceMaps): ParsedRow {
    const raw = Object.fromEntries(
      MACHINE_IMPORT_HEADERS.map((header, index) => [header, cells[index] ?? '']),
    ) as Record<MachineImportHeader, string>;
    const errors: MachineImportIssue[] = [];
    const warnings: MachineImportIssue[] = [];
    for (const header of MACHINE_IMPORT_HEADERS) {
      if (FORMULA_PREFIX.test(raw[header])) {
        warnings.push(
          issue(header, 'FORMULA_LIKE_VALUE', 'Spreadsheet formula-like value detected'),
        );
      }
    }
    if (SCIENTIFIC_NUMBER.test(raw.serial_number.trim())) {
      warnings.push(
        issue(
          'serial_number',
          'SCIENTIFIC_NOTATION',
          'Serial number resembles scientific notation; format the Excel column as Text',
        ),
      );
    }
    for (const field of [
      'is_bookable',
      'requires_approval',
      'allow_booking_when_needs_service',
    ] as const) {
      const value = raw[field].trim().toLocaleLowerCase('en');
      if (value !== '' && value !== 'true' && value !== 'false') {
        errors.push(issue(field, 'IMPORT_FIELD_INVALID', `${field} must be true, false, or blank`));
      }
    }
    const resolve = (
      map: Map<string, readonly string[]>,
      value: string,
      field: MachineImportHeader,
      missingCode: string,
    ): string => {
      const matches = map.get(normalizeLookup(value)) ?? [];
      if (matches.length === 0)
        errors.push(issue(field, missingCode, `${field} could not be resolved`));
      if (matches.length > 1)
        errors.push(issue(field, 'IMPORT_REFERENCE_AMBIGUOUS', `${field} is ambiguous`));
      return matches[0] ?? '00000000-0000-0000-0000-000000000000';
    };
    const inputCandidate = {
      allowBookingWhenNeedsService: optionalBoolean(raw.allow_booking_when_needs_service),
      bufferMinutes: optionalInteger(raw.buffer_minutes),
      categoryId: resolve(maps.categories, raw.category, 'category', 'IMPORT_CATEGORY_NOT_FOUND'),
      commissionedOn: nullable(raw.commissioned_on),
      departmentId: resolve(
        maps.departments,
        raw.department,
        'department',
        'IMPORT_DEPARTMENT_NOT_FOUND',
      ),
      description: nullable(raw.description),
      isBookable: optionalBoolean(raw.is_bookable),
      lastServicedAt: nullable(raw.last_serviced_at),
      locationId: resolve(
        maps.locations,
        `${raw.location_department}\u0000${raw.location}`,
        'location',
        'IMPORT_LOCATION_NOT_FOUND',
      ),
      manufacturer: raw.manufacturer,
      maxBookingMinutes: optionalInteger(raw.max_booking_minutes),
      model: raw.model,
      name: raw.name,
      purchaseDate: nullable(raw.purchase_date),
      requiresApproval: optionalBoolean(raw.requires_approval),
      serialNumber: raw.serial_number,
      serviceIntervalDays: optionalInteger(raw.service_interval_days),
      warrantyExpiresOn: nullable(raw.warranty_expires_on),
    };
    // Preserve database defaults when optional CSV booleans are blank.
    for (const key of ['allowBookingWhenNeedsService', 'isBookable', 'requiresApproval'] as const) {
      if (inputCandidate[key] === undefined) delete inputCandidate[key];
    }
    const validated = createMachineSchema.safeParse(inputCandidate);
    if (!validated.success) {
      for (const zodIssue of validated.error.issues) {
        const camelField = String(zodIssue.path[0] ?? 'row');
        const field =
          (
            {
              allowBookingWhenNeedsService: 'allow_booking_when_needs_service',
              bufferMinutes: 'buffer_minutes',
              categoryId: 'category',
              commissionedOn: 'commissioned_on',
              departmentId: 'department',
              isBookable: 'is_bookable',
              lastServicedAt: 'last_serviced_at',
              locationId: 'location',
              maxBookingMinutes: 'max_booking_minutes',
              purchaseDate: 'purchase_date',
              requiresApproval: 'requires_approval',
              serialNumber: 'serial_number',
              serviceIntervalDays: 'service_interval_days',
              warrantyExpiresOn: 'warranty_expires_on',
            } as Record<string, MachineImportHeader>
          )[camelField] ??
          (MACHINE_IMPORT_HEADERS.includes(camelField as MachineImportHeader)
            ? (camelField as MachineImportHeader)
            : 'row');
        errors.push(issue(field, 'IMPORT_FIELD_INVALID', zodIssue.message));
      }
    }
    const preview: MachineImportPreview = {
      ...raw,
      ...(validated.success
        ? {
            manufacturer: validated.data.manufacturer,
            serial_number: validated.data.serialNumber,
            name: validated.data.name,
          }
        : {}),
    };
    return {
      ...(validated.success ? { input: validated.data } : {}),
      row: {
        errors,
        preview,
        row: rowNumber,
        status: errors.length === 0 ? 'create' : 'rejected',
        warnings,
      },
    };
  }

  private markFileDuplicates(rows: ParsedRow[]): void {
    const seen = new Map<string, ParsedRow>();
    for (const parsed of rows) {
      if (parsed.input === undefined) continue;
      const key = identityKey(parsed.input.manufacturer, parsed.input.serialNumber);
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, parsed);
        continue;
      }
      const duplicate = issue(
        'serial_number',
        'IMPORT_DUPLICATE_IDENTITY',
        `Duplicate machine identity in file; first appears on row ${first.row.row}`,
      );
      parsed.row = { ...parsed.row, errors: [...parsed.row.errors, duplicate], status: 'rejected' };
    }
  }

  private async markExisting(rows: ParsedRow[]): Promise<void> {
    const candidates = rows.flatMap((row) => (row.input === undefined ? [] : [row.input]));
    if (candidates.length === 0) return;
    const existingRows = await this.prisma.machine.findMany({
      select: {
        allowBookingWhenNeedsService: true,
        bufferMinutes: true,
        categoryId: true,
        deletedAt: true,
        departmentId: true,
        description: true,
        id: true,
        isBookable: true,
        locationId: true,
        manufacturer: true,
        maxBookingMinutes: true,
        model: true,
        name: true,
        requiresApproval: true,
        serialNumber: true,
        serviceIntervalDays: true,
      },
      where: {
        OR: candidates.map((input) => ({
          manufacturer: { equals: input.manufacturer, mode: 'insensitive' },
          serialNumber: { equals: input.serialNumber, mode: 'insensitive' },
        })),
      },
    });
    const existing = new Map<string, ExistingIdentity>();
    for (const machine of existingRows) {
      existing.set(identityKey(machine.manufacturer, machine.serialNumber), {
        deletedAt: machine.deletedAt,
        fields: machine,
        id: machine.id,
      });
    }
    for (const parsed of rows) {
      if (parsed.input === undefined || parsed.row.status === 'rejected') continue;
      const match = existing.get(identityKey(parsed.input.manufacturer, parsed.input.serialNumber));
      if (match === undefined) continue;
      const changed = differingFields(match, parsed.input);
      parsed.row = {
        ...parsed.row,
        status: match.deletedAt === null ? 'skipped_existing' : 'skipped_existing_deleted',
        warnings: [
          ...parsed.row.warnings,
          ...(changed.length === 0
            ? []
            : [
                issue(
                  'row',
                  'IMPORT_EXISTING_DIFFERS',
                  `Existing machine differs in fields: ${changed.join(', ')}`,
                ),
              ]),
          ...(match.deletedAt === null
            ? []
            : [issue('row', 'IMPORT_MACHINE_DELETED', 'Restore is available in Task 3.8')]),
        ],
      };
    }
  }

  private report(
    mode: MachineImportMode,
    hash: string,
    rows: readonly ParsedRow[],
    committedCount: number,
  ): MachineImportReport {
    const summary = emptySummary();
    for (const row of rows) summary[row.row.status] += 1;
    return {
      can_commit: summary.rejected === 0,
      committed_count: committedCount,
      file_sha256: hash,
      mode,
      rows: rows.map((row) => row.row),
      summary,
      template_version: MACHINE_IMPORT_TEMPLATE_VERSION,
    };
  }

  private async commit(
    actor: AuthenticatedUser,
    mode: Exclude<MachineImportMode, 'dry_run'>,
    requestId: string,
    hash: string,
    rows: ParsedRow[],
  ): Promise<MachineImportReport> {
    const creatable = rows.filter(
      (row): row is ParsedRow & { input: CreateMachineInput } =>
        row.input !== undefined && row.row.status === 'create',
    );
    try {
      const created = await this.prisma.$transaction(
        async (transaction) => {
          const machines: Machine[] = [];
          for (let start = 0; start < creatable.length; start += IMPORT_WRITE_CHUNK_SIZE) {
            const chunk = creatable.slice(start, start + IMPORT_WRITE_CHUNK_SIZE);
            const inserted = await transaction.machine.createManyAndReturn({
              data: chunk.map((row) => inputToData(row.input)),
              skipDuplicates: mode === 'partial',
            });
            machines.push(...inserted);
            const insertedKeys = new Set(
              inserted.map((machine) => identityKey(machine.manufacturer, machine.serialNumber)),
            );
            if (mode === 'partial') {
              for (const row of chunk) {
                if (
                  !insertedKeys.has(identityKey(row.input.manufacturer, row.input.serialNumber))
                ) {
                  row.row = { ...row.row, status: 'skipped_conflict' };
                }
              }
            } else if (inserted.length !== chunk.length) {
              throw new MachineImportConflictException();
            }
          }
          if (machines.length > 0) {
            await transaction.machineStatusHistory.createMany({
              data: machines.map((machine) => ({
                changedByUserId: actor.id,
                fromCondition: null,
                machineId: machine.id,
                reason: 'Machine registered',
                source: 'SYSTEM',
                toCondition: 'OPERATIONAL',
              })),
            });
            for (const machine of machines) {
              await this.audit.record(transaction, {
                action: 'machine.created',
                actorUserId: actor.id,
                after: auditAfter(machine),
                entityId: machine.id,
                entityType: 'machine',
                requestId,
              });
            }
          }
          await this.audit.record(transaction, {
            action: 'machine.import_completed',
            actorUserId: actor.id,
            after: {
              committedCount: machines.length,
              mode,
              rejectedCount: rows.filter((row) => row.row.status === 'rejected').length,
              requestId,
              skippedConflictCount: rows.filter((row) => row.row.status === 'skipped_conflict')
                .length,
              skippedExistingCount: rows.filter((row) =>
                ['skipped_existing', 'skipped_existing_deleted'].includes(row.row.status),
              ).length,
            },
            entityId: requestId,
            entityType: 'machine_import',
            requestId,
          });
          return machines;
        },
        { maxWait: 10_000, timeout: IMPORT_TRANSACTION_TIMEOUT_MS },
      );
      return this.report(mode, hash, rows, created.length);
    } catch (error: unknown) {
      if (error instanceof MachineImportConflictException) throw error;
      if (prismaError(error, 'P2002')) throw new MachineImportConflictException();
      throw error;
    }
  }
}

export const machineImportConstants = {
  transactionTimeoutMs: IMPORT_TRANSACTION_TIMEOUT_MS,
  writeChunkSize: IMPORT_WRITE_CHUNK_SIZE,
} as const;
