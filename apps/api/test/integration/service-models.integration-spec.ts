import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  MachineStatusSource,
  PrismaClient,
  Role,
  ServiceTicketSeverity,
  ServiceTicketStatus,
  ServiceTicketType,
} from '../../src/generated/prisma/client';
import { assertSafeIntegrationDatabaseEnvironment } from './database-guard';

type PostgresError = Error & { code?: string; constraint?: string };

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

const pauseForTimestampPrecision = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('Service database integration', () => {
  const integration = assertSafeIntegrationDatabaseEnvironment(process.env);
  const runId = `t15-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: integration.url, max: 8 }),
  });
  const sql = new Pool({ connectionString: integration.url, max: 4 });

  let categoryId = '';
  let departmentId = '';
  let locationId = '';
  let machineId = '';
  let reporterUserId = '';
  let technicianUserId = '';

  const createTicket = async (
    suffix: string,
    overrides: {
      assignedToUserId?: string;
      severity?: ServiceTicketSeverity;
      status?: ServiceTicketStatus;
      type?: ServiceTicketType;
    } = {},
  ) =>
    prisma.serviceTicket.create({
      data: {
        assignedToUserId: overrides.assignedToUserId,
        description: `${runId} service ticket ${suffix}`,
        machineId,
        reportedByUserId: reporterUserId,
        severity: overrides.severity ?? ServiceTicketSeverity.MEDIUM,
        status: overrides.status,
        title: `${runId} ${suffix}`,
        type: overrides.type ?? ServiceTicketType.FAULT,
      },
    });

  const insertTicket = async (options: {
    assignedToUserId?: string | null;
    closedAt?: Date | null;
    description?: string;
    machineBackInServiceAt?: Date | null;
    machineOutOfServiceFrom?: Date | null;
    openedAt?: Date;
    resolvedAt?: Date | null;
    status?: ServiceTicketStatus;
    title: string;
  }) => {
    const openedAt = options.openedAt ?? new Date('2035-01-01T08:00:00.000Z');
    return sql.query(
      `INSERT INTO service_tickets
        (machine_id, reported_by_user_id, title, description, severity, status, assigned_to_user_id,
         type, opened_at, resolved_at, closed_at, machine_out_of_service_from, machine_back_in_service_at)
       VALUES ($1, $2, $3, $4, 'MEDIUM', $5, $6, 'FAULT', $7, $8, $9, $10, $11)`,
      [
        machineId,
        reporterUserId,
        options.title,
        options.description ?? `${runId} raw ticket`,
        options.status ?? ServiceTicketStatus.OPEN,
        options.assignedToUserId ?? null,
        openedAt,
        options.resolvedAt ?? null,
        options.closedAt ?? null,
        options.machineOutOfServiceFrom ?? null,
        options.machineBackInServiceAt ?? null,
      ],
    );
  };

  beforeAll(async () => {
    await prisma.$connect();

    const department = await prisma.department.create({
      data: { code: `${runId}-dept`, name: `${runId} Service Department` },
    });
    const location = await prisma.location.create({
      data: { departmentId: department.id, name: `${runId} Service Bay` },
    });
    const category = await prisma.machineCategory.create({
      data: { name: `${runId} Service Category` },
    });
    const reporter = await prisma.user.create({
      data: {
        departmentId: department.id,
        email: `${runId}-reporter@example.com`,
        fullName: 'Task 1.5 Reporter',
        role: Role.STAFF,
        supabaseUserId: randomUUID(),
      },
    });
    const technician = await prisma.user.create({
      data: {
        departmentId: department.id,
        email: `${runId}-technician@example.com`,
        fullName: 'Task 1.5 Technician',
        role: Role.BIOMED_TECH,
        supabaseUserId: randomUUID(),
      },
    });
    const machine = await prisma.machine.create({
      data: {
        categoryId: category.id,
        departmentId: department.id,
        description: `${runId} service fixture`,
        locationId: location.id,
        manufacturer: `${runId} manufacturer`,
        model: 'Task 1.5 Model',
        name: `${runId} Service Machine`,
        serialNumber: `${runId}-serial`,
      },
    });

    categoryId = category.id;
    departmentId = department.id;
    locationId = location.id;
    machineId = machine.id;
    reporterUserId = reporter.id;
    technicianUserId = technician.id;
  });

  afterAll(async () => {
    try {
      await prisma.machineStatusHistory.deleteMany({ where: { machineId } });
      await prisma.serviceRecord.deleteMany({
        where: { ticket: { title: { startsWith: runId } } },
      });
      await prisma.serviceTicket.deleteMany({ where: { title: { startsWith: runId } } });
      await prisma.maintenanceSchedule.deleteMany({ where: { machineId } });
      await prisma.machine.deleteMany({ where: { id: machineId } });
      await prisma.user.deleteMany({
        where: { id: { in: [reporterUserId, technicianUserId] } },
      });
      await prisma.location.deleteMany({ where: { id: locationId } });
      await prisma.department.deleteMany({ where: { id: departmentId } });
      await prisma.machineCategory.deleteMany({ where: { id: categoryId } });
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });

  it('stores every service model, relation and default with automatic update timestamps', async () => {
    const ticket = await createTicket('full relations');
    expect(ticket.status).toBe(ServiceTicketStatus.OPEN);
    expect(ticket.openedAt).toBeInstanceOf(Date);

    const assigned = await prisma.serviceTicket.update({
      data: {
        assignedToUserId: technicianUserId,
        status: ServiceTicketStatus.ASSIGNED,
      },
      where: { id: ticket.id },
    });
    const performedAt = new Date('2035-02-01T08:00:00.000Z');
    const firstRecord = await prisma.serviceRecord.create({
      data: {
        costAmount: 125_000,
        nextDueAt: new Date('2035-08-01T08:00:00.000Z'),
        partsReplaced: 'Power supply',
        performedAt,
        performedByUserId: technicianUserId,
        ticketId: ticket.id,
        vendorName: 'Hospital Biomedical Unit',
        workDone: 'Replaced power supply and verified output',
      },
    });
    const secondRecord = await prisma.serviceRecord.create({
      data: {
        currency: 'USD',
        performedAt: new Date('2035-02-02T08:00:00.000Z'),
        performedByUserId: technicianUserId,
        ticketId: ticket.id,
        workDone: 'Follow-up inspection',
      },
    });
    const schedule = await prisma.maintenanceSchedule.create({
      data: {
        intervalDays: 180,
        lastDoneAt: performedAt,
        machineId,
        nextDueAt: new Date('2035-08-01T08:00:00.000Z'),
      },
    });
    const history = await prisma.machineStatusHistory.create({
      data: {
        changedByUserId: technicianUserId,
        machineId,
        reason: `${runId} service started`,
        source: MachineStatusSource.SERVICE_TICKET,
        ticketId: ticket.id,
        toCondition: 'UNDER_MAINTENANCE',
      },
    });

    const stored = await prisma.serviceTicket.findUniqueOrThrow({
      include: {
        assignedToUser: true,
        machine: true,
        records: { orderBy: { performedAt: 'asc' } },
        reportedByUser: true,
        statusHistory: true,
      },
      where: { id: ticket.id },
    });

    expect(stored.assignedToUser?.id).toBe(technicianUserId);
    expect(stored.machine.id).toBe(machineId);
    expect(stored.reportedByUser.id).toBe(reporterUserId);
    expect(stored.records.map((record) => record.id)).toEqual([firstRecord.id, secondRecord.id]);
    expect(stored.statusHistory.map((item) => item.id)).toContain(history.id);
    expect(firstRecord.currency).toBe('KES');
    expect(schedule.isActive).toBe(true);
    expect(assigned.updatedAt.getTime()).toBeGreaterThanOrEqual(ticket.updatedAt.getTime());

    await pauseForTimestampPrecision();
    const [updatedTicket, updatedRecord, updatedSchedule] = await Promise.all([
      prisma.serviceTicket.update({
        data: { title: `${runId} full relations updated` },
        where: { id: ticket.id },
      }),
      prisma.serviceRecord.update({
        data: { workDone: 'Replaced power supply; output reverified' },
        where: { id: firstRecord.id },
      }),
      prisma.maintenanceSchedule.update({
        data: { intervalDays: 181 },
        where: { id: schedule.id },
      }),
    ]);
    expect(updatedTicket.updatedAt.getTime()).toBeGreaterThan(assigned.updatedAt.getTime());
    expect(updatedRecord.updatedAt.getTime()).toBeGreaterThan(firstRecord.updatedAt.getTime());
    expect(updatedSchedule.updatedAt.getTime()).toBeGreaterThan(schedule.updatedAt.getTime());
  });

  it('defines every documented ticket enum value', async () => {
    const enumRows = await sql.query<{ enumlabel: string; typname: string }>(
      `SELECT enum_type.typname, enum_value.enumlabel
       FROM pg_type AS enum_type
       JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
       WHERE enum_type.typname IN (
         'service_ticket_severity', 'service_ticket_status', 'service_ticket_type'
       )
       ORDER BY enum_type.typname, enum_value.enumsortorder`,
    );
    const values = (type: string) =>
      enumRows.rows.filter((row) => row.typname === type).map((row) => row.enumlabel);

    expect(values('service_ticket_severity')).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    expect(values('service_ticket_status')).toEqual([
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'RESOLVED',
      'CLOSED',
      'CANCELLED',
    ]);
    expect(values('service_ticket_type')).toEqual([
      'FAULT',
      'PREVENTIVE',
      'CALIBRATION',
      'INSPECTION',
    ]);
  });

  it('enforces ticket text and lifecycle consistency checks', async () => {
    const openedAt = new Date('2035-03-01T08:00:00.000Z');
    const resolvedAt = new Date('2035-03-01T09:00:00.000Z');

    await expectPostgresError(
      insertTicket({ title: 'x'.repeat(201) }),
      '23514',
      'service_tickets_title_length_check',
    );
    await expectPostgresError(insertTicket({ title: '' }), '23514');
    await expectPostgresError(
      insertTicket({ title: '   ' }),
      '23514',
      'service_tickets_title_not_blank_check',
    );
    await expectPostgresError(
      insertTicket({ description: 'x'.repeat(4001), title: `${runId} long description` }),
      '23514',
      'service_tickets_description_length_check',
    );
    await expectPostgresError(
      insertTicket({ status: ServiceTicketStatus.RESOLVED, title: `${runId} unresolved resolved` }),
      '23514',
      'service_tickets_resolved_status_timestamp_check',
    );
    await expectPostgresError(
      insertTicket({
        closedAt: resolvedAt,
        status: ServiceTicketStatus.CLOSED,
        title: `${runId} closed without resolved`,
      }),
      '23514',
    );
    await expectPostgresError(
      insertTicket({
        resolvedAt,
        status: ServiceTicketStatus.CLOSED,
        title: `${runId} closed without closed at`,
      }),
      '23514',
      'service_tickets_closed_status_timestamp_check',
    );
    await expectPostgresError(
      insertTicket({
        openedAt,
        resolvedAt: new Date(openedAt.getTime() - 1),
        title: `${runId} resolved before open`,
      }),
      '23514',
      'service_tickets_resolved_at_order_check',
    );
    await expectPostgresError(
      insertTicket({
        closedAt: new Date(resolvedAt.getTime() - 1),
        openedAt,
        resolvedAt,
        title: `${runId} closed before resolved`,
      }),
      '23514',
      'service_tickets_closed_at_order_check',
    );
    await expectPostgresError(
      insertTicket({ closedAt: resolvedAt, title: `${runId} closed timestamp without resolved` }),
      '23514',
      'service_tickets_closed_at_order_check',
    );
    await expectPostgresError(
      insertTicket({
        machineBackInServiceAt: openedAt,
        machineOutOfServiceFrom: resolvedAt,
        title: `${runId} invalid service window`,
      }),
      '23514',
      'service_tickets_service_window_order_check',
    );

    for (const status of [ServiceTicketStatus.ASSIGNED, ServiceTicketStatus.IN_PROGRESS]) {
      await expectPostgresError(
        insertTicket({ status, title: `${runId} unassigned ${status}` }),
        '23514',
        'service_tickets_assignment_required_check',
      );
    }

    await expect(
      insertTicket({ status: ServiceTicketStatus.CANCELLED, title: `${runId} cancelled directly` }),
    ).resolves.toBeDefined();
  });

  it('enforces service-record money, currency and due-date rules without making tickets unique', async () => {
    const ticket = await createTicket('record rules');
    const performedAt = new Date('2035-04-01T08:00:00.000Z');
    const insertRecord = (costAmount: number | null, currency: string, nextDueAt: Date | null) =>
      sql.query(
        `INSERT INTO service_records
          (ticket_id, performed_by_user_id, performed_at, work_done, cost_amount, currency, next_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ticket.id,
          technicianUserId,
          performedAt,
          `${runId} direct service record`,
          costAmount,
          currency,
          nextDueAt,
        ],
      );

    await expectPostgresError(
      insertRecord(-1, 'KES', null),
      '23514',
      'service_records_cost_amount_nonnegative_check',
    );
    await expectPostgresError(
      insertRecord(0, 'KES', performedAt),
      '23514',
      'service_records_next_due_after_performed_check',
    );
    for (const currency of ['kes', 'KESH']) {
      await expectPostgresError(
        insertRecord(0, currency, null),
        '23514',
        'service_records_currency_format_check',
      );
    }

    await expect(insertRecord(2_147_483_647, 'KES', null)).resolves.toBeDefined();
    await expectPostgresError(insertRecord(2_147_483_648, 'KES', null), '22003');

    const count = await prisma.serviceRecord.count({ where: { ticketId: ticket.id } });
    expect(count).toBe(1);
  });

  it('enforces maintenance cadence and one active schedule while retaining inactive history', async () => {
    const lastDoneAt = new Date('2035-05-01T08:00:00.000Z');
    const nextDueAt = new Date('2035-11-01T08:00:00.000Z');
    const insertSchedule = (intervalDays: number, nextDue: Date | null, isActive: boolean) =>
      sql.query(
        `INSERT INTO maintenance_schedules
          (machine_id, interval_days, last_done_at, next_due_at, is_active)
         VALUES ($1, $2, $3, $4, $5)`,
        [machineId, intervalDays, lastDoneAt, nextDue, isActive],
      );

    await expectPostgresError(
      insertSchedule(0, nextDueAt, false),
      '23514',
      'maintenance_schedules_interval_days_positive_check',
    );
    await expectPostgresError(
      insertSchedule(30, new Date(lastDoneAt.getTime() - 1), false),
      '23514',
      'maintenance_schedules_next_due_not_before_last_done_check',
    );

    await prisma.maintenanceSchedule.updateMany({
      data: { isActive: false },
      where: { machineId },
    });
    await expect(insertSchedule(90, nextDueAt, true)).resolves.toBeDefined();
    await expectPostgresError(
      insertSchedule(180, nextDueAt, true),
      '23505',
      'maintenance_schedules_one_active_per_machine',
    );
    await expect(insertSchedule(180, nextDueAt, false)).resolves.toBeDefined();
    await expect(insertSchedule(365, nextDueAt, false)).resolves.toBeDefined();
  });

  it('allows multiple simultaneous fault tickets for one machine', async () => {
    const [first, second] = await Promise.all([
      createTicket('duplicate fault allowed a', {
        severity: ServiceTicketSeverity.HIGH,
        type: ServiceTicketType.FAULT,
      }),
      createTicket('duplicate fault allowed b', {
        severity: ServiceTicketSeverity.CRITICAL,
        type: ServiceTicketType.FAULT,
      }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.status).toBe(ServiceTicketStatus.OPEN);
    expect(second.status).toBe(ServiceTicketStatus.OPEN);
  });

  it('publishes stable checks, indexes and restrictive foreign keys', async () => {
    const constraints = await sql.query<{
      confdeltype: string;
      conname: string;
      contype: string;
    }>(
      `SELECT conname, contype, confdeltype
       FROM pg_constraint
       WHERE conrelid IN (
         'service_tickets'::regclass,
         'service_records'::regclass,
         'maintenance_schedules'::regclass,
         'machine_status_history'::regclass
       )`,
    );
    const constraintByName = new Map(
      constraints.rows.map((constraint) => [constraint.conname, constraint]),
    );

    for (const name of [
      'service_tickets_title_length_check',
      'service_tickets_title_not_blank_check',
      'service_tickets_description_length_check',
      'service_tickets_resolved_status_timestamp_check',
      'service_tickets_closed_status_timestamp_check',
      'service_tickets_resolved_at_order_check',
      'service_tickets_closed_at_order_check',
      'service_tickets_service_window_order_check',
      'service_tickets_assignment_required_check',
      'service_records_cost_amount_nonnegative_check',
      'service_records_next_due_after_performed_check',
      'service_records_currency_format_check',
      'maintenance_schedules_interval_days_positive_check',
      'maintenance_schedules_next_due_not_before_last_done_check',
    ]) {
      expect(constraintByName.get(name)?.contype).toBe('c');
    }
    for (const name of [
      'machine_status_history_ticket_id_fkey',
      'service_tickets_machine_id_fkey',
      'service_tickets_reported_by_user_id_fkey',
      'service_tickets_assigned_to_user_id_fkey',
      'service_records_ticket_id_fkey',
      'service_records_performed_by_user_id_fkey',
      'maintenance_schedules_machine_id_fkey',
    ]) {
      expect(constraintByName.get(name)?.contype).toBe('f');
      expect(constraintByName.get(name)?.confdeltype).toBe('r');
    }

    const indexes = await sql.query<{ indexdef: string; indexname: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN (
           'service_tickets', 'service_records', 'maintenance_schedules', 'machine_status_history'
         )`,
    );
    const indexByName = new Map(indexes.rows.map((index) => [index.indexname, index.indexdef]));
    for (const name of [
      'service_tickets_machine_id_status_idx',
      'service_tickets_assigned_to_user_id_status_idx',
      'service_tickets_status_severity_idx',
      'service_tickets_machine_id_opened_at_idx',
      'service_records_ticket_id_performed_at_idx',
      'maintenance_schedules_one_active_per_machine',
      'maintenance_schedules_active_next_due_at_idx',
      'machine_status_history_ticket_id_idx',
    ]) {
      expect(indexByName.has(name)).toBe(true);
    }
    expect(indexByName.get('service_tickets_machine_id_opened_at_idx')).toContain('opened_at DESC');
    expect(indexByName.get('maintenance_schedules_one_active_per_machine')).toContain(
      'WHERE is_active',
    );
    expect(indexByName.get('maintenance_schedules_active_next_due_at_idx')).toContain(
      'WHERE is_active',
    );
  });

  it('restricts deletion of service records of fact and their parents', async () => {
    const recordTicket = await createTicket('record delete restriction');
    await prisma.serviceRecord.create({
      data: {
        performedAt: new Date('2035-06-01T08:00:00.000Z'),
        performedByUserId: technicianUserId,
        ticketId: recordTicket.id,
        workDone: `${runId} retained service work`,
      },
    });
    await expectPostgresError(
      sql.query('DELETE FROM service_tickets WHERE id = $1', [recordTicket.id]),
      '23001',
      'service_records_ticket_id_fkey',
    );

    const historyTicket = await createTicket('history delete restriction');
    await prisma.machineStatusHistory.create({
      data: {
        changedByUserId: technicianUserId,
        machineId,
        reason: `${runId} retained ticket history`,
        source: MachineStatusSource.SERVICE_TICKET,
        ticketId: historyTicket.id,
        toCondition: 'NEEDS_SERVICE',
      },
    });
    await expectPostgresError(
      sql.query('DELETE FROM service_tickets WHERE id = $1', [historyTicket.id]),
      '23001',
      'machine_status_history_ticket_id_fkey',
    );

    await expectPostgresError(
      sql.query('DELETE FROM machines WHERE id = $1', [machineId]),
      '23001',
    );
    await expectPostgresError(
      sql.query('DELETE FROM users WHERE id = $1', [reporterUserId]),
      '23001',
    );
    await expectPostgresError(
      sql.query('DELETE FROM users WHERE id = $1', [technicianUserId]),
      '23001',
    );
  });
});
