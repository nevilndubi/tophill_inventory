import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  can,
  type MachineTimelineEvent,
  type MachineTimelinePage,
  type MachineTimelineQuery,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { PrismaService } from '../prisma/prisma.service';
import { MachineNotFoundException } from './machines.errors';

type TimelineQueryResult = {
  asOf: Date;
  cutoff: Date;
  duplicateEndingAudits: string[];
  futureUntil: boolean;
  items: MachineTimelineEvent[];
  machineFound: boolean;
  total: number;
};

@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(
    actor: AuthenticatedUser,
    machineId: string,
    query: MachineTimelineQuery,
  ): Promise<MachineTimelinePage> {
    const includeDeleted = query.include_deleted === true;
    if (includeDeleted && !can(actor.role, 'machine:restore')) {
      throw new PermissionDeniedException();
    }

    const offset = (query.page - 1) * query.page_size;
    const rows = await this.prisma.$queryRawUnsafe<TimelineQueryResult[]>(
      TIMELINE_SQL,
      machineId,
      includeDeleted,
      query.until ?? null,
      query.page_size,
      offset,
    );
    const result = rows[0];
    if (result === undefined) throw new Error('Timeline query returned no result');
    if (result.futureUntil) {
      throw new BadRequestException({
        code: 'TIMELINE_UNTIL_FUTURE',
        details: {},
        message: 'Timeline cutoff cannot be after the database time',
      });
    }
    if (!result.machineFound) throw new MachineNotFoundException();
    for (const sessionId of result.duplicateEndingAudits) {
      this.logger.warn(`Multiple ending audit rows found for usage session ${sessionId}`);
    }

    return {
      as_of: result.asOf.toISOString(),
      items: result.items,
      page: query.page,
      page_size: query.page_size,
      total: result.total,
      until: result.cutoff.toISOString(),
    };
  }
}

