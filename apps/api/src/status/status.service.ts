import { Injectable } from '@nestjs/common';
import {
  DISPLAY_STATUSES,
  isMachineUsable,
  type DisplayStatus,
  type MachineCondition,
  type MachineLiveStatus,
  type MachineStatusBoard,
  type MachineStatusCounts,
  type StatusBoardQuery,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MachineNotFoundException } from '../machines/machines.errors';
import { PrismaService } from '../prisma/prisma.service';

type QueryItem = {
  allow_booking_when_needs_service: boolean;
  asset_tag: string;
  category: { id: string; name: string };
  department: { code: string; id: string; name: string };
  display_status: DisplayStatus;
  id: string;
  location: { id: string; name: string };
  name: string;
  next_booking_at: string | null;
  open_session: {
    expected_end_at: string | null;
    holder: { full_name: string; id: string };
    id: string;
    started_at: string;
  } | null;
  service_due: boolean;
  stored_condition: MachineCondition;
};

type QueryResult = {
  asOf: Date;
  counts: Record<string, number>;
  items: QueryItem[];
  total: number;
};

type QueryOptions = StatusBoardQuery & { machineId?: string };

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/gu, '\\$&');

const emptyCounts = (): MachineStatusCounts =>
  Object.fromEntries(DISPLAY_STATUSES.map((status) => [status, 0])) as MachineStatusCounts;

const sqlPlaceholder = (parameters: unknown[], value: unknown): string => {
  parameters.push(value);
  return `$${parameters.length}`;
};

const orderClause = (sort: StatusBoardQuery['sort'], order: StatusBoardQuery['order']): string => {
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  if (sort === 'name') {
    return `LOWER(name) ${direction}, asset_tag ${direction}, id ${direction}`;
  }
  if (sort === 'status') {
    return `status_rank ${direction}, asset_tag ${direction}, id ${direction}`;
  }
  return `asset_tag ${direction}, id ${direction}`;
};

