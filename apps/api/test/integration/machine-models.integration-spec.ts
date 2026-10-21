import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type QueryResultRow } from 'pg';
import {
  MachineCondition,
  MachineStatusSource,
  Prisma,
  PrismaClient,
  Role,
} from '../../src/generated/prisma/client';
import { assertSafeIntegrationDatabaseEnvironment } from './database-guard';

type PostgresError = Error & { code?: string; constraint?: string };
type PlanNode = {
  'Index Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
};
type ExplainRow = QueryResultRow & { 'QUERY PLAN': Array<{ Plan: PlanNode }> };

const expectPostgresError = async (
  operation: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    const databaseError = error as PostgresError;
    expect(databaseError.code).toBe(code);
    if (constraint) {
      expect(databaseError.constraint).toBe(constraint);
    }
    return;
  }

  throw new Error(`Expected PostgreSQL error ${code}`);
};

const collectIndexNames = (node: PlanNode): string[] => [
  ...(node['Index Name'] ? [node['Index Name']] : []),
  ...(node.Plans ?? []).flatMap(collectIndexNames),
];

const pauseForTimestampPrecision = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('Machine database integration', () => {
  const integration = assertSafeIntegrationDatabaseEnvironment(process.env);
  const runId = `t13-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: integration.url, max: 8 }),
  });
  const sql = new Pool({ connectionString: integration.url, max: 4 });

  let actorUserId = '';
  let categoryId = '';
  let owningDepartmentId = '';
  let sharedDepartmentId = '';
  let sharedLocationId = '';

  const machineData = (
    suffix: string,
    overrides: Partial<Prisma.MachineUncheckedCreateInput> = {},
  ): Prisma.MachineUncheckedCreateInput => ({
    categoryId,
    departmentId: owningDepartmentId,
    description: `${runId} fixture ${suffix}`,
    locationId: sharedLocationId,
    manufacturer: `${runId} manufacturer ${suffix}`,
    model: `Model ${suffix}`,
    name: `${runId} Machine ${suffix}`,
    serialNumber: `${runId}-serial-${suffix}`,
    ...overrides,
  });

  const createMachine = async (
    suffix: string,
    overrides: Partial<Prisma.MachineUncheckedCreateInput> = {},
  ) => prisma.machine.create({ data: machineData(suffix, overrides) });

  const explainIndexNames = async (column: string, pattern: string): Promise<string[]> => {
    const allowedColumns = new Set(['asset_tag', 'name', 'serial_number']);
    if (!allowedColumns.has(column)) {
      throw new Error(`Unsupported EXPLAIN column ${column}`);
    }

    const result = await sql.query<ExplainRow>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT id FROM machines WHERE "${column}" ILIKE $1`,
      [pattern],
    );
    const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
    if (!plan) {
      throw new Error(`PostgreSQL returned no EXPLAIN plan for ${column}`);
    }

    return collectIndexNames(plan);
  };

  beforeAll(async () => {
    await prisma.$connect();

    const owningDepartment = await prisma.department.create({
      data: { code: `${runId}-own`, name: `${runId} Owning Department` },
    });
    const sharedDepartment = await prisma.department.create({
      data: { code: `${runId}-shared`, name: `${runId} Shared Department` },
    });
    const sharedLocation = await prisma.location.create({
      data: {
        departmentId: sharedDepartment.id,
        name: `${runId} Shared Equipment Bay`,
      },
    });
    const actor = await prisma.user.create({
      data: {
        email: `${runId}-actor@example.com`,
        fullName: 'Task 1.3 Actor',
        role: Role.BIOMED_TECH,
        supabaseUserId: randomUUID(),
      },
    });
    const category = await prisma.machineCategory.create({
      data: {
        defaultMaxBookingMinutes: 120,
        defaultServiceIntervalDays: 180,
        description: `${runId} category`,
        name: `${runId} Imaging`,
      },
    });

    actorUserId = actor.id;
    categoryId = category.id;
    owningDepartmentId = owningDepartment.id;
    sharedDepartmentId = sharedDepartment.id;
    sharedLocationId = sharedLocation.id;
  });

  afterAll(async () => {
    try {
      await prisma.machineStatusHistory.deleteMany({
        where: { machine: { description: { startsWith: runId } } },
      });
      await prisma.machine.deleteMany({
        where: { description: { startsWith: runId } },
      });
      await prisma.location.deleteMany({
        where: { name: { startsWith: runId } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: runId } },
      });
      await prisma.department.deleteMany({
        where: { code: { startsWith: runId } },
      });
      await prisma.machineCategory.deleteMany({
        where: { name: { startsWith: runId } },
      });
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });

  it('inserts and reads the full model while allowing a shared cross-department location', async () => {
    const machine = await createMachine('full-model', {
      allowBookingWhenNeedsService: true,
      bufferMinutes: 15,
      commissionedOn: new Date('2025-02-01T00:00:00.000Z'),
      condition: MachineCondition.NEEDS_SERVICE,
      isBookable: true,
      lastServicedAt: new Date('2026-01-15T08:00:00.000Z'),
      maxBookingMinutes: 90,
      nextServiceDueAt: new Date('2026-07-15T08:00:00.000Z'),
      purchaseDate: new Date('2025-01-15T00:00:00.000Z'),
      requiresApproval: true,
      serviceIntervalDays: 180,
      warrantyExpiresOn: new Date('2027-02-01T00:00:00.000Z'),
    });

    const stored = await prisma.machine.findUniqueOrThrow({
      include: { category: true, department: true, location: true },
      where: { id: machine.id },
    });

    expect(stored.category.id).toBe(categoryId);
    expect(stored.department.id).toBe(owningDepartmentId);
    expect(stored.location.id).toBe(sharedLocationId);
    expect(stored.location.departmentId).toBe(sharedDepartmentId);
    expect(stored.condition).toBe(MachineCondition.NEEDS_SERVICE);
    expect(stored.assetTag).toMatch(/^HM-\d{6,}$/);
    expect(Object.hasOwn(stored, 'isInUse')).toBe(false);

    const previousUpdatedAt = stored.updatedAt;
    await pauseForTimestampPrecision();
    const updated = await prisma.machine.update({
      data: { name: `${stored.name} updated` },
      where: { id: stored.id },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(previousUpdatedAt.getTime());
  });

  it('normalizes required serial identity and reserves it across soft deletion', async () => {
    const serial = `${runId}-SN-001`;
    const machine = await createMachine('identity', {
      manufacturer: '  ACME MEDICAL  ',
      serialNumber: `  ${serial.toUpperCase()}  `,
    });

    expect(machine.manufacturer).toBe('acme medical');
    expect(machine.serialNumber).toBe(serial.toLowerCase());

    const sameSerialElsewhere = await createMachine('identity-other-manufacturer', {
      manufacturer: 'Other Manufacturer',
      serialNumber: serial,
    });
    expect(sameSerialElsewhere.id).not.toBe(machine.id);

    await prisma.machine.update({
      data: { deletedAt: new Date() },
      where: { id: machine.id },
    });
    await expectPostgresError(
      sql.query(
        `INSERT INTO machines
          (name, category_id, manufacturer, model, serial_number, description, department_id, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `${runId} duplicate serial`,
          categoryId,
          'acme medical',
          'Duplicate Model',
          serial.toLowerCase(),
          `${runId} duplicate serial`,
          owningDepartmentId,
          sharedLocationId,
        ],
      ),
      '23505',
      'machines_manufacturer_serial_number_lower_key',
    );

    const requiredIdentityInsert = (manufacturer: string | null, serialNumber: string | null) =>
      sql.query(
        `INSERT INTO machines
          (name, category_id, manufacturer, model, serial_number, description, department_id, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `${runId} null identity`,
          categoryId,
          manufacturer,
          'Null Test',
          serialNumber,
          `${runId} null identity`,
          owningDepartmentId,
          sharedLocationId,
        ],
      );

    await expectPostgresError(requiredIdentityInsert(null, `${runId}-serial-null-maker`), '23502');
    await expectPostgresError(requiredIdentityInsert('null-serial-maker', null), '23502');
    await expectPostgresError(
      requiredIdentityInsert('   ', `${runId}-blank-maker`),
      '23514',
      'machines_manufacturer_not_blank_check',
    );
  });

  it('generates unique formatted asset tags under parallel inserts and never reuses a tag', async () => {
    const machines = await Promise.all(
      Array.from({ length: 40 }, (_value, index) => createMachine(`parallel-${index}`)),
    );
    const tags = machines.map((machine) => machine.assetTag);

    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.every((tag) => /^HM-\d{6,}$/.test(tag))).toBe(true);

    const reserved = machines[0];
    if (!reserved) {
      throw new Error('Parallel insert proof did not create a machine');
    }
    await prisma.machine.update({
      data: { deletedAt: new Date() },
      where: { id: reserved.id },
    });
    await expectPostgresError(
      sql.query(
        `INSERT INTO machines
          (asset_tag, name, category_id, manufacturer, model, serial_number, description, department_id, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          reserved.assetTag,
          `${runId} duplicate tag`,
          categoryId,
          `${runId} tag maker`,
          'Duplicate Tag',
          `${runId}-duplicate-tag`,
          `${runId} duplicate tag`,
          owningDepartmentId,
          sharedLocationId,
        ],
      ),
      '23505',
      'machines_asset_tag_key',
    );
  });

  it('enforces positive category defaults and machine interval and booking-minute overrides', async () => {
    await expectPostgresError(
      sql.query('UPDATE machine_categories SET default_service_interval_days = 0 WHERE id = $1', [
        categoryId,
      ]),
      '23514',
      'machine_categories_default_service_interval_days_positive_check',
    );
    await expectPostgresError(
      sql.query('UPDATE machine_categories SET default_max_booking_minutes = 0 WHERE id = $1', [
        categoryId,
      ]),
      '23514',
      'machine_categories_default_max_booking_minutes_positive_check',
    );

    const machine = await createMachine('positive-checks');
    const machineChecks = [
      ['max_booking_minutes', 'machines_max_booking_minutes_positive_check'],
      ['buffer_minutes', 'machines_buffer_minutes_positive_check'],
      ['service_interval_days', 'machines_service_interval_days_positive_check'],
    ] as const;

    for (const [column, constraint] of machineChecks) {
      await expectPostgresError(
        sql.query(`UPDATE machines SET "${column}" = 0 WHERE id = $1`, [machine.id]),
        '23514',
        constraint,
      );
    }
  });

  it('enforces retirement, date-order, and enum invariants', async () => {
    const retirementMachine = await createMachine('retirement-check');
    await expectPostgresError(
      sql.query("UPDATE machines SET condition = 'RETIRED' WHERE id = $1", [retirementMachine.id]),
      '23514',
      'machines_retirement_consistency_check',
    );
    await expectPostgresError(
      sql.query("UPDATE machines SET retired_on = DATE '2026-10-21' WHERE id = $1", [
        retirementMachine.id,
      ]),
      '23514',
      'machines_retirement_consistency_check',
    );
    await sql.query(
      "UPDATE machines SET condition = 'RETIRED', retired_on = DATE '2026-10-21' WHERE id = $1",
      [retirementMachine.id],
    );

    const warrantyMachine = await createMachine('warranty-check');
    await expectPostgresError(
      sql.query(
        `UPDATE machines
         SET commissioned_on = DATE '2026-06-01', warranty_expires_on = DATE '2026-05-31'
         WHERE id = $1`,
        [warrantyMachine.id],
      ),
      '23514',
      'machines_warranty_after_commission_check',
    );
    await sql.query(
      `UPDATE machines
       SET commissioned_on = DATE '2026-06-01', warranty_expires_on = DATE '2027-06-01'
       WHERE id = $1`,
      [warrantyMachine.id],
    );

    await expectPostgresError(
      sql.query("UPDATE machines SET condition = 'NOT_A_CONDITION' WHERE id = $1", [
        warrantyMachine.id,
      ]),
      '22P02',
    );

    const enumValues = await sql.query<{ enumlabel: string; typname: string }>(
      `SELECT enum_type.typname, enum_value.enumlabel
       FROM pg_type AS enum_type
       JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
       WHERE enum_type.typname IN ('machine_condition', 'machine_status_source')
       ORDER BY enum_type.typname, enum_value.enumsortorder`,
    );
    expect(
      enumValues.rows
        .filter((row) => row.typname === 'machine_condition')
        .map((row) => row.enumlabel),
    ).toEqual(['OPERATIONAL', 'NEEDS_SERVICE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED']);
    expect(
      enumValues.rows
        .filter((row) => row.typname === 'machine_status_source')
        .map((row) => row.enumlabel),
    ).toEqual(['MANUAL', 'SERVICE_TICKET', 'SCHEDULE', 'SYSTEM']);
  });

  it('stores append-only history fields and restricts referenced machine and user deletion', async () => {
    const machine = await createMachine('history');
    const ticketId = randomUUID();
    const history = await prisma.machineStatusHistory.create({
      data: {
        changedByUserId: actorUserId,
        fromCondition: null,
        machineId: machine.id,
        reason: 'Initial status record',
        source: MachineStatusSource.MANUAL,
        ticketId,
        toCondition: MachineCondition.OPERATIONAL,
      },
    });

    const stored = await prisma.machineStatusHistory.findUniqueOrThrow({
      include: { changedByUser: true, machine: true },
      where: { id: history.id },
    });
    expect(stored.fromCondition).toBeNull();
    expect(stored.ticketId).toBe(ticketId);
    expect(stored.changedByUser.id).toBe(actorUserId);
    expect(stored.machine.id).toBe(machine.id);

    await expectPostgresError(
      sql.query('DELETE FROM machines WHERE id = $1', [machine.id]),
      '23001',
      'machine_status_history_machine_id_fkey',
    );
    await expectPostgresError(
      sql.query('DELETE FROM users WHERE id = $1', [actorUserId]),
      '23001',
      'machine_status_history_changed_by_user_id_fkey',
    );
    await expectPostgresError(
      sql.query(
        `INSERT INTO machine_status_history
          (machine_id, from_condition, to_condition, reason, changed_by_user_id, source)
         VALUES ($1, NULL, 'OPERATIONAL', $2, $3, 'NOT_A_SOURCE')`,
        [machine.id, 'Invalid source', actorUserId],
      ),
      '22P02',
    );

    const ticketForeignKey = await sql.query<{ has_ticket_foreign_key: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS table_record ON table_record.oid = constraint_record.conrelid
         JOIN pg_attribute AS column_record
           ON column_record.attrelid = table_record.oid
          AND column_record.attnum = ANY(constraint_record.conkey)
         WHERE table_record.relname = 'machine_status_history'
           AND constraint_record.contype = 'f'
           AND column_record.attname = 'ticket_id'
       ) AS has_ticket_foreign_key`,
    );
    expect(ticketForeignKey.rows[0]?.has_ticket_foreign_key).toBe(false);

    const historyIndex = await sql.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'machine_status_history_machine_id_created_at_idx'`,
    );
    expect(historyIndex.rows[0]?.indexdef).toContain('created_at DESC');
  });

  it('restricts deletion of a category, owning department, and location referenced by a machine', async () => {
    const machine = await createMachine('delete-restrictions');

    await expectPostgresError(
      sql.query('DELETE FROM machine_categories WHERE id = $1', [categoryId]),
      '23001',
      'machines_category_id_fkey',
    );
    await expectPostgresError(
      sql.query('DELETE FROM departments WHERE id = $1', [owningDepartmentId]),
      '23001',
      'machines_department_id_fkey',
    );
    await expectPostgresError(
      sql.query('DELETE FROM locations WHERE id = $1', [sharedLocationId]),
      '23001',
      'machines_location_id_fkey',
    );
    expect(await prisma.machine.findUnique({ where: { id: machine.id } })).not.toBeNull();
  });

  it('uses every trigram GIN index for selective substring searches over 3000 rows', async () => {
    const targetName = `${runId} needle-name-1729`;
    const targetSerial = `${runId}-needle-serial-1729`;
    const bulkDescription = `${runId} search fixture`;

    await sql.query(
      `INSERT INTO machines
        (name, category_id, manufacturer, model, serial_number, description, department_id, location_id)
       SELECT
         CASE WHEN item = 1729 THEN $1 ELSE $2 || ' search machine ' || item END,
         $3,
         $4,
         'Search Model',
         CASE WHEN item = 1729 THEN $5 ELSE $6 || item END,
         $7,
         $8,
         $9
       FROM generate_series(1, 3000) AS item`,
      [
        targetName,
        runId,
        categoryId,
        `${runId} search manufacturer`,
        targetSerial,
        `${runId}-search-serial-`,
        bulkDescription,
        owningDepartmentId,
        sharedLocationId,
      ],
    );
    await sql.query('ANALYZE machines');
    await sql.query('SET enable_seqscan = off');

    const target = await sql.query<{ asset_tag: string }>(
      'SELECT asset_tag FROM machines WHERE name = $1',
      [targetName],
    );
    const assetTag = target.rows[0]?.asset_tag;
    if (!assetTag) {
      throw new Error('Search fixture did not produce a target asset tag');
    }

    expect(await explainIndexNames('name', `%needle-name-1729%`)).toContain(
      'machines_name_trgm_idx',
    );
    expect(await explainIndexNames('asset_tag', `%${assetTag.slice(3)}%`)).toContain(
      'machines_asset_tag_trgm_idx',
    );
    expect(await explainIndexNames('serial_number', `%needle-serial-1729%`)).toContain(
      'machines_serial_number_trgm_idx',
    );
    await sql.query('RESET enable_seqscan');
    const bulkCount = await sql.query<{ count: string }>(
      'SELECT count(*) FROM machines WHERE description = $1',
      [bulkDescription],
    );
    expect(Number(bulkCount.rows[0]?.count)).toBe(3000);
  });
});
