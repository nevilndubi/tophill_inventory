import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
import {
  csvRow,
  MACHINE_IMPORT_HEADERS,
  machineImportCsv,
  protectSpreadsheetCell,
} from '@app/shared';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MachineImportConflictException,
  MachineImportFileChangedException,
  MachineImportInvalidCsvException,
  MachineImportTooLargeException,
  MachineImportTooManyRowsException,
} from './machine-import.errors';
import { MachineImportService, machineImportConstants } from './machine-import.service';

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const DEPARTMENT_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test Admin',
  id: ACTOR_ID,
  isActive: true,
  role: 'ADMIN',
};

const dataRow = (serial = 'SERIAL-001', name = 'Anaesthesia machine'): string[] => [
  name,
  'Critical Care',
  'Acme Medical',
  'Model 5',
  serial,
  'ICU',
  'ICU',
  'Bay A',
  'Portable, calibrated',
  '2025-01-01',
  '2028-01-01',
  '2025-01-02',
  '180',
  '2026-10-01T09:00:00+03:00',
  'true',
  'false',
  'false',
  '240',
  '15',
];

const csv = (...rows: string[][]): string =>
  [csvRow(MACHINE_IMPORT_HEADERS), ...rows.map((row) => csvRow(row))].join('\r\n') + '\r\n';

const requestFor = (content: string | Buffer, contentType = 'text/csv'): Request => {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const stream = Readable.from([bytes]) as unknown as Request;
  stream.headers = {
    'content-length': String(bytes.byteLength),
    'content-type': contentType,
  };
  return stream;
};

const makeMachine = (data: Record<string, unknown>, index: number) => ({
  ...data,
  assetTag: `HM-${String(index + 61).padStart(6, '0')}`,
  condition: 'OPERATIONAL' as const,
  createdAt: new Date('2026-10-27T08:00:00Z'),
  deletedAt: null,
  id: `${String(index + 5).padStart(8, '0')}-5555-4555-8555-555555555555`,
  retiredOn: null,
  updatedAt: new Date('2026-10-27T08:00:00Z'),
});

