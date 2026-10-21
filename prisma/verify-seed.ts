import { Client } from 'pg';
import { assertSafeSeedEnvironment } from './seed-safety';

type CountRow = { count: string };
type PlanFinding = { indexes: Set<string>; sequentialTables: Set<string> };

const queryCount = async (client: Client, sql: string, values: unknown[] = []): Promise<number> => {
  const result = await client.query<CountRow>(sql, values);
  return Number(result.rows[0]?.count ?? -1);
};

const assertCount = (label: string, actual: number, expected: number): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
};

const documentedIndexes = [
  'attachments_entity_type_entity_id_idx',
  'attachments_storage_path_key',
  'audit_logs_actor_user_id_created_at_idx',
  'audit_logs_created_at_idx',
  'audit_logs_entity_type_entity_id_created_at_idx',
  'bookings_machine_id_starts_at_idx',
  'bookings_no_overlap',
  'bookings_requested_by_user_id_starts_at_idx',
  'bookings_status_starts_at_idx',
  'machine_status_history_machine_id_created_at_idx',
  'machine_status_history_ticket_id_idx',
  'machines_asset_tag_key',
  'machines_asset_tag_trgm_idx',
  'machines_category_id_idx',
  'machines_condition_idx',
  'machines_department_id_idx',
  'machines_manufacturer_serial_number_lower_key',
  'machines_name_trgm_idx',
  'machines_next_service_due_at_idx',
  'machines_serial_number_trgm_idx',
  'maintenance_schedules_active_next_due_at_idx',
  'maintenance_schedules_one_active_per_machine',
  'notifications_unread_user_id_created_at_idx',
  'notifications_user_id_read_at_idx',
  'service_records_ticket_id_performed_at_idx',
  'service_tickets_assigned_to_user_id_status_idx',
  'service_tickets_machine_id_opened_at_idx',
  'service_tickets_machine_id_status_idx',
  'service_tickets_status_severity_idx',
  'usage_sessions_one_open_per_machine',
  'usage_sessions_one_per_booking',
  'usage_sessions_user_id_started_at_idx',
] as const;

const verifyIndexCatalog = async (client: Client): Promise<void> => {
  const result = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
  );
  const actual = new Set(result.rows.map((row) => row.indexname));
  const missing = documentedIndexes.filter((name) => !actual.has(name));
  if (missing.length > 0) throw new Error(`Missing documented indexes: ${missing.join(', ')}`);
  console.log(
    `Index catalog review passed: all ${documentedIndexes.length} documented query/constraint indexes exist (${actual.size} total including primary and unique keys).`,
  );
};

const inspectPlan = (value: unknown, finding: PlanFinding): void => {
  if (Array.isArray(value)) {
    for (const item of value) inspectPlan(item, finding);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  if (typeof record['Index Name'] === 'string') finding.indexes.add(record['Index Name']);
  if (record['Node Type'] === 'Seq Scan' && typeof record['Relation Name'] === 'string') {
    finding.sequentialTables.add(record['Relation Name']);
  }
  for (const child of Object.values(record)) inspectPlan(child, finding);
};

const explain = async (
  client: Client,
  label: string,
  sql: string,
  values: unknown[],
): Promise<PlanFinding> => {
  const result = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values,
  );
  const finding: PlanFinding = { indexes: new Set(), sequentialTables: new Set() };
  inspectPlan(result.rows[0]?.['QUERY PLAN'], finding);
  const indexes = [...finding.indexes].sort().join(', ') || 'none';
  const sequential = [...finding.sequentialTables].sort().join(', ') || 'none';
  console.log(`${label}: indexes [${indexes}]; sequential tables [${sequential}]`);
  return finding;
};

