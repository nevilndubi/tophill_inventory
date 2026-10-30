'use client';

import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MachineLiveStatus, MachineTimelineEvent, ManagedMachine } from '@app/shared';
import { Activity, ArrowRight, CircleCheck, LogIn, LogOut } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { machinesApi } from '@/lib/api/machines';
import { formatDuration, timelineStatusSignal } from '@/lib/machines/timeline';

const NAIROBI_FORMAT = new Intl.DateTimeFormat('en-KE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Nairobi',
});

const EVENT_LABELS = {
  CONDITION_CHANGED: 'Condition changed',
  MACHINE_REGISTERED: 'Machine registered',
  USAGE_ENDED: 'Usage ended',
  USAGE_STARTED: 'Usage started',
} as const;

const EventIcon = ({ event }: { event: MachineTimelineEvent }) => {
  const Icon =
    event.kind === 'MACHINE_REGISTERED'
      ? CircleCheck
      : event.kind === 'CONDITION_CHANGED'
        ? Activity
        : event.kind === 'USAGE_STARTED'
          ? LogOut
          : LogIn;
  return <Icon className="size-5" aria-hidden="true" />;
};

const EventDescription = ({ event }: { event: MachineTimelineEvent }) => {
  if (event.kind === 'MACHINE_REGISTERED') {
    return (
      <p>
        Registered as {event.to_condition.replaceAll('_', ' ').toLowerCase()} by{' '}
        {event.actor.full_name}. {event.reason}
      </p>
    );
  }
  if (event.kind === 'CONDITION_CHANGED') {
    return (
      <p>
        {event.from_condition.replaceAll('_', ' ')}{' '}
        <ArrowRight className="inline size-3" aria-hidden="true" />{' '}
        {event.to_condition.replaceAll('_', ' ')} by {event.actor.full_name}. {event.reason}
      </p>
    );
  }
  if (event.kind === 'USAGE_STARTED') {
    return (
      <p>
        Checked out by {event.holder.full_name} for {event.purpose}.{' '}
        {event.is_open ? 'Still in use. ' : ''}
        {event.expected_end_at
          ? `Expected back ${NAIROBI_FORMAT.format(new Date(event.expected_end_at))}.`
          : 'No expected end.'}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p>
        {event.ending_actor === null
          ? `Ended (ending user not recorded) after ${formatDuration(event.duration_seconds)}.`
          : `${event.forced ? 'Force-ended' : 'Checked in'} after ${formatDuration(event.duration_seconds)} by ${event.ending_actor.full_name}.`}
      </p>
      {event.overdue_at_end ? (
        <p className="font-medium text-status-out-of-service">Ended after the expected time.</p>
      ) : null}
      {event.end_note ? <p className="text-muted-foreground">{event.end_note}</p> : null}
    </div>
  );
};

export function MachineTimeline({
  machine,
  status,
}: {
  machine: ManagedMachine;
  status?: MachineLiveStatus;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const parsedPage = Number(searchParams.get('page') ?? '1');
  const parsedPageSize = Number(searchParams.get('page_size') ?? '50');
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = [25, 50, 100, 200].includes(parsedPageSize) ? parsedPageSize : 50;
  const [cutoff, setCutoff] = useState<string>();
  const [newActivity, setNewActivity] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const priorStatusSignal = useRef<string | undefined>(undefined);
  const timeline = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      machinesApi.timeline(machine.id, {
        includeDeleted: machine.registryStatus === 'DELETED',
        page,
        pageSize,
        ...(page > 1 && cutoff ? { until: cutoff } : {}),
      }),
    queryKey: [
      'machine-timeline',
      machine.id,
      { page, pageSize, cutoff: page > 1 ? cutoff : undefined },
    ],
  });

  useEffect(() => {
    const refresh = () => {
      if (
        document.visibilityState === 'visible' &&
        timeline.dataUpdatedAt > 0 &&
        Date.now() - timeline.dataUpdatedAt > 60_000
      ) {
        if (page === 1) void timeline.refetch();
        else setNewActivity(true);
      }
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [page, timeline]);

  useEffect(() => {
    if (!status) return;
    const statusSignal = timelineStatusSignal(status);
    if (priorStatusSignal.current === undefined) {
      priorStatusSignal.current = statusSignal;
      return;
    }
    if (priorStatusSignal.current === statusSignal) return;
    priorStatusSignal.current = statusSignal;
    if (page === 1) void timeline.refetch();
    else {
      const timer = window.setTimeout(() => setNewActivity(true), 0);
      return () => window.clearTimeout(timer);
    }
  }, [page, status, timeline]);

  const navigate = (nextPage: number, nextPageSize = pageSize) => {
    if (nextPage > 1 && timeline.data?.until) setCutoff(timeline.data.until);
    if (nextPage === 1) setCutoff(undefined);
    const values = new URLSearchParams(searchParams.toString());
    values.set('tab', 'history');
    if (nextPage === 1) values.delete('page');
    else values.set('page', String(nextPage));
    if (nextPageSize === 50) values.delete('page_size');
    else values.set('page_size', String(nextPageSize));
    router.replace(`${pathname}?${values}`, { scroll: false });
    window.setTimeout(() => heading.current?.focus(), 0);
  };

  if (timeline.isPending)
    return (
      <div aria-label="Loading activity" className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  if (timeline.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Activity unavailable</AlertTitle>
        <AlertDescription>Retry when the service is available.</AlertDescription>
        <Button className="mt-3" onClick={() => void timeline.refetch()}>
          Retry
        </Button>
      </Alert>
    );

  const data = timeline.data;
  const rangeEnd = Math.min(data.total, page * pageSize);
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>
            <h2 ref={heading} tabIndex={-1}>
              Machine activity
            </h2>
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Condition and usage events, newest first.
          </p>
        </div>
        {newActivity ? (
          <Button
            variant="outline"
            onClick={() => {
              setNewActivity(false);
              navigate(1);
              void timeline.refetch();
            }}
          >
            New activity — show latest
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {data.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No machine activity has been recorded.
          </p>
        ) : (
          <ol className="relative space-y-6 border-l pl-6" aria-label="Machine activity timeline">
            {data.items.map((event) => (
              <li key={event.event_id} className="min-w-0 break-words">
                <span className="absolute -left-3 flex size-6 items-center justify-center rounded-full border bg-background">
                  <EventIcon event={event} />
                </span>
                <h3 className="font-semibold">{EVENT_LABELS[event.kind]}</h3>
                <time className="text-xs text-muted-foreground" dateTime={event.occurred_at}>
                  {NAIROBI_FORMAT.format(new Date(event.occurred_at))}
                </time>
                <div className="mt-2 text-sm">
                  <EventDescription event={event} />
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-6 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            {data.total === 0
              ? 'No events'
              : `Showing ${(page - 1) * pageSize + 1} to ${rangeEnd} of ${data.total}`}
          </p>
          <div className="flex items-center gap-2">
            <label className="text-sm" htmlFor="timeline-page-size">
              Per page
            </label>
            <select
              id="timeline-page-size"
              className="h-9 rounded-md border bg-background px-2"
              value={pageSize}
              onChange={(event) => navigate(1, Number(event.target.value))}
            >
              {[25, 50, 100, 200].map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
            <Button variant="outline" disabled={page <= 1} onClick={() => navigate(page - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={rangeEnd >= data.total}
              onClick={() => navigate(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