const harness = () => {
  const tx = {
    auditLog: { create: jest.fn(async () => undefined) },
    machine: {
      createManyAndReturn: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) =>
        data.map(makeMachine),
      ),
    },
    machineStatusHistory: { createMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    department: {
      findMany: jest.fn(async () => [{ code: 'ICU', id: DEPARTMENT_ID, name: 'Intensive Care' }]),
    },
    location: {
      findMany: jest.fn(async () => [
        {
          department: { code: 'ICU', name: 'Intensive Care' },
          id: LOCATION_ID,
          name: 'Bay A',
        },
      ]),
    },
    machine: { findMany: jest.fn(async (): Promise<Record<string, unknown>[]> => []) },
    machineCategory: {
      findMany: jest.fn(async () => [{ id: CATEGORY_ID, name: 'Critical Care' }]),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new MachineImportService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { audit, prisma, service, tx };
};

describe('MachineImportService', () => {
  it('dry-runs quoted CSV with BOM without any writes and uses four batched lookups', async () => {
    const { prisma, service } = harness();
    const report = await service.execute(
      requestFor(`\uFEFF${csv(dataRow())}`),
      actor,
      'dry_run',
      'request-1',
      undefined,
    );
    expect(report.summary).toMatchObject({ create: 1, rejected: 0 });
    expect(report.rows[0]?.preview.description).toBe('Portable, calibrated');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.machineCategory.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.department.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.location.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.machine.findMany).toHaveBeenCalledTimes(1);
  });

  it('commits the same previewed file in chunks with history and both audit levels', async () => {
    const { audit, service, tx } = harness();
    const content = csv(dataRow());
    const preview = await service.execute(
      requestFor(content),
      actor,
      'dry_run',
      'request-2',
      undefined,
    );
    const report = await service.execute(
      requestFor(content),
      actor,
      'commit',
      'request-2',
      preview.file_sha256,
    );
    expect(report.committed_count).toBe(1);
    expect(tx.machine.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: false }),
    );
    expect(tx.machineStatusHistory.createMany).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({ action: 'machine.import_completed' }),
    );
  });

  it('rejects a changed file before any write', async () => {
    const { prisma, service } = harness();
    await expect(
      service.execute(requestFor(csv(dataRow())), actor, 'commit', 'request-3', '0'.repeat(64)),
    ).rejects.toBeInstanceOf(MachineImportFileChangedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks duplicate identities inside a file and does not write during dry run', async () => {
    const { prisma, service } = harness();
    const report = await service.execute(
      requestFor(csv(dataRow(), dataRow(' serial-001 ', 'Another name'))),
      actor,
      'dry_run',
      'request-4',
      undefined,
    );
    expect(report.summary.rejected).toBe(1);
    expect(report.rows[1]?.errors[0]?.code).toBe('IMPORT_DUPLICATE_IDENTITY');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports existing active and soft-deleted identities without updating them', async () => {
    const { prisma, service } = harness();
    prisma.machine.findMany.mockResolvedValueOnce([
      {
        allowBookingWhenNeedsService: false,
        bufferMinutes: 15,
        categoryId: CATEGORY_ID,
        deletedAt: null,
        departmentId: DEPARTMENT_ID,
        description: 'Portable, calibrated',
        id: 'active',
        isBookable: true,
        locationId: LOCATION_ID,
        manufacturer: 'acme medical',
        maxBookingMinutes: 240,
        model: 'Model 5',
        name: 'Anaesthesia machine',
        requiresApproval: false,
        serialNumber: 'serial-001',
        serviceIntervalDays: 180,
      },
      {
        allowBookingWhenNeedsService: false,
        bufferMinutes: 15,
        categoryId: CATEGORY_ID,
        deletedAt: new Date(),
        departmentId: DEPARTMENT_ID,
        description: 'Portable, calibrated',
        id: 'deleted',
        isBookable: true,
        locationId: LOCATION_ID,
        manufacturer: 'acme medical',
        maxBookingMinutes: 240,
        model: 'Model 5',
        name: 'Second',
        requiresApproval: false,
        serialNumber: 'serial-002',
        serviceIntervalDays: 180,
      },
    ]);
    const report = await service.execute(
      requestFor(csv(dataRow(), dataRow('SERIAL-002', 'Second'))),
      actor,
      'dry_run',
      'request-5',
      undefined,
    );
    expect(report.summary.skipped_existing).toBe(1);
    expect(report.summary.skipped_existing_deleted).toBe(1);
  });

  it('uses conflict-safe writes in partial mode and reports the racing row', async () => {
    const { service, tx } = harness();
    const content = csv(dataRow());
    const preview = await service.execute(
      requestFor(content),
      actor,
      'dry_run',
      'request-6',
      undefined,
    );
    tx.machine.createManyAndReturn.mockResolvedValueOnce([]);
    const report = await service.execute(
      requestFor(content),
      actor,
      'partial',
      'request-6',
      preview.file_sha256,
    );
    expect(report.summary.skipped_conflict).toBe(1);
    expect(report.committed_count).toBe(0);
    expect(tx.machine.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('maps a full-import uniqueness race to IMPORT_CONFLICT', async () => {
    const { service, tx } = harness();
    const content = csv(dataRow());
    const preview = await service.execute(
      requestFor(content),
      actor,
      'dry_run',
      'request-7',
      undefined,
    );
    tx.machine.createManyAndReturn.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      service.execute(requestFor(content), actor, 'commit', 'request-7', preview.file_sha256),
    ).rejects.toBeInstanceOf(MachineImportConflictException);
  });

  it('accepts exactly 1,000 rows and rejects 1,001 rows', async () => {
    const { service } = harness();
    const thousand = Array.from({ length: 1_000 }, (_, index) =>
      dataRow(`SERIAL-${String(index).padStart(4, '0')}`),
    );
    await expect(
      service.execute(requestFor(csv(...thousand)), actor, 'dry_run', 'request-8', undefined),
    ).resolves.toMatchObject({ summary: { create: 1_000, rejected: 0 } });
    await expect(
      service.execute(
        requestFor(csv(...thousand, dataRow('SERIAL-1000'))),
        actor,
        'dry_run',
        'request-9',
        undefined,
      ),
    ).rejects.toBeInstanceOf(MachineImportTooManyRowsException);
  });

  it.each([
    ['semicolon', machineImportCsv('template').replaceAll(',', ';')],
    ['tab', machineImportCsv('template').replaceAll(',', '\t')],
    ['unmatched quote', `${csvRow(MACHINE_IMPORT_HEADERS)}\n"unterminated`],
  ])('rejects hostile %s input as invalid CSV', async (_label, content) => {
    const { service } = harness();
    await expect(
      service.execute(requestFor(content), actor, 'dry_run', 'request-10', undefined),
    ).rejects.toBeInstanceOf(MachineImportInvalidCsvException);
  });

  it('rejects announced oversized input before reading it', async () => {
    const { service } = harness();
    const request = requestFor('small');
    request.headers['content-length'] = '1048577';
    await expect(
      service.execute(request, actor, 'dry_run', 'request-11', undefined),
    ).rejects.toBeInstanceOf(MachineImportTooLargeException);
  });
});

describe('machine import CSV spreadsheet protection', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '  =1+1', '\tformula', '\rformula'])(
    'prefixes formula-like value %p',
    (value) => expect(protectSpreadsheetCell(value)).toBe(`'${value}`),
  );

  it('leaves ordinary values unchanged', () => {
    expect(protectSpreadsheetCell('HM-000061')).toBe('HM-000061');
    expect(machineImportConstants).toEqual({ transactionTimeoutMs: 60_000, writeChunkSize: 100 });
  });
});