const verifySeedWorld = async (client: Client): Promise<void> => {
  const counts = {
    bookings: await queryCount(
      client,
      "SELECT count(*) FROM bookings WHERE purpose IN ('Ward round', 'Pre-op check')",
    ),
    categories: await queryCount(client, 'SELECT count(*) FROM machine_categories'),
    departments: await queryCount(
      client,
      "SELECT count(*) FROM departments WHERE code IN ('CAS','ICU','MAT','RAD','THR')",
    ),
    locations: await queryCount(
      client,
      "SELECT count(*) FROM locations l JOIN departments d ON d.id=l.department_id WHERE d.code IN ('CAS','ICU','MAT','RAD','THR')",
    ),
    machines: await queryCount(
      client,
      "SELECT count(*) FROM machines WHERE asset_tag ~ '^HM-[0-9]{6}$'",
    ),
    seedUsers: await queryCount(client, 'SELECT count(*) FROM users WHERE is_seed_data'),
    sessions: await queryCount(
      client,
      "SELECT count(*) FROM usage_sessions WHERE purpose IN ('Ward round', 'Pre-op check')",
    ),
    tickets: await queryCount(
      client,
      "SELECT count(*) FROM service_tickets WHERE description LIKE 'Demonstration %'",
    ),
  };
  assertCount('departments', counts.departments, 5);
  assertCount('locations', counts.locations, 20);
  assertCount('categories', counts.categories, 8);
  assertCount('machines', counts.machines, 60);
  assertCount('placeholder users', counts.seedUsers, 6);
  assertCount('bookings', counts.bookings, 12);
  assertCount('usage sessions', counts.sessions, 14);
  assertCount('service tickets', counts.tickets, 15);

  const conditions = await client.query<{ condition: string; count: string }>(
    "SELECT condition::text, count(*) FROM machines WHERE asset_tag ~ '^HM-[0-9]{6}$' GROUP BY condition ORDER BY condition",
  );
  const conditionCounts = Object.fromEntries(
    conditions.rows.map((row) => [row.condition, Number(row.count)]),
  );
  const expectedConditions: Record<string, number> = {
    NEEDS_SERVICE: 6,
    OPERATIONAL: 45,
    OUT_OF_SERVICE: 2,
    RETIRED: 2,
    UNDER_MAINTENANCE: 5,
  };
  for (const [condition, expected] of Object.entries(expectedConditions)) {
    assertCount(`${condition} machines`, conditionCounts[condition] ?? 0, expected);
  }

  const invariants = {
    badOpenSession: await queryCount(
      client,
      "SELECT count(*) FROM usage_sessions s JOIN machines m ON m.id=s.machine_id WHERE s.ended_at IS NULL AND m.condition <> 'OPERATIONAL'",
    ),
    duplicates: await queryCount(
      client,
      "SELECT count(*) FROM (SELECT asset_tag FROM machines WHERE asset_tag ~ '^HM-[0-9]{6}$' GROUP BY asset_tag HAVING count(*) > 1) duplicate",
    ),
    missingHistory: await queryCount(
      client,
      "SELECT count(*) FROM machines m WHERE m.condition <> 'OPERATIONAL' AND m.asset_tag ~ '^HM-[0-9]{6}$' AND NOT EXISTS (SELECT 1 FROM machine_status_history h WHERE h.machine_id=m.id AND h.to_condition=m.condition)",
    ),
    missingOpenTicket: await queryCount(
      client,
      "SELECT count(*) FROM machines m WHERE m.condition <> 'OPERATIONAL' AND m.asset_tag ~ '^HM-[0-9]{6}$' AND NOT EXISTS (SELECT 1 FROM service_tickets t WHERE t.machine_id=m.id AND t.status IN ('OPEN','ASSIGNED','IN_PROGRESS'))",
    ),
    placeholderAuthIds: await queryCount(
      client,
      'SELECT count(*) FROM users WHERE is_seed_data AND supabase_user_id IS NOT NULL',
    ),
    retiredWithoutDate: await queryCount(
      client,
      "SELECT count(*) FROM machines WHERE condition='RETIRED' AND retired_on IS NULL",
    ),
  };
  for (const [label, count] of Object.entries(invariants)) assertCount(label, count, 0);

  const scenarios = {
    expiringWarranty: await queryCount(
      client,
      'SELECT count(*) FROM machines WHERE warranty_expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 30',
    ),
    nearBookings: await queryCount(
      client,
      "SELECT count(*) FROM bookings WHERE status IN ('PENDING','CONFIRMED') AND starts_at BETWEEN now() AND now() + interval '1 hour'",
    ),
    overdueMaintenance: await queryCount(
      client,
      'SELECT count(*) FROM maintenance_schedules WHERE is_active AND next_due_at < now()',
    ),
    overdueSessions: await queryCount(
      client,
      'SELECT count(*) FROM usage_sessions WHERE ended_at IS NULL AND expected_end_at < now()',
    ),
  };
  for (const [label, count] of Object.entries(scenarios)) {
    if (count < 1) throw new Error(`${label}: expected at least one row`);
  }

  console.log(
    `Seed verification passed: ${counts.machines} machines, ${counts.bookings} bookings, ${counts.sessions} sessions, ${counts.tickets} tickets; all consistency scenarios present.`,
  );
};

