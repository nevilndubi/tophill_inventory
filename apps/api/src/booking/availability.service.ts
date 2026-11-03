import { Injectable } from '@nestjs/common';
import {
  AVAILABILITY_DETAIL_DAYS_MAX,
  AVAILABILITY_DETAIL_MINUTES_MIN,
  AVAILABILITY_SEARCH_HOURS_MAX,
  AVAILABILITY_SEARCH_PAST_TOLERANCE_MINUTES,
  candidateBlockedRange,
  validateBookingWindow,
  type AvailabilityBlock,
  type AvailabilityReason,
  type AvailabilitySearchQuery,
  type AvailabilitySearchResult,
  type BookingPolicyMachine,
  type BookingSettings,
  type EffectiveBookingPolicy,
  type MachineAvailability,
  type MachineAvailabilityQuery,
  type MachineCondition,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AvailabilityMachineNotFoundException,
  AvailabilityPolicyInvalidException,
  AvailabilityRangeInvalidException,
} from './availability.errors';
import { BookingPolicyService } from './booking-policy.service';

type DetailBooking = {
  blocked_until: string;
  ends_at: string;
  own: boolean;
  starts_at: string;
  status: 'CONFIRMED' | 'IN_PROGRESS' | 'PENDING';
};

type DetailRow = {
  allow_booking_when_needs_service: boolean;
  as_of: Date;
  asset_tag: string;
  bookings: DetailBooking[];
  buffer_minutes: number | null;
  category: { id: string; name: string };
  condition: MachineCondition;
  default_max_booking_minutes: number | null;
  department: { code: string; id: string; name: string };
  id: string;
  is_bookable: boolean;
  location: { id: string; name: string };
  max_booking_minutes: number | null;
  name: string;
  open_session: null | {
    expected_end_at: string | null;
    own: boolean;
    started_at: string;
  };
  requires_approval: boolean;
};

type SearchRow = {
  asOf: Date;
  invalidPolicyCount: number;
  items: Array<{
    asset_tag: string;
    category: { id: string; name: string };
    department: { code: string; id: string; name: string };
    effective_buffer_minutes: number;
    id: string;
    location: { id: string; name: string };
    name: string;
    requires_approval: boolean;
  }>;
  total: number;
};

type Interval = { end: number; start: number };
type Transaction = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | 'appSetting'>;

const MINUTE = 60_000;
const DAY = 86_400_000;

const placeholder = (parameters: unknown[], value: unknown): string => {
  parameters.push(value);
  return `$${parameters.length}`;
};

const overlap = (left: Interval, right: Interval): boolean =>
  left.start < right.end && left.end > right.start;

export const coalesceIntervals = (intervals: readonly Interval[]): Interval[] => {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const interval of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || interval.start > previous.end) {
      result.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return result;
};

export const subtractIntervals = (range: Interval, blocks: readonly Interval[]): Interval[] => {
  const free: Interval[] = [];
  let cursor = range.start;
  for (const block of coalesceIntervals(blocks)) {
    const start = Math.max(block.start, range.start);
    const end = Math.min(block.end, range.end);
    if (end <= range.start || start >= range.end) continue;
    if (start > cursor) free.push({ end: start, start: cursor });
    cursor = Math.max(cursor, end);
  }
  if (cursor < range.end) free.push({ end: range.end, start: cursor });
  return free;
};

const parseRange = (
  startValue: string,
  endValue: string,
  minimumMs: number,
  maximumMs: number,
): { end: Date; start: Date } => {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const duration = end.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AvailabilityRangeInvalidException('END_NOT_AFTER_START');
  }
  if (duration < minimumMs) throw new AvailabilityRangeInvalidException('RANGE_TOO_SHORT');
  if (duration > maximumMs) throw new AvailabilityRangeInvalidException('RANGE_TOO_LARGE');
  return { end, start };
};

const machineForPolicy = (row: DetailRow): BookingPolicyMachine => ({
  allowBookingWhenNeedsService: row.allow_booking_when_needs_service,
  bufferMinutes: row.buffer_minutes,
  condition: row.condition,
  isBookable: row.is_bookable,
  maxBookingMinutes: row.max_booking_minutes,
  requiresApproval: row.requires_approval,
});