const TIMELINE_SQL = `
  WITH request_clock AS MATERIALIZED (
    SELECT statement_timestamp() AS as_of
  ),
  request_scope AS MATERIALIZED (
    SELECT
      clock.as_of,
      COALESCE($3::timestamptz, clock.as_of) AS cutoff,
      COALESCE($3::timestamptz, clock.as_of) > clock.as_of AS future_until,
      EXISTS (
        SELECT 1 FROM machines machine
        WHERE machine.id = $1::uuid
          AND ($2::boolean OR machine.deleted_at IS NULL)
      ) AS machine_found
    FROM request_clock clock
  ),
  ending_audits AS MATERIALIZED (
    SELECT
      audit.entity_id,
      audit.actor_user_id,
      COALESCE((audit.after #>> '{context,forced}')::boolean, false) AS forced,
      COUNT(*) OVER (PARTITION BY audit.entity_id)::int AS audit_count,
      ROW_NUMBER() OVER (
        PARTITION BY audit.entity_id ORDER BY audit.created_at ASC, audit.id ASC
      ) AS audit_order
    FROM audit_logs audit
    JOIN usage_sessions session ON session.id::text = audit.entity_id
    CROSS JOIN request_scope scope
    WHERE audit.entity_type = 'usage_session'
      AND audit.action IN ('usage.checked_in', 'usage.force_ended')
      AND session.machine_id = $1::uuid
      AND audit.created_at <= scope.cutoff
  ),
  timeline_events AS MATERIALIZED (
    SELECT
      CASE WHEN history.from_condition IS NULL
        THEN 'registered:' || history.id::text
        ELSE 'condition:' || history.id::text
      END AS event_id,
      history.created_at AS occurred_at,
      CASE WHEN history.from_condition IS NULL THEN 1 ELSE 3 END AS event_rank,
      history.id::text AS immutable_id,
      CASE WHEN history.from_condition IS NULL
        THEN jsonb_build_object(
          'event_id', 'registered:' || history.id::text,
          'kind', 'MACHINE_REGISTERED',
          'occurred_at', history.created_at,
          'to_condition', history.to_condition::text,
          'source', history.source::text,
          'reason', history.reason,
          'actor', jsonb_build_object('full_name', actor.full_name)
        )
        ELSE jsonb_build_object(
          'event_id', 'condition:' || history.id::text,
          'kind', 'CONDITION_CHANGED',
          'occurred_at', history.created_at,
          'from_condition', history.from_condition::text,
          'to_condition', history.to_condition::text,
          'source', history.source::text,
          'reason', history.reason,
          'actor', jsonb_build_object('full_name', actor.full_name)
        )
      END AS payload
    FROM machine_status_history history
    JOIN users actor ON actor.id = history.changed_by_user_id
    CROSS JOIN request_scope scope
    WHERE scope.machine_found
      AND history.machine_id = $1::uuid
      AND history.created_at <= scope.cutoff

    UNION ALL

    SELECT
      'usage-start:' || session.id::text,
      session.started_at,
      2,
      session.id::text,
      jsonb_build_object(
        'event_id', 'usage-start:' || session.id::text,
        'kind', 'USAGE_STARTED',
        'occurred_at', session.started_at,
        'session_id', session.id,
        'holder', jsonb_build_object('full_name', holder.full_name),
        'is_open', session.ended_at IS NULL,
        'started_at', session.started_at,
        'expected_end_at', session.expected_end_at,
        'purpose', session.purpose
      )
    FROM usage_sessions session
    JOIN users holder ON holder.id = session.user_id
    CROSS JOIN request_scope scope
    WHERE scope.machine_found
      AND session.machine_id = $1::uuid
      AND session.started_at <= scope.cutoff

    UNION ALL

    SELECT
      'usage-end:' || session.id::text,
      session.ended_at,
      4,
      session.id::text,
      jsonb_build_object(
        'event_id', 'usage-end:' || session.id::text,
        'kind', 'USAGE_ENDED',
        'occurred_at', session.ended_at,
        'session_id', session.id,
        'holder', jsonb_build_object('full_name', holder.full_name),
        'started_at', session.started_at,
        'expected_end_at', session.expected_end_at,
        'ended_at', session.ended_at,
        'duration_seconds', FLOOR(EXTRACT(EPOCH FROM (session.ended_at - session.started_at)))::int,
        'overdue_at_end', session.expected_end_at IS NOT NULL AND session.ended_at > session.expected_end_at,
        'purpose', session.purpose,
        'end_note', session.end_note,
        'forced', COALESCE(ending.forced, false),
        'ending_actor', CASE WHEN ending_actor.id IS NULL THEN NULL ELSE
          jsonb_build_object('full_name', ending_actor.full_name) END
      )
    FROM usage_sessions session
    JOIN users holder ON holder.id = session.user_id
    LEFT JOIN ending_audits ending
      ON ending.entity_id = session.id::text AND ending.audit_order = 1
    LEFT JOIN users ending_actor ON ending_actor.id = ending.actor_user_id
    CROSS JOIN request_scope scope
    WHERE scope.machine_found
      AND session.machine_id = $1::uuid
      AND session.ended_at IS NOT NULL
      AND session.ended_at <= scope.cutoff
  ),
  ordered_page AS (
    SELECT event.*, ROW_NUMBER() OVER () AS ordinal
    FROM (
      SELECT * FROM timeline_events
      ORDER BY occurred_at DESC, event_rank DESC, immutable_id DESC
      LIMIT $4::int OFFSET $5::int
    ) event
  )
  SELECT
    scope.as_of AS "asOf",
    scope.cutoff,
    scope.future_until AS "futureUntil",
    scope.machine_found AS "machineFound",
    COALESCE((SELECT jsonb_agg(page.payload ORDER BY page.ordinal) FROM ordered_page page), '[]'::jsonb) AS items,
    (SELECT COUNT(*)::int FROM timeline_events) AS total,
    COALESCE((
      SELECT jsonb_agg(DISTINCT ending.entity_id)
      FROM ending_audits ending WHERE ending.audit_count > 1
    ), '[]'::jsonb) AS "duplicateEndingAudits"
  FROM request_scope scope
`;