const proveSequenceContinuity = async (client: Client): Promise<void> => {
  await client.query('BEGIN');
  try {
    const result = await client.query<{ asset_tag: string }>(`
      INSERT INTO machines (
        name, category_id, manufacturer, model, serial_number, department_id, location_id
      )
      SELECT
        'Sequence proof machine', c.id, 'Sequence Proof', 'Proof', 'sequence-proof-' || gen_random_uuid(), d.id, l.id
      FROM machine_categories c
      CROSS JOIN departments d
      JOIN locations l ON l.department_id = d.id
      ORDER BY c.name, d.code, l.name
      LIMIT 1
      RETURNING asset_tag
    `);
    const tag = result.rows[0]?.asset_tag;
    const number = Number(tag?.slice(3));
    if (!tag?.startsWith('HM-') || !Number.isInteger(number) || number <= 60) {
      throw new Error('Asset-tag sequence did not advance beyond the 60 deterministic seed tags');
    }
    console.log(`Asset-tag sequence proof passed: the next generated tag number was ${number}.`);
  } finally {
    await client.query('ROLLBACK');
  }
};

const runIndexReview = async (client: Client): Promise<void> => {
  const reference = await client.query<{
    category_id: string;
    department_id: string;
    location_id: string;
    staff_user_id: string;
    tech_user_id: string;
  }>(`
    SELECT
      (SELECT id FROM machine_categories ORDER BY name LIMIT 1) AS category_id,
      (SELECT id FROM departments WHERE code = 'ICU') AS department_id,
      (SELECT l.id FROM locations l JOIN departments d ON d.id=l.department_id WHERE d.code='ICU' ORDER BY l.name LIMIT 1) AS location_id,
      (SELECT id FROM users WHERE role='STAFF' AND is_seed_data LIMIT 1) AS staff_user_id,
      (SELECT id FROM users WHERE role='BIOMED_TECH' AND is_seed_data LIMIT 1) AS tech_user_id
  `);
  const ids = reference.rows[0];
  if (!ids) throw new Error('Seed reference rows are missing');
  const placements = await client.query<{ department_ids: string[]; location_ids: string[] }>(`
    SELECT
      array_agg(d.id ORDER BY d.code) AS department_ids,
      array_agg((SELECT l.id FROM locations l WHERE l.department_id=d.id ORDER BY l.name LIMIT 1) ORDER BY d.code) AS location_ids
    FROM departments d
    WHERE d.code IN ('CAS','ICU','MAT','RAD','THR')
  `);
  const placement = placements.rows[0];
  if (!placement || placement.department_ids.length !== 5 || placement.location_ids.length !== 5) {
    throw new Error('Expected five seeded department placements for the bulk index fixture');
  }

  console.log('Seed-sized query plans:');
  await explain(
    client,
    'machine list',
    "SELECT id FROM machines WHERE department_id=$1 AND condition='OPERATIONAL' AND deleted_at IS NULL AND name ILIKE '%monitor%' ORDER BY name LIMIT 50",
    [ids.department_id],
  );
  await explain(
    client,
    'status board',
    'SELECT m.id, s.id FROM machines m LEFT JOIN usage_sessions s ON s.machine_id=m.id AND s.ended_at IS NULL WHERE m.department_id=$1 AND m.deleted_at IS NULL ORDER BY m.name LIMIT 100',
    [ids.department_id],
  );
  await explain(
    client,
    'availability',
    "SELECT id FROM bookings WHERE machine_id=(SELECT id FROM machines ORDER BY id LIMIT 1) AND status IN ('PENDING','CONFIRMED','IN_PROGRESS') AND tstzrange(starts_at, blocked_until, '[)') && tstzrange(now(), now()+interval '2 hours', '[)')",
    [],
  );
  await explain(
    client,
    'my bookings',
    "SELECT id FROM bookings WHERE requested_by_user_id=$1 AND starts_at >= now()-interval '30 days' ORDER BY starts_at",
    [ids.staff_user_id],
  );
  await explain(
    client,
    'technician board',
    "SELECT id FROM service_tickets WHERE assigned_to_user_id=$1 AND status IN ('ASSIGNED','IN_PROGRESS') ORDER BY severity DESC, opened_at",
    [ids.tech_user_id],
  );

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO machines (
        id, asset_tag, name, category_id, manufacturer, model, serial_number,
        department_id, location_id, condition, is_bookable
      )
      SELECT
        gen_random_uuid(), 'LOAD-' || lpad(i::text, 6, '0'),
        CASE WHEN i % 100 = 0 THEN 'SearchTerm patient monitor ' || i ELSE 'Load machine ' || i END,
        $1, 'load manufacturer', 'Load Model', 'load-serial-' || i,
        ($2::uuid[])[((i - 1) % 5) + 1], ($3::uuid[])[((i - 1) % 5) + 1],
        CASE WHEN i % 10 = 0 THEN 'NEEDS_SERVICE'::machine_condition ELSE 'OPERATIONAL'::machine_condition END,
        true
      FROM generate_series(1, 3000) AS i`,
      [ids.category_id, placement.department_ids, placement.location_ids],
    );
    await client.query(
      `INSERT INTO bookings (
        machine_id, requested_by_user_id, starts_at, ends_at, blocked_until, status, purpose
      )
      SELECT m.id, $1, now() + (row_number() OVER ()) * interval '1 minute',
             now() + (row_number() OVER ()) * interval '1 minute' + interval '30 minutes',
             now() + (row_number() OVER ()) * interval '1 minute' + interval '30 minutes',
             'CONFIRMED', 'Load-test generic booking'
      FROM machines m WHERE m.asset_tag LIKE 'LOAD-%'`,
      [ids.staff_user_id],
    );
    await client.query(
      `INSERT INTO service_tickets (
        machine_id, reported_by_user_id, title, description, severity, status,
        assigned_to_user_id, type, opened_at
      )
      SELECT m.id, $1, 'Load ticket', 'Index-plan fixture',
             CASE WHEN substring(m.asset_tag from 6)::int % 20 = 0 THEN 'CRITICAL'::service_ticket_severity ELSE 'MEDIUM'::service_ticket_severity END,
             CASE WHEN substring(m.asset_tag from 6)::int % 10 = 0 THEN 'IN_PROGRESS'::service_ticket_status ELSE 'OPEN'::service_ticket_status END,
             CASE WHEN substring(m.asset_tag from 6)::int % 10 = 0 THEN $2::uuid ELSE NULL END,
             'FAULT', now() - interval '1 day'
      FROM machines m WHERE m.asset_tag LIKE 'LOAD-%'`,
      [ids.staff_user_id, ids.tech_user_id],
    );
    await client.query('ANALYZE machines');
    await client.query('ANALYZE bookings');
    await client.query('ANALYZE service_tickets');

    console.log('3,000-machine query plans:');
    const findings = [
      await explain(
        client,
        'machine list',
        "SELECT id FROM machines WHERE department_id=$1 AND condition='OPERATIONAL' AND deleted_at IS NULL AND name ILIKE '%searchterm%' ORDER BY name LIMIT 50",
        [ids.department_id],
      ),
      await explain(
        client,
        'status board',
        'SELECT m.id, s.id FROM machines m LEFT JOIN usage_sessions s ON s.machine_id=m.id AND s.ended_at IS NULL WHERE m.department_id=$1 AND m.deleted_at IS NULL ORDER BY m.name LIMIT 100',
        [ids.department_id],
      ),
      await explain(
        client,
        'availability',
        "SELECT id FROM bookings WHERE machine_id=(SELECT id FROM machines WHERE asset_tag='LOAD-000001') AND status IN ('PENDING','CONFIRMED','IN_PROGRESS') AND tstzrange(starts_at, blocked_until, '[)') && tstzrange(now(), now()+interval '2 hours', '[)')",
        [],
      ),
      await explain(
        client,
        'my bookings',
        "SELECT id FROM bookings WHERE requested_by_user_id=$1 AND starts_at >= now()-interval '30 days' ORDER BY starts_at LIMIT 100",
        [ids.staff_user_id],
      ),
      await explain(
        client,
        'technician board',
        "SELECT id FROM service_tickets WHERE assigned_to_user_id=$1 AND status IN ('ASSIGNED','IN_PROGRESS') ORDER BY severity DESC, opened_at LIMIT 100",
        [ids.tech_user_id],
      ),
    ];
    if (findings[0]?.sequentialTables.has('machines')) {
      throw new Error('Large machine-list query still sequentially scans machines');
    }
    if (findings[2]?.sequentialTables.has('bookings')) {
      throw new Error('Large availability query still sequentially scans bookings');
    }
    if (findings[3]?.sequentialTables.has('bookings')) {
      throw new Error('Large my-bookings query still sequentially scans bookings');
    }
    if (findings[4]?.sequentialTables.has('service_tickets')) {
      throw new Error('Large technician-board query still sequentially scans service_tickets');
    }
  } finally {
    await client.query('ROLLBACK');
  }
};

const main = async (): Promise<void> => {
  const target = assertSafeSeedEnvironment(process.env);
  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    await verifySeedWorld(client);
    await verifyIndexCatalog(client);
    if (process.argv.includes('--sequence-proof')) await proveSequenceContinuity(client);
    if (process.argv.includes('--index-review')) await runIndexReview(client);
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown seed verification failure';
  console.error(
    `Seed verification failed: ${message.replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]')}`,
  );
  process.exitCode = 1;
});
