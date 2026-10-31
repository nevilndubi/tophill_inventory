import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { AttachmentEntityType, PrismaClient, Role } from '../../src/generated/prisma/client';
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

const DEFAULT_SETTINGS_INSERT = `
  INSERT INTO app_settings (key, value)
  VALUES
    ('booking.max_duration_minutes', '240'::jsonb),
    ('booking.min_lead_minutes', '15'::jsonb),
    ('booking.no_show_grace_minutes', '15'::jsonb),
    ('checkout.adhoc_guard_minutes', '30'::jsonb),
    ('booking.max_advance_days', '60'::jsonb),
    ('booking.min_duration_minutes', '15'::jsonb),
    ('booking.default_buffer_minutes', '0'::jsonb)
  ON CONFLICT (key) DO NOTHING
`;

describe('Support tables database integration', () => {
  const integration = assertSafeIntegrationDatabaseEnvironment(process.env);
  const runId = `t16-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const settingKey = `test.${runId.replaceAll('-', '_')}.limit`;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: integration.url, max: 8 }),
  });
  const sql = new Pool({ connectionString: integration.url, max: 4 });

  let userId = '';
  let auditActorUserId = '';
  let auditLogId = '';

  const insertAuditLog = (
    overrides: {
      action?: string;
      actorUserId?: string | null;
      after?: unknown;
      before?: unknown;
      entityId?: string;
      entityType?: string;
      requestId?: string;
    } = {},
  ) =>
    sql.query(
      `INSERT INTO audit_logs
        (actor_user_id, action, entity_type, entity_id, before, after, ip, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '127.0.0.1', $7)
       RETURNING id`,
      [
        overrides.actorUserId === undefined ? auditActorUserId : overrides.actorUserId,
        overrides.action ?? 'machine.updated',
        overrides.entityType ?? 'machine',
        overrides.entityId ?? randomUUID(),
        JSON.stringify(overrides.before ?? { name: 'Before' }),
        JSON.stringify(overrides.after ?? { name: 'After' }),
        overrides.requestId ?? `${runId}-request`,
      ],
    );

  const insertNotification = (
    overrides: {
      body?: string;
      createdAt?: Date;
      emailedAt?: Date | null;
      entityId?: string | null;
      entityType?: string | null;
      readAt?: Date | null;
      title?: string;
      type?: string;
    } = {},
  ) =>
    sql.query(
      `INSERT INTO notifications
        (user_id, type, title, body, entity_type, entity_id, read_at, emailed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        overrides.type ?? 'booking.cancelled',
        overrides.title ?? `${runId} notification`,
        overrides.body ?? `${runId} notification body`,
        overrides.entityType === undefined ? 'booking' : overrides.entityType,
        overrides.entityId === undefined ? randomUUID() : overrides.entityId,
        overrides.readAt ?? null,
        overrides.emailedAt ?? null,
        overrides.createdAt ?? new Date('2035-01-01T08:00:00.000Z'),
      ],
    );

  const insertAttachment = (
    overrides: {
      entityType?: AttachmentEntityType;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      storagePath?: string;
    } = {},
  ) =>
    sql.query(
      `INSERT INTO attachments
        (entity_type, entity_id, storage_path, file_name, mime_type, size_bytes, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        overrides.entityType ?? AttachmentEntityType.MACHINE,
        randomUUID(),
        overrides.storagePath ?? `${runId}/${randomUUID()}`,
        overrides.fileName ?? 'manual.pdf',
        overrides.mimeType ?? 'application/pdf',
        overrides.sizeBytes ?? 1024,
        userId,
      ],
    );

  beforeAll(async () => {
    await prisma.$connect();

    const [user, auditActor] = await Promise.all([
      prisma.user.create({
        data: {
          email: `${runId}-user@example.com`,
          fullName: 'Task 1.6 Support User',
          role: Role.STAFF,
          supabaseUserId: randomUUID(),
        },
      }),
      prisma.user.create({
        data: {
          email: `${runId}-audit@example.com`,
          fullName: 'Task 1.6 Audit Actor',
          role: Role.ADMIN,
          supabaseUserId: randomUUID(),
        },
      }),
    ]);

    userId = user.id;
    auditActorUserId = auditActor.id;
  });

  afterAll(async () => {
    try {
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.notificationPreference.deleteMany({ where: { userId } });
      await prisma.attachment.deleteMany({ where: { uploadedByUserId: userId } });
      await prisma.appSetting.deleteMany({ where: { key: settingKey } });
      await prisma.user.deleteMany({ where: { id: userId } });
      // Audit rows and their actor deliberately remain until the disposable branch is deleted.
      // Bypassing the append-only trigger with TRUNCATE would weaken this proof.
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });

  it('stores and reads every support model, relation, JSONB value and default', async () => {
    const auditResult = await insertAuditLog();
    auditLogId = (auditResult.rows[0] as { id: string }).id;

    const notification = await prisma.notification.create({
      data: {
        body: `${runId} booking was cancelled`,
        entityId: randomUUID(),
        entityType: 'booking',
        title: 'Booking cancelled',
        type: 'booking.cancelled',
        userId,
      },
    });
    const preference = await prisma.notificationPreference.create({
      data: { type: 'booking.cancelled', userId },
    });
    const machineAttachment = await prisma.attachment.create({
      data: {
        entityId: randomUUID(),
        entityType: AttachmentEntityType.MACHINE,
        fileName: 'machine.webp',
        mimeType: 'image/webp',
        sizeBytes: 2048,
        storagePath: `${runId}/machine.webp`,
        uploadedByUserId: userId,
      },
    });
    const ticketAttachment = await prisma.attachment.create({
      data: {
        entityId: randomUUID(),
        entityType: AttachmentEntityType.TICKET,
        fileName: 'ticket.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        storagePath: `${runId}/ticket.pdf`,
        uploadedByUserId: userId,
      },
    });
    const setting = await prisma.appSetting.create({
      data: { key: settingKey, value: { minutes: 45 } },
    });

    const storedAudit = await prisma.auditLog.findUniqueOrThrow({
      include: { actorUser: true },
      where: { id: auditLogId },
    });
    const storedUser = await prisma.user.findUniqueOrThrow({
      include: {
        notificationPreferences: true,
        notifications: true,
        uploadedAttachments: true,
      },
      where: { id: userId },
    });

    expect(storedAudit.actorUser?.id).toBe(auditActorUserId);
    expect(storedAudit.before).toEqual({ name: 'Before' });
    expect(storedAudit.after).toEqual({ name: 'After' });
    expect(storedAudit.ip).toBe('127.0.0.1');
    expect(storedUser.notifications.map(({ id }) => id)).toContain(notification.id);
    expect(storedUser.notificationPreferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: true, inApp: true, type: 'booking.cancelled' }),
      ]),
    );
    expect(storedUser.uploadedAttachments.map(({ id }) => id)).toEqual(
      expect.arrayContaining([machineAttachment.id, ticketAttachment.id]),
    );
    expect(preference.email).toBe(true);
    expect(preference.inApp).toBe(true);
    expect(setting.value).toEqual({ minutes: 45 });

    await pauseForTimestampPrecision();
    const [updatedNotification, updatedPreference, updatedAttachment, updatedSetting] =
      await Promise.all([
        prisma.notification.update({
          data: { body: `${runId} updated body` },
          where: { id: notification.id },
        }),
        prisma.notificationPreference.update({
          data: { email: false },
          where: { userId_type: { type: preference.type, userId } },
        }),
        prisma.attachment.update({
          data: { fileName: 'machine-updated.webp' },
          where: { id: machineAttachment.id },
        }),
        prisma.appSetting.update({
          data: { value: { minutes: 60 } },
          where: { key: settingKey },
        }),
      ]);

    expect(updatedNotification.updatedAt.getTime()).toBeGreaterThan(
      notification.updatedAt.getTime(),
    );
    expect(updatedPreference.updatedAt.getTime()).toBeGreaterThan(preference.updatedAt.getTime());
    expect(updatedAttachment.updatedAt.getTime()).toBeGreaterThan(
      machineAttachment.updatedAt.getTime(),
    );
    expect(updatedSetting.updatedAt.getTime()).toBeGreaterThan(setting.updatedAt.getTime());
  });

  it('keeps audit logs append-only and permits nullable system actors', async () => {
    const systemResult = await insertAuditLog({
      action: 'booking.cancelled',
      actorUserId: null,
      entityType: 'booking',
    });
    const systemLogId = (systemResult.rows[0] as { id: string }).id;
    const systemLog = await prisma.auditLog.findUniqueOrThrow({ where: { id: systemLogId } });
    expect(systemLog.actorUserId).toBeNull();

    await expectPostgresError(
      sql.query('UPDATE audit_logs SET action = $1 WHERE id = $2', ['machine.created', auditLogId]),
      '55000',
    );
    await expectPostgresError(
      sql.query('DELETE FROM audit_logs WHERE id = $1', [auditLogId]),
      '55000',
    );
    await expectPostgresError(
      sql.query('DELETE FROM users WHERE id = $1', [auditActorUserId]),
      '23001',
      'audit_logs_actor_user_id_fkey',
    );
  });

  it('enforces audit identifier, JSON shape and payload-size constraints', async () => {
    await expectPostgresError(
      insertAuditLog({ action: 'Machine Updated' }),
      '23514',
      'audit_logs_action_format_check',
    );
    await expectPostgresError(
      insertAuditLog({ entityType: 'Machine' }),
      '23514',
      'audit_logs_entity_type_format_check',
    );
    await expectPostgresError(
      insertAuditLog({ entityId: '   ' }),
      '23514',
      'audit_logs_entity_id_length_check',
    );
    await expectPostgresError(
      insertAuditLog({ requestId: '' }),
      '23514',
      'audit_logs_request_id_length_check',
    );
    await expectPostgresError(
      insertAuditLog({ before: ['not', 'an', 'object'] }),
      '23514',
      'audit_logs_before_object_check',
    );
    await expectPostgresError(
      insertAuditLog({ after: 'not an object' }),
      '23514',
      'audit_logs_after_object_check',
    );
    await expectPostgresError(
      insertAuditLog({ after: { payload: 'x'.repeat(70_000) } }),
      '23514',
      'audit_logs_payload_size_check',
    );
  });

  it('enforces notification type, text, reference and timestamp invariants', async () => {
    const createdAt = new Date('2035-01-01T08:00:00.000Z');
    const beforeCreated = new Date(createdAt.getTime() - 1);

    await expectPostgresError(
      insertNotification({ type: 'Booking Cancelled' }),
      '23514',
      'notifications_type_format_check',
    );
    await expectPostgresError(
      insertNotification({ title: '   ' }),
      '23514',
      'notifications_title_length_check',
    );
    await expectPostgresError(
      insertNotification({ body: 'x'.repeat(4001) }),
      '23514',
      'notifications_body_length_check',
    );
    await expectPostgresError(
      insertNotification({ entityId: null, entityType: 'booking' }),
      '23514',
      'notifications_entity_reference_pair_check',
    );
    await expectPostgresError(
      insertNotification({ entityId: randomUUID(), entityType: 'Booking' }),
      '23514',
      'notifications_entity_type_format_check',
    );
    await expectPostgresError(
      insertNotification({ createdAt, readAt: beforeCreated }),
      '23514',
      'notifications_read_at_order_check',
    );
    await expectPostgresError(
      insertNotification({ createdAt, emailedAt: beforeCreated }),
      '23514',
      'notifications_emailed_at_order_check',
    );
  });

  it('uses a composite preference key with true delivery defaults', async () => {
    const type = `test.${runId.replaceAll('-', '_')}`;
    const inserted = await sql.query<{ email: boolean; in_app: boolean }>(
      `INSERT INTO notification_preferences (user_id, type)
       VALUES ($1, $2)
       RETURNING in_app, email`,
      [userId, type],
    );
    expect(inserted.rows[0]).toEqual({ email: true, in_app: true });

    await expectPostgresError(
      sql.query('INSERT INTO notification_preferences (user_id, type) VALUES ($1, $2)', [
        userId,
        type,
      ]),
      '23505',
      'notification_preferences_pkey',
    );
    await expectPostgresError(
      sql.query('INSERT INTO notification_preferences (user_id, type) VALUES ($1, $2)', [
        userId,
        'INVALID',
      ]),
      '23514',
      'notification_preferences_type_format_check',
    );
  });

  it('enforces attachment enum, metadata, size, MIME and permanent storage-path rules', async () => {
    const enumRows = await sql.query<{ enumlabel: string }>(
      `SELECT enum_value.enumlabel
       FROM pg_type AS enum_type
       JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
       WHERE enum_type.typname = 'attachment_entity_type'
       ORDER BY enum_value.enumsortorder`,
    );
    expect(enumRows.rows.map(({ enumlabel }) => enumlabel)).toEqual(['MACHINE', 'TICKET']);

    await expectPostgresError(
      insertAttachment({ storagePath: '   ' }),
      '23514',
      'attachments_storage_path_length_check',
    );
    await expectPostgresError(
      insertAttachment({ fileName: '' }),
      '23514',
      'attachments_file_name_length_check',
    );
    await expectPostgresError(
      insertAttachment({ mimeType: 'text/plain' }),
      '23514',
      'attachments_mime_type_allowed_check',
    );
    await expectPostgresError(
      insertAttachment({ sizeBytes: 0 }),
      '23514',
      'attachments_size_bytes_check',
    );
    await expectPostgresError(
      insertAttachment({ sizeBytes: 10_485_761 }),
      '23514',
      'attachments_size_bytes_check',
    );

    const path = `${runId}/unique.pdf`;
    await insertAttachment({ storagePath: path });
    await expectPostgresError(
      insertAttachment({ storagePath: path }),
      '23505',
      'attachments_storage_path_key',
    );

    const foreignKeys = await sql.query<{ constraint_name: string }>(
      `SELECT conname AS constraint_name
       FROM pg_constraint
       WHERE conrelid = 'attachments'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    expect(foreignKeys.rows.map(({ constraint_name }) => constraint_name)).toEqual([
      'attachments_uploaded_by_user_id_fkey',
    ]);
  });

  it('seeds stable settings idempotently without overwriting customization', async () => {
    const expected = new Map<string, number>([
      ['booking.max_duration_minutes', 240],
      ['booking.min_lead_minutes', 15],
      ['booking.no_show_grace_minutes', 15],
      ['checkout.adhoc_guard_minutes', 30],
      ['booking.max_advance_days', 60],
      ['booking.min_duration_minutes', 15],
      ['booking.default_buffer_minutes', 0],
    ]);
    const defaults = await prisma.appSetting.findMany({
      where: { key: { in: [...expected.keys()] } },
    });
    expect(defaults).toHaveLength(7);
    for (const setting of defaults) {
      expect(setting.value).toBe(expected.get(setting.key));
    }

    const client = await sql.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_settings SET value = '999'::jsonb WHERE key = 'booking.max_duration_minutes'`,
      );
      await client.query(DEFAULT_SETTINGS_INSERT);
      const customized = await client.query<{ value: number }>(
        `SELECT value FROM app_settings WHERE key = 'booking.max_duration_minutes'`,
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app_settings WHERE key = ANY($1::text[])`,
        [[...expected.keys()]],
      );
      expect(customized.rows[0]?.value).toBe(999);
      expect(count.rows[0]?.count).toBe('7');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('installs the inclusive machine booking-buffer range constraint', async () => {
    const constraints = await sql.query<{ constraint_name: string; definition: string }>(
      `SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'machines'::regclass
         AND conname = 'machines_buffer_minutes_range_check'`,
    );
    expect(constraints.rows).toHaveLength(1);
    expect(constraints.rows[0]?.definition).toMatch(/buffer_minutes >= 0/u);
    expect(constraints.rows[0]?.definition).toMatch(/buffer_minutes <= 240/u);
  });

  it('creates every stable index, timestamptz column and restrictive user relation', async () => {
    const indexes = await sql.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('audit_logs', 'notifications', 'attachments')`,
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'audit_logs_entity_type_entity_id_created_at_idx',
        'audit_logs_actor_user_id_created_at_idx',
        'audit_logs_created_at_idx',
        'notifications_user_id_read_at_idx',
        'notifications_unread_user_id_created_at_idx',
        'attachments_storage_path_key',
        'attachments_entity_type_entity_id_idx',
      ]),
    );

    const timestampColumns = await sql.query<{ datetime_precision: number; table_name: string }>(
      `SELECT table_name, datetime_precision
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (
           'audit_logs', 'notifications', 'notification_preferences', 'attachments', 'app_settings'
         )
         AND data_type = 'timestamp with time zone'`,
    );
    expect(timestampColumns.rows).toHaveLength(11);
    expect(timestampColumns.rows.every(({ datetime_precision }) => datetime_precision === 3)).toBe(
      true,
    );

    const userForeignKeys = await sql.query<{ constraint_name: string; delete_action: string }>(
      `SELECT constraint_name, delete_rule AS delete_action
       FROM information_schema.referential_constraints
       WHERE constraint_name IN (
         'audit_logs_actor_user_id_fkey',
         'notifications_user_id_fkey',
         'notification_preferences_user_id_fkey',
         'attachments_uploaded_by_user_id_fkey'
       )
       ORDER BY constraint_name`,
    );
    expect(userForeignKeys.rows).toHaveLength(4);
    expect(userForeignKeys.rows.every(({ delete_action }) => delete_action === 'RESTRICT')).toBe(
      true,
    );

    await expectPostgresError(sql.query('DELETE FROM users WHERE id = $1', [userId]), '23001');
  });
});
