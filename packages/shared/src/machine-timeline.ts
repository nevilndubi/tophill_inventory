import { z } from 'zod';
import type { MachineCondition, MachineStatusSource } from './machine-management';

export const MACHINE_TIMELINE_EVENT_KINDS = [
  'MACHINE_REGISTERED',
  'CONDITION_CHANGED',
  'USAGE_STARTED',
  'USAGE_ENDED',
] as const;

export type MachineTimelineEventKind = (typeof MACHINE_TIMELINE_EVENT_KINDS)[number];

const includeDeleted = z.preprocess((value) => (value === 'true' ? true : value), z.literal(true));

export const machineTimelineQuerySchema = z
  .object({
    include_deleted: includeDeleted.optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
    until: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type MachineTimelineQuery = z.infer<typeof machineTimelineQuerySchema>;

type TimelineBase = {
  event_id: string;
  occurred_at: string;
};

export type MachineRegisteredTimelineEvent = TimelineBase & {
  actor: { full_name: string };
  kind: 'MACHINE_REGISTERED';
  reason: string;
  source: MachineStatusSource;
  to_condition: MachineCondition;
};

export type ConditionChangedTimelineEvent = TimelineBase & {
  actor: { full_name: string };
  from_condition: MachineCondition;
  kind: 'CONDITION_CHANGED';
  reason: string;
  source: MachineStatusSource;
  to_condition: MachineCondition;
};

export type UsageStartedTimelineEvent = TimelineBase & {
  expected_end_at: string | null;
  holder: { full_name: string };
  is_open: boolean;
  kind: 'USAGE_STARTED';
  purpose: string;
  session_id: string;
  started_at: string;
};

export type UsageEndedTimelineEvent = TimelineBase & {
  duration_seconds: number;
  end_note: string | null;
  ended_at: string;
  ending_actor: { full_name: string } | null;
  expected_end_at: string | null;
  forced: boolean;
  holder: { full_name: string };
  kind: 'USAGE_ENDED';
  overdue_at_end: boolean;
  purpose: string;
  session_id: string;
  started_at: string;
};

export type MachineTimelineEvent =
  | MachineRegisteredTimelineEvent
  | ConditionChangedTimelineEvent
  | UsageStartedTimelineEvent
  | UsageEndedTimelineEvent;

export type MachineTimelinePage = {
  as_of: string;
  items: readonly MachineTimelineEvent[];
  page: number;
  page_size: number;
  total: number;
  until: string;
};
