import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { BookingStatus, PrismaClient, Role } from '../../src/generated/prisma/client';
import { assertSafeIntegrationDatabaseEnvironment } from './database-guard';

type PostgresError = Error & { code?: string; constraint?: string };
type InsertOutcome =
  { ok: true } | { code: string | undefined; constraint: string | undefined; ok: false };

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

const dateAt = (day: number, hour: number, minute = 0, millisecond = 0): Date =>
  new Date(Date.UTC(2035, 0, day, hour, minute, 0, millisecond));

const addMinutes = (value: Date, minutes: number): Date =>
  new Date(value.getTime() + minutes * 60_000);

const runConcurrentInserts = async (
  pool: Pool,
  count: number,
  insert: (client: PoolClient, index: number) => Promise<unknown>,
): Promise<InsertOutcome[]> => {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));

  return Promise.all(
    clients.map(async (client, index) => {
      try {
        await insert(client, index);
        return { ok: true } as const;
      } catch (error) {
        const databaseError = error as PostgresError;
        return {
          code: databaseError.code,
          constraint: databaseError.constraint,
          ok: false,
        } as const;
      } finally {
        client.release();
      }
    }),
  );
};

describe('Usage session and booking database integration', () => {
  const integration = assertSafeIntegrationDatabaseEnvironment(process.env);
  const runId = `t14-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: integration.url, max: 10 }),
  });
  const sql = new Pool({ connectionString: integration.url, max: 30 });

  let approverUserId = '';
  let categoryId = '';
  let departmentId = '';
  let locationId = '';
  let primaryMachineId = '';
  let requesterUserId = '';
  let secondaryMachineId = '';

  const createBooking = async (options: {
    blockedUntil?: Date;
    endsAt: Date;
    machineId?: string;
    purpose: string;
    startsAt: Date;
    status?: BookingStatus;
  }) =>
    prisma.booking.create({
      data: {
        blockedUntil: options.blockedUntil ?? options.endsAt,
        endsAt: options.endsAt,
        machineId: options.machineId ?? primaryMachineId,
        purpose: `${runId} ${options.purpose}`,
        requestedByUserId: requesterUserId,
        startsAt: options.startsAt,
        status: options.status ?? BookingStatus.CONFIRMED,
      },
    });

  const createUsageSession = async (options: {
    bookingId?: string;
    endedAt?: Date;
    expectedEndAt?: Date;
    machineId?: string;
    purpose: string;
    startedAt: Date;
  }) =>
    prisma.usageSession.create({
      data: {
        bookingId: options.bookingId,
        endedAt: options.endedAt,
        expectedEndAt: options.expectedEndAt,
        machineId: options.machineId ?? primaryMachineId,
        purpose: `${runId} ${options.purpose}`,
        startedAt: options.startedAt,
        userId: requesterUserId,
      },
    });

  beforeAll(async () => {
    await prisma.$connect();

    const department = await prisma.department.create({
      data: { code: `${runId}-dept`, name: `${runId} Department` },
    });
    const location = await prisma.location.create({
      data: { departmentId: department.id, name: `${runId} Location` },
    });
    const category = await prisma.machineCategory.create({
      data: { name: `${runId} Category` },
    });
    const requester = await prisma.user.create({
      data: {
        departmentId: department.id,
        email: `${runId}-requester@example.com`,
        fullName: 'Task 1.4 Requester',
        role: Role.STAFF,
        supabaseUserId: randomUUID(),
      },
    });
    const approver = await prisma.user.create({
      data: {
        departmentId: department.id,
        email: `${runId}-approver@example.com`,
        fullName: 'Task 1.4 Approver',
        role: Role.DEPT_MANAGER,
        supabaseUserId: randomUUID(),
      },
    });
    const machines = await Promise.all(
      ['primary', 'secondary'].map((suffix) =>
        prisma.machine.create({
          data: {
            bufferMinutes: suffix === 'primary' ? 15 : null,
            categoryId: category.id,
            departmentId: department.id,
            description: `${runId} ${suffix} machine`,
            locationId: location.id,
            manufacturer: `${runId} manufacturer`,
            model: `Model ${suffix}`,
            name: `${runId} Machine ${suffix}`,
            serialNumber: `${runId}-serial-${suffix}`,
          },
        }),
      ),
    );
    const primaryMachine = machines[0];
    const secondaryMachine = machines[1];
    if (!primaryMachine || !secondaryMachine) {
      throw new Error('Task 1.4 fixtures did not create both machines');
    }

    approverUserId = approver.id;
    categoryId = category.id;
    departmentId = department.id;
    locationId = location.id;
    primaryMachineId = primaryMachine.id;
    requesterUserId = requester.id;
    secondaryMachineId = secondaryMachine.id;
  });

  afterAll(async () => {
    try {
      await prisma.usageSession.deleteMany({
        where: { purpose: { startsWith: runId } },
      });
      await prisma.booking.deleteMany({
        where: { purpose: { startsWith: runId } },
      });
      await prisma.machine.deleteMany({
        where: { description: { startsWith: runId } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: runId } },
      });
      await prisma.location.deleteMany({
        where: { id: locationId },
      });
      await prisma.department.deleteMany({
        where: { id: departmentId },
      });
      await prisma.machineCategory.deleteMany({
        where: { id: categoryId },
      });
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });

  it('stores and reads booking and usage relations with UTC timestamps', async () => {
    const startsAt = dateAt(1, 8);
    const endsAt = dateAt(1, 9);
    const booking = await prisma.booking.create({
      data: {
        approvedByUserId: approverUserId,
        blockedUntil: endsAt,
        decisionNote: 'Approved for scheduled procedure',
        endsAt,
        machineId: secondaryMachineId,
        purpose: `${runId} relation booking`,
        requestedByUserId: requesterUserId,
        startsAt,
        status: BookingStatus.CONFIRMED,
      },
    });
    const session = await createUsageSession({
      bookingId: booking.id,
      endedAt: dateAt(1, 8, 45),
      expectedEndAt: endsAt,
      machineId: secondaryMachineId,
      purpose: 'relation usage',
      startedAt: startsAt,
    });

    const storedBooking = await prisma.booking.findUniqueOrThrow({
      include: {
        approvedByUser: true,
        machine: true,
        requestedByUser: true,
        usageSessions: true,
      },
      where: { id: booking.id },
    });
    const storedSession = await prisma.usageSession.findUniqueOrThrow({
      include: { booking: true, machine: true, user: true },
      where: { id: session.id },
    });

    expect(storedBooking.blockedUntil).toEqual(endsAt);
    expect(storedBooking.requestedByUser.id).toBe(requesterUserId);
    expect(storedBooking.approvedByUser?.id).toBe(approverUserId);
    expect(storedBooking.machine.id).toBe(secondaryMachineId);
    expect(storedBooking.usageSessions.map((item) => item.id)).toContain(session.id);
    expect(storedSession.booking?.id).toBe(booking.id);
    expect(storedSession.user.id).toBe(requesterUserId);
    expect(storedSession.createdAt).toBeInstanceOf(Date);
    expect(storedSession.updatedAt).toBeInstanceOf(Date);

    const previousUpdatedAt = storedBooking.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await prisma.booking.update({
      data: { decisionNote: 'Updated decision note' },
      where: { id: booking.id },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(previousUpdatedAt.getTime());
  });

  it('defines every documented booking status value', async () => {
    const enumValues = await sql.query<{ enumlabel: string }>(
      `SELECT enum_value.enumlabel
       FROM pg_type AS enum_type
       JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
       WHERE enum_type.typname = 'booking_status'
       ORDER BY enum_value.enumsortorder`,
    );

    expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
      'PENDING',
      'CONFIRMED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'REJECTED',
      'NO_SHOW',
    ]);
  });

  it('enforces named time and purpose checks', async () => {
    const bookingInsert = (startsAt: Date, endsAt: Date, blockedUntil: Date, purpose: string) =>
      sql.query(
        `INSERT INTO bookings
          (machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose)
         VALUES ($1, $2, $3, $4, $5, 'CANCELLED', $6)`,
        [primaryMachineId, requesterUserId, startsAt, endsAt, blockedUntil, purpose],
      );

    await expectPostgresError(
      bookingInsert(dateAt(2, 9), dateAt(2, 9), dateAt(2, 9), `${runId} invalid window`),
      '23514',
      'bookings_ends_after_starts_check',
    );
    await expectPostgresError(
      bookingInsert(dateAt(2, 9), dateAt(2, 10), dateAt(2, 9, 59), `${runId} invalid buffer`),
      '23514',
      'bookings_blocked_until_not_before_ends_check',
    );
    await expectPostgresError(
      bookingInsert(dateAt(2, 9), dateAt(2, 10), dateAt(2, 10), 'x'.repeat(201)),
      '23514',
      'bookings_purpose_length_check',
    );

    const usageInsert = (expectedEndAt: Date | null, endedAt: Date | null, purpose: string) =>
      sql.query(
        `INSERT INTO usage_sessions
          (machine_id, user_id, started_at, expected_end_at, ended_at, purpose)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [secondaryMachineId, requesterUserId, dateAt(2, 12), expectedEndAt, endedAt, purpose],
      );

    await expectPostgresError(
      usageInsert(null, dateAt(2, 11, 59), `${runId} invalid ended`),
      '23514',
      'usage_sessions_ended_at_not_before_started_at_check',
    );
    await expectPostgresError(
      usageInsert(dateAt(2, 12), null, `${runId} invalid expected`),
      '23514',
      'usage_sessions_expected_end_after_started_at_check',
    );
    await expectPostgresError(
      usageInsert(null, dateAt(2, 12), 'x'.repeat(201)),
      '23514',
      'usage_sessions_purpose_length_check',
    );
  });

  it('uses half-open buffered ranges and limits overlap to active statuses', async () => {
    const startsAt = dateAt(3, 10);
    const endsAt = dateAt(3, 11);
    const blockedUntil = addMinutes(endsAt, 15);
    const occupied = await createBooking({
      blockedUntil,
      endsAt,
      purpose: 'buffered occupied slot',
      startsAt,
    });

    await prisma.machine.update({
      data: { bufferMinutes: null },
      where: { id: primaryMachineId },
    });
    const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: occupied.id } });
    expect(unchanged.blockedUntil).toEqual(blockedUntil);

    await createBooking({
      endsAt: addMinutes(blockedUntil, 30),
      purpose: 'exact half-open boundary',
      startsAt: blockedUntil,
      status: BookingStatus.PENDING,
    });
    await expectPostgresError(
      sql.query(
        `INSERT INTO bookings
          (machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose)
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6)`,
        [
          primaryMachineId,
          requesterUserId,
          new Date(blockedUntil.getTime() - 1),
          addMinutes(blockedUntil, 30),
          addMinutes(blockedUntil, 30),
          `${runId} one millisecond overlap`,
        ],
      ),
      '23P01',
      'bookings_no_overlap',
    );

    for (const status of [
      BookingStatus.CANCELLED,
      BookingStatus.REJECTED,
      BookingStatus.COMPLETED,
      BookingStatus.NO_SHOW,
    ]) {
      await createBooking({
        endsAt,
        purpose: `non-blocking ${status}`,
        startsAt,
        status,
      });
    }
    await createBooking({
      blockedUntil,
      endsAt,
      machineId: secondaryMachineId,
      purpose: 'same time different machine',
      startsAt,
      status: BookingStatus.CONFIRMED,
    });

    for (const status of ['PENDING', 'CONFIRMED', 'IN_PROGRESS']) {
      await expectPostgresError(
        sql.query(
          `INSERT INTO bookings
            (machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            primaryMachineId,
            requesterUserId,
            startsAt,
            endsAt,
            blockedUntil,
            status,
            `${runId} conflicting ${status}`,
          ],
        ),
        '23P01',
        'bookings_no_overlap',
      );
    }
  });

  it('blocks conflicting booking window and inactive-to-active updates', async () => {
    const occupied = await createBooking({
      endsAt: dateAt(4, 11),
      purpose: 'update occupied slot',
      startsAt: dateAt(4, 10),
    });
    const movable = await createBooking({
      endsAt: dateAt(4, 13),
      purpose: 'move into occupied slot',
      startsAt: dateAt(4, 12),
    });

    await expectPostgresError(
      sql.query(
        `UPDATE bookings
         SET starts_at = $1, ends_at = $2, blocked_until = $2
         WHERE id = $3`,
        [dateAt(4, 10, 30), dateAt(4, 10, 45), movable.id],
      ),
      '23P01',
      'bookings_no_overlap',
    );

    for (const [inactive, active] of [
      ['CANCELLED', 'PENDING'],
      ['REJECTED', 'IN_PROGRESS'],
    ] as const) {
      const booking = await createBooking({
        endsAt: dateAt(4, 10, 45),
        purpose: `reactivate ${inactive}`,
        startsAt: dateAt(4, 10, 15),
        status: inactive as BookingStatus,
      });
      await expectPostgresError(
        sql.query('UPDATE bookings SET status = $1 WHERE id = $2', [active, booking.id]),
        '23P01',
        'bookings_no_overlap',
      );
    }

    expect(await prisma.booking.findUnique({ where: { id: occupied.id } })).not.toBeNull();
  });

  it('allows only one open usage session per machine and one session per booking', async () => {
    const booking = await createBooking({
      endsAt: dateAt(5, 11),
      machineId: secondaryMachineId,
      purpose: 'usage link',
      startsAt: dateAt(5, 10),
    });
    await createUsageSession({
      bookingId: booking.id,
      endedAt: dateAt(5, 10, 30),
      machineId: secondaryMachineId,
      purpose: 'first booking link',
      startedAt: dateAt(5, 10),
    });
    await expectPostgresError(
      sql.query(
        `INSERT INTO usage_sessions
          (machine_id, user_id, booking_id, started_at, ended_at, purpose)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          secondaryMachineId,
          requesterUserId,
          booking.id,
          dateAt(5, 10, 31),
          dateAt(5, 10, 45),
          `${runId} duplicate booking link`,
        ],
      ),
      '23505',
      'usage_sessions_one_per_booking',
    );

    const open = await createUsageSession({
      machineId: primaryMachineId,
      purpose: 'first open session',
      startedAt: dateAt(5, 12),
    });
    await expectPostgresError(
      sql.query(
        `INSERT INTO usage_sessions
          (machine_id, user_id, started_at, purpose)
         VALUES ($1, $2, $3, $4)`,
        [primaryMachineId, requesterUserId, dateAt(5, 12, 1), `${runId} second open session`],
      ),
      '23505',
      'usage_sessions_one_open_per_machine',
    );
    await createUsageSession({
      machineId: secondaryMachineId,
      purpose: 'different machine open session',
      startedAt: dateAt(5, 12),
    });

    await prisma.usageSession.updateMany({
      data: { endedAt: dateAt(5, 13) },
      where: { id: open.id },
    });
    await prisma.usageSession.updateMany({
      data: { endedAt: dateAt(5, 13) },
      where: {
        endedAt: null,
        machineId: secondaryMachineId,
        purpose: { startsWith: runId },
      },
    });
  });

  it('admits exactly one of 20 concurrent overlapping active bookings', async () => {
    const startsAt = dateAt(6, 9);
    const endsAt = dateAt(6, 10);
    const outcomes = await runConcurrentInserts(sql, 20, (client, index) =>
      client.query(
        `INSERT INTO bookings
          (machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose)
         VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6)`,
        [
          primaryMachineId,
          requesterUserId,
          startsAt,
          endsAt,
          endsAt,
          `${runId} concurrent booking ${index}`,
        ],
      ),
    );
    const successes = outcomes.filter((outcome) => outcome.ok);
    const failures = outcomes.filter((outcome) => !outcome.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(19);
    expect(failures.every((failure) => failure.code === '23P01')).toBe(true);
    expect(failures.every((failure) => failure.constraint === 'bookings_no_overlap')).toBe(true);
    process.stdout.write(
      `[integration] booking race: ${successes.length} success, ${failures.length} bookings_no_overlap conflicts\n`,
    );
  });

  it('admits exactly one of 20 concurrent open usage sessions', async () => {
    const outcomes = await runConcurrentInserts(sql, 20, (client, index) =>
      client.query(
        `INSERT INTO usage_sessions
          (machine_id, user_id, started_at, purpose)
         VALUES ($1, $2, $3, $4)`,
        [secondaryMachineId, requesterUserId, dateAt(7, 9), `${runId} concurrent usage ${index}`],
      ),
    );
    const successes = outcomes.filter((outcome) => outcome.ok);
    const failures = outcomes.filter((outcome) => !outcome.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(19);
    expect(failures.every((failure) => failure.code === '23505')).toBe(true);
    expect(
      failures.every((failure) => failure.constraint === 'usage_sessions_one_open_per_machine'),
    ).toBe(true);
    process.stdout.write(
      `[integration] usage race: ${successes.length} success, ${failures.length} usage_sessions_one_open_per_machine conflicts\n`,
    );

    await prisma.usageSession.updateMany({
      data: { endedAt: dateAt(7, 10) },
      where: {
        endedAt: null,
        machineId: secondaryMachineId,
        purpose: { startsWith: `${runId} concurrent usage` },
      },
    });
  });

  it('publishes stable constraint and index names with restrictive foreign keys', async () => {
    const constraints = await sql.query<{
      confdeltype: string;
      conname: string;
      contype: string;
    }>(
      `SELECT conname, contype, confdeltype
       FROM pg_constraint
       WHERE conrelid IN ('bookings'::regclass, 'usage_sessions'::regclass)`,
    );
    const constraintByName = new Map(
      constraints.rows.map((constraint) => [constraint.conname, constraint]),
    );

    expect(constraintByName.get('bookings_no_overlap')?.contype).toBe('x');
    for (const name of [
      'bookings_ends_after_starts_check',
      'bookings_blocked_until_not_before_ends_check',
      'bookings_purpose_length_check',
      'usage_sessions_ended_at_not_before_started_at_check',
      'usage_sessions_expected_end_after_started_at_check',
      'usage_sessions_purpose_length_check',
    ]) {
      expect(constraintByName.get(name)?.contype).toBe('c');
    }
    for (const name of [
      'bookings_machine_id_fkey',
      'bookings_requested_by_user_id_fkey',
      'bookings_approved_by_user_id_fkey',
      'usage_sessions_machine_id_fkey',
      'usage_sessions_user_id_fkey',
      'usage_sessions_booking_id_fkey',
    ]) {
      expect(constraintByName.get(name)?.contype).toBe('f');
      expect(constraintByName.get(name)?.confdeltype).toBe('r');
    }

    const indexes = await sql.query<{ indexdef: string; indexname: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('bookings', 'usage_sessions')`,
    );
    const indexByName = new Map(indexes.rows.map((index) => [index.indexname, index.indexdef]));
    for (const name of [
      'bookings_machine_id_starts_at_idx',
      'bookings_requested_by_user_id_starts_at_idx',
      'bookings_status_starts_at_idx',
      'usage_sessions_user_id_started_at_idx',
      'usage_sessions_one_open_per_machine',
      'usage_sessions_one_per_booking',
    ]) {
      expect(indexByName.has(name)).toBe(true);
    }
    expect(indexByName.get('usage_sessions_one_open_per_machine')).toContain(
      'WHERE (ended_at IS NULL)',
    );
    expect(indexByName.get('usage_sessions_one_per_booking')).toContain(
      'WHERE (booking_id IS NOT NULL)',
    );

    const extension = await sql.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS installed",
    );
    expect(extension.rows[0]?.installed).toBe(true);
  });

  it('restricts deletion of referenced machines, users, and bookings', async () => {
    const booking = await createBooking({
      endsAt: dateAt(8, 11),
      machineId: secondaryMachineId,
      purpose: 'delete restriction booking',
      startsAt: dateAt(8, 10),
    });
    await createUsageSession({
      bookingId: booking.id,
      endedAt: dateAt(8, 10, 30),
      machineId: secondaryMachineId,
      purpose: 'delete restriction usage',
      startedAt: dateAt(8, 10),
    });

    await expectPostgresError(
      sql.query('DELETE FROM bookings WHERE id = $1', [booking.id]),
      '23001',
      'usage_sessions_booking_id_fkey',
    );
    await expectPostgresError(
      sql.query('DELETE FROM machines WHERE id = $1', [secondaryMachineId]),
      '23001',
    );
    await expectPostgresError(
      sql.query('DELETE FROM users WHERE id = $1', [requesterUserId]),
      '23001',
    );
  });
});