@Injectable()
export class StatusService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: AuthenticatedUser, machineId: string): Promise<MachineLiveStatus> {
    const board = await this.query(actor, {
      machineId,
      order: 'asc',
      page: 1,
      page_size: 1,
      sort: 'asset_tag',
    });
    const status = board.items[0];
    if (status === undefined) throw new MachineNotFoundException();
    return status;
  }

  board(actor: AuthenticatedUser, query: StatusBoardQuery): Promise<MachineStatusBoard> {
    return this.query(actor, query);
  }

  private async query(
    actor: AuthenticatedUser,
    options: QueryOptions,
  ): Promise<MachineStatusBoard> {
    const parameters: unknown[] = [];
    const baseFilters = ['m.deleted_at IS NULL'];
    if (options.machineId !== undefined) {
      baseFilters.push(`m.id = ${sqlPlaceholder(parameters, options.machineId)}::uuid`);
    }
    if (options.department_id !== undefined) {
      baseFilters.push(
        `m.department_id = ${sqlPlaceholder(parameters, options.department_id)}::uuid`,
      );
    }
    if (options.category_id !== undefined) {
      baseFilters.push(`m.category_id = ${sqlPlaceholder(parameters, options.category_id)}::uuid`);
    }
    if (options.location_id !== undefined) {
      baseFilters.push(`m.location_id = ${sqlPlaceholder(parameters, options.location_id)}::uuid`);
    }
    if (options.q !== undefined) {
      const placeholder = sqlPlaceholder(parameters, `%${escapeLikePattern(options.q)}%`);
      baseFilters.push(
        `(m.name ILIKE ${placeholder} ESCAPE E'\\\\' OR m.asset_tag ILIKE ${placeholder} ESCAPE E'\\\\' OR m.serial_number ILIKE ${placeholder} ESCAPE E'\\\\')`,
      );
    }
    if (options.service_due === true) {
      baseFilters.push(
        `m.condition <> 'RETIRED'::machine_condition AND m.next_service_due_at IS NOT NULL AND m.next_service_due_at <= clock.as_of`,
      );
    }

    const statusFilters =
      options.status === undefined
        ? 'TRUE'
        : options.status
            .map((status) => `display_status = ${sqlPlaceholder(parameters, status)}::text`)
            .join(' OR ');
    const limit = sqlPlaceholder(parameters, options.page_size);
    const offset = sqlPlaceholder(parameters, (options.page - 1) * options.page_size);
    const sql = `
      WITH request_clock AS MATERIALIZED (
        SELECT statement_timestamp() AS as_of
      ),
      base AS MATERIALIZED (
        SELECT
          m.id,
          m.asset_tag,
          m.name,
          m.condition::text AS stored_condition,
          m.allow_booking_when_needs_service,
          jsonb_build_object('id', category.id, 'name', category.name) AS category,
          jsonb_build_object('id', department.id, 'name', department.name, 'code', department.code) AS department,
          jsonb_build_object('id', location.id, 'name', location.name) AS location,
          CASE
            WHEN m.condition = 'RETIRED'::machine_condition THEN 'RETIRED'
            WHEN m.condition = 'OUT_OF_SERVICE'::machine_condition THEN 'OUT_OF_SERVICE'
            WHEN m.condition = 'UNDER_MAINTENANCE'::machine_condition THEN 'UNDER_MAINTENANCE'
            WHEN open_session.id IS NOT NULL THEN 'IN_USE'
            WHEN m.condition = 'NEEDS_SERVICE'::machine_condition THEN 'AVAILABLE_NEEDS_SERVICE'
            ELSE 'AVAILABLE_OK'
          END AS display_status,
          CASE
            WHEN m.condition = 'RETIRED'::machine_condition THEN 1
            WHEN m.condition = 'OUT_OF_SERVICE'::machine_condition THEN 2
            WHEN m.condition = 'UNDER_MAINTENANCE'::machine_condition THEN 3
            WHEN open_session.id IS NOT NULL THEN 4
            WHEN m.condition = 'NEEDS_SERVICE'::machine_condition THEN 5
            ELSE 6
          END AS status_rank,
          CASE WHEN open_session.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', open_session.id,
            'holder', jsonb_build_object('id', holder.id, 'full_name', holder.full_name),
            'started_at', open_session.started_at,
            'expected_end_at', open_session.expected_end_at
          ) END AS open_session,
          next_booking.starts_at AS next_booking_at,
          (m.condition <> 'RETIRED'::machine_condition
            AND m.next_service_due_at IS NOT NULL
            AND m.next_service_due_at <= clock.as_of) AS service_due
        FROM machines m
        CROSS JOIN request_clock clock
        JOIN machine_categories category ON category.id = m.category_id
        JOIN departments department ON department.id = m.department_id
        JOIN locations location ON location.id = m.location_id
        LEFT JOIN usage_sessions open_session
          ON open_session.machine_id = m.id AND open_session.ended_at IS NULL
        LEFT JOIN users holder ON holder.id = open_session.user_id
        LEFT JOIN LATERAL (
          SELECT booking.starts_at
          FROM bookings booking
          WHERE booking.machine_id = m.id
            AND booking.status = 'CONFIRMED'::booking_status
            AND booking.starts_at > clock.as_of
          ORDER BY booking.starts_at ASC, booking.id ASC
          LIMIT 1
        ) next_booking ON TRUE
        WHERE ${baseFilters.join(' AND ')}
      ),
      status_filtered AS (
        SELECT * FROM base WHERE (${statusFilters})
      ),
      paged AS (
        SELECT ordered.*, row_number() OVER () AS ordinal
        FROM (
          SELECT * FROM status_filtered
          ORDER BY ${orderClause(options.sort, options.order)}
          LIMIT ${limit} OFFSET ${offset}
        ) ordered
      )
      SELECT
        clock.as_of AS "asOf",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', page.id,
            'asset_tag', page.asset_tag,
            'name', page.name,
            'stored_condition', page.stored_condition,
            'display_status', page.display_status,
            'allow_booking_when_needs_service', page.allow_booking_when_needs_service,
            'category', page.category,
            'department', page.department,
            'location', page.location,
            'open_session', page.open_session,
            'next_booking_at', page.next_booking_at,
            'service_due', page.service_due
          ) ORDER BY page.ordinal)
          FROM paged page
        ), '[]'::jsonb) AS items,
        (SELECT COUNT(*)::int FROM status_filtered) AS total,
        (SELECT jsonb_build_object(
          'RETIRED', COUNT(*) FILTER (WHERE display_status = 'RETIRED'),
          'OUT_OF_SERVICE', COUNT(*) FILTER (WHERE display_status = 'OUT_OF_SERVICE'),
          'UNDER_MAINTENANCE', COUNT(*) FILTER (WHERE display_status = 'UNDER_MAINTENANCE'),
          'IN_USE', COUNT(*) FILTER (WHERE display_status = 'IN_USE'),
          'AVAILABLE_NEEDS_SERVICE', COUNT(*) FILTER (WHERE display_status = 'AVAILABLE_NEEDS_SERVICE'),
          'AVAILABLE_OK', COUNT(*) FILTER (WHERE display_status = 'AVAILABLE_OK')
        ) FROM base) AS counts
      FROM request_clock clock
    `;

    const rows = await this.prisma.$queryRawUnsafe<QueryResult[]>(sql, ...parameters);
    const result = rows[0];
    if (result === undefined) throw new Error('Status query returned no result');
    const asOf = result.asOf.toISOString();
    const counts = { ...emptyCounts(), ...result.counts };
    return {
      as_of: asOf,
      counts,
      items: result.items.map((item) => {
        const session = item.open_session;
        return {
          as_of: asOf,
          asset_tag: item.asset_tag,
          category: item.category,
          department: item.department,
          display_status: item.display_status,
          id: item.id,
          location: item.location,
          name: item.name,
          next_booking_at: item.next_booking_at,
          open_session:
            session === null
              ? null
              : {
                  expected_end_at: session.expected_end_at,
                  held_by_current_user: session.holder.id === actor.id,
                  holder: session.holder,
                  id: session.id,
                  overdue:
                    session.expected_end_at !== null &&
                    new Date(session.expected_end_at).getTime() < result.asOf.getTime(),
                  started_at: session.started_at,
                },
          service_due: item.service_due,
          stored_condition: item.stored_condition,
          usable: isMachineUsable({
            allowBookingWhenNeedsService: item.allow_booking_when_needs_service,
            condition: item.stored_condition,
            hasOpenSession: session !== null,
          }),
        };
      }),
      page: options.page,
      page_size: options.page_size,
      total: result.total,
    };
  }
}