const intervalForBlock = (block: AvailabilityBlock): Interval =>
  block.type === 'BOOKING'
    ? { end: Date.parse(block.blocked_until), start: Date.parse(block.starts_at) }
    : { end: Date.parse(block.end), start: Date.parse(block.start) };

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: BookingPolicyService,
  ) {}

  async detail(
    actor: AuthenticatedUser,
    machineId: string,
    query: MachineAvailabilityQuery,
  ): Promise<MachineAvailability> {
    const range = parseRange(
      query.from,
      query.to,
      AVAILABILITY_DETAIL_MINUTES_MIN * MINUTE,
      AVAILABILITY_DETAIL_DAYS_MAX * DAY,
    );
    return this.prisma.$transaction(
      async (transaction) => {
        const settings = await this.policies.readSettings(transaction);
        const row = await this.queryDetail(transaction, actor.id, machineId, range);
        if (row === undefined) throw new AvailabilityMachineNotFoundException();
        const policy = this.policies.resolve(
          machineForPolicy(row),
          { defaultMaxBookingMinutes: row.default_max_booking_minutes },
          settings,
        );
        return this.mapDetail(row, policy, range);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async search(
    _actor: AuthenticatedUser,
    query: AvailabilitySearchQuery,
  ): Promise<AvailabilitySearchResult> {
    const range = parseRange(
      query.start,
      query.end,
      1,
      AVAILABILITY_SEARCH_HOURS_MAX * 60 * MINUTE,
    );
    return this.prisma.$transaction(
      async (transaction) => {
        const settings = await this.policies.readSettings(transaction);
        if (range.end.getTime() - range.start.getTime() < settings.minDurationMinutes * MINUTE) {
          throw new AvailabilityRangeInvalidException('BELOW_GLOBAL_MINIMUM_DURATION');
        }
        const result = await this.querySearch(transaction, query, range, settings);
        if (result.invalidPolicyCount > 0) throw new AvailabilityPolicyInvalidException();
        if (
          range.start.getTime() <
          result.asOf.getTime() - AVAILABILITY_SEARCH_PAST_TOLERANCE_MINUTES * MINUTE
        ) {
          throw new AvailabilityRangeInvalidException('START_IS_IN_THE_PAST');
        }
        for (const item of result.items) {
          candidateBlockedRange(range.start, range.end, item.effective_buffer_minutes);
        }
        return {
          as_of: result.asOf.toISOString(),
          items: result.items,
          meta: { page: query.page, page_size: query.page_size, total: result.total },
          range: {
            end: range.end.toISOString(),
            semantics: '[start,end)',
            start: range.start.toISOString(),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async queryDetail(
    transaction: Transaction,
    actorId: string,
    machineId: string,
    range: { end: Date; start: Date },
  ): Promise<DetailRow | undefined> {
    const rows = await transaction.$queryRawUnsafe<DetailRow[]>(
      `
      WITH request_clock AS MATERIALIZED (SELECT statement_timestamp() AS as_of)
      SELECT
        clock.as_of,
        m.id, m.asset_tag, m.name, m.condition::text AS condition,
        m.is_bookable, m.requires_approval, m.allow_booking_when_needs_service,
        m.max_booking_minutes, m.buffer_minutes,
        category.default_max_booking_minutes,
        jsonb_build_object('id', category.id, 'name', category.name) AS category,
        jsonb_build_object('id', department.id, 'name', department.name, 'code', department.code) AS department,
        jsonb_build_object('id', location.id, 'name', location.name) AS location,
        COALESCE(bookings.items, '[]'::jsonb) AS bookings,
        CASE WHEN session.id IS NULL THEN NULL ELSE jsonb_build_object(
          'started_at', session.started_at,
          'expected_end_at', session.expected_end_at,
          'own', session.user_id = $2::uuid
        ) END AS open_session
      FROM machines m
      CROSS JOIN request_clock clock
      JOIN machine_categories category ON category.id = m.category_id
      JOIN departments department ON department.id = m.department_id
      JOIN locations location ON location.id = m.location_id
      LEFT JOIN usage_sessions session ON session.machine_id = m.id AND session.ended_at IS NULL
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'starts_at', b.starts_at,
          'ends_at', b.ends_at,
          'blocked_until', b.blocked_until,
          'status', b.status::text,
          'own', b.requested_by_user_id = $2::uuid
        ) ORDER BY b.starts_at, b.id) AS items
        FROM bookings b
        WHERE b.machine_id = m.id
          AND b.status IN ('PENDING'::booking_status, 'CONFIRMED'::booking_status, 'IN_PROGRESS'::booking_status)
          AND b.starts_at < $4::timestamptz + interval '1440 minutes'
          AND b.blocked_until > $3::timestamptz
      ) bookings ON TRUE
      WHERE m.id = $1::uuid AND m.deleted_at IS NULL
      `,
      machineId,
      actorId,
      range.start,
      range.end,
    );
    return rows[0];
  }

  private mapDetail(
    row: DetailRow,
    policy: EffectiveBookingPolicy,
    range: { end: Date; start: Date },
  ): MachineAvailability {
    const now = row.as_of;
    const blocks: AvailabilityBlock[] = row.bookings.map((booking) => ({
      blocked_until: booking.blocked_until,
      buffer_minutes: Math.max(
        0,
        Math.round((Date.parse(booking.blocked_until) - Date.parse(booking.ends_at)) / MINUTE),
      ),
      ends_at: booking.ends_at,
      own: booking.own,
      reason: 'ACTIVE_BOOKING',
      starts_at: booking.starts_at,
      status: booking.status,
      type: 'BOOKING',
    }));
    if (row.open_session !== null) {
      const expected =
        row.open_session.expected_end_at === null
          ? null
          : new Date(row.open_session.expected_end_at);
      const estimated = expected === null || expected <= now;
      blocks.push({
        end: (estimated
          ? new Date(now.getTime() + policy.maxDurationMinutes.value * MINUTE)
          : expected
        ).toISOString(),
        estimated,
        own: row.open_session.own,
        reason: 'OPEN_SESSION',
        start: now.toISOString(),
        type: 'USAGE',
      });
    }

    const reasons: AvailabilityReason[] = [];
    if (!policy.bookable.value) {
      const reason =
        policy.bookable.reason === 'NOT_ENABLED'
          ? ('MACHINE_NOT_BOOKABLE' as const)
          : ('CONDITION_NOT_BOOKABLE' as const);
      blocks.push({
        end: range.end.toISOString(),
        reason,
        start: range.start.toISOString(),
        type: 'POLICY',
      });
      reasons.push(reason);
    }

    const leadBoundary = new Date(now.getTime() + policy.minLeadMinutes.value * MINUTE);
    if (range.start < leadBoundary) {
      blocks.push({
        end: new Date(Math.min(range.end.getTime(), leadBoundary.getTime())).toISOString(),
        reason: 'BEFORE_LEAD_TIME',
        start: range.start.toISOString(),
        type: 'POLICY',
      });
      reasons.push('BEFORE_LEAD_TIME');
    }
    const advanceBoundary = new Date(now.getTime() + policy.maxAdvanceDays.value * DAY);
    if (range.end.getTime() > advanceBoundary.getTime() + 1) {
      blocks.push({
        end: range.end.toISOString(),
        reason: 'BEYOND_ADVANCE_WINDOW',
        start: new Date(
          Math.max(range.start.getTime(), advanceBoundary.getTime() + 1),
        ).toISOString(),
        type: 'POLICY',
      });
      reasons.push('BEYOND_ADVANCE_WINDOW');
    }

    const requested = { end: range.end.getTime(), start: range.start.getTime() };
    const free = subtractIntervals(requested, blocks.map(intervalForBlock));
    const candidate = candidateBlockedRange(range.start, range.end, policy.bufferMinutes.value);
    const bookingWindow = validateBookingWindow(policy, range.start, range.end, now);
    if (!bookingWindow.ok && bookingWindow.code === 'POLICY_INVALID') {
      throw new AvailabilityPolicyInvalidException();
    }
    const candidateInterval = { end: candidate.end.getTime(), start: candidate.start.getTime() };
    const hasFactConflict = blocks
      .filter((block) => block.type !== 'POLICY')
      .some((block) => overlap(candidateInterval, intervalForBlock(block)));

    return {
      as_of: now.toISOString(),
      available_for_entire_range: bookingWindow.ok && !hasFactConflict,
      blocks,
      free_windows: free.map((window) => ({
        end: new Date(window.end).toISOString(),
        start: new Date(window.start).toISOString(),
      })),
      machine: {
        asset_tag: row.asset_tag,
        category: row.category,
        department: row.department,
        id: row.id,
        location: row.location,
        name: row.name,
      },
      policy: {
        bookable: policy.bookable.value,
        effective_buffer_minutes: policy.bufferMinutes.value,
        max_duration_minutes: policy.maxDurationMinutes.value,
        min_duration_minutes: policy.minDurationMinutes.value,
        requires_approval: policy.requiresApproval.value,
        sources: {
          buffer: policy.bufferMinutes.source,
          max_duration: policy.maxDurationMinutes.source,
        },
      },
      range: {
        end: range.end.toISOString(),
        semantics: '[start,end)',
        start: range.start.toISOString(),
      },
      reasons: [...new Set(reasons)],
    };
  }

  private async querySearch(
    transaction: Transaction,
    query: AvailabilitySearchQuery,
    range: { end: Date; start: Date },
    settings: BookingSettings,
  ): Promise<SearchRow> {
    const parameters: unknown[] = [
      range.start,
      range.end,
      settings.defaultBufferMinutes,
      settings.maxDurationMinutes,
      settings.minDurationMinutes,
      settings.minLeadMinutes,
      settings.maxAdvanceDays,
    ];
    const filters = ['m.deleted_at IS NULL', 'm.created_at <= clock.as_of'];
    if (query.category_id !== undefined) {
      filters.push(`m.category_id = ${placeholder(parameters, query.category_id)}::uuid`);
    }
    if (query.department_id !== undefined) {
      filters.push(`m.department_id = ${placeholder(parameters, query.department_id)}::uuid`);
    }
    const limit = placeholder(parameters, query.page_size);
    const offset = placeholder(parameters, (query.page - 1) * query.page_size);
    const sql = `
      WITH request_clock AS MATERIALIZED (SELECT statement_timestamp() AS as_of),
      policy_rows AS MATERIALIZED (
        SELECT m.*, category.name AS category_name,
          category.default_max_booking_minutes,
          department.name AS department_name, department.code AS department_code,
          location.name AS location_name,
          COALESCE(m.buffer_minutes, $3::int) AS effective_buffer,
          COALESCE(m.max_booking_minutes, category.default_max_booking_minutes, $4::int) AS effective_max
        FROM machines m
        CROSS JOIN request_clock clock
        JOIN machine_categories category ON category.id = m.category_id
        JOIN departments department ON department.id = m.department_id
        JOIN locations location ON location.id = m.location_id
        WHERE ${filters.join(' AND ')}
      ),
      eligible AS MATERIALIZED (
        SELECT p.*
        FROM policy_rows p
        CROSS JOIN request_clock clock
        WHERE p.is_bookable
          AND (p.condition = 'OPERATIONAL'::machine_condition
            OR (p.condition = 'NEEDS_SERVICE'::machine_condition AND p.allow_booking_when_needs_service))
          AND ($2::timestamptz - $1::timestamptz) >= ($5::int * interval '1 minute')
          AND ($2::timestamptz - $1::timestamptz) <= (p.effective_max * interval '1 minute')
          AND $1::timestamptz >= clock.as_of + ($6::int * interval '1 minute')
          AND $1::timestamptz <= clock.as_of + ($7::int * interval '1 day')
          AND date_trunc('minute', $1::timestamptz) = $1::timestamptz
          AND date_trunc('minute', $2::timestamptz) = $2::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.machine_id = p.id
              AND b.status IN ('PENDING'::booking_status, 'CONFIRMED'::booking_status, 'IN_PROGRESS'::booking_status)
              AND b.starts_at < $2::timestamptz + (p.effective_buffer * interval '1 minute')
              AND b.blocked_until > $1::timestamptz
          )
          AND NOT EXISTS (
            SELECT 1 FROM usage_sessions session
            WHERE session.machine_id = p.id AND session.ended_at IS NULL
              AND clock.as_of < $2::timestamptz + (p.effective_buffer * interval '1 minute')
              AND CASE
                WHEN session.expected_end_at > clock.as_of THEN session.expected_end_at
                ELSE clock.as_of + (p.effective_max * interval '1 minute')
              END > $1::timestamptz
          )
      ),
      paged AS (
        SELECT e.*, row_number() OVER (ORDER BY e.asset_tag, e.id) AS ordinal
        FROM eligible e ORDER BY e.asset_tag, e.id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT clock.as_of AS "asOf",
        (SELECT COUNT(*)::int FROM eligible) AS total,
        (SELECT COUNT(*)::int FROM policy_rows
          WHERE effective_buffer NOT BETWEEN 0 AND 240
            OR effective_max NOT BETWEEN 5 AND 1440 OR effective_max < $5::int) AS "invalidPolicyCount",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', p.id, 'asset_tag', p.asset_tag, 'name', p.name,
          'category', jsonb_build_object('id', p.category_id, 'name', p.category_name),
          'department', jsonb_build_object('id', p.department_id, 'name', p.department_name, 'code', p.department_code),
          'location', jsonb_build_object('id', p.location_id, 'name', p.location_name),
          'effective_buffer_minutes', p.effective_buffer,
          'requires_approval', p.requires_approval
        ) ORDER BY p.ordinal) FROM paged p), '[]'::jsonb) AS items
      FROM request_clock clock
    `;
    const rows = await transaction.$queryRawUnsafe<SearchRow[]>(sql, ...parameters);
    const result = rows[0];
    if (result === undefined) throw new Error('Availability search returned no result');
    return result;
  }
}
