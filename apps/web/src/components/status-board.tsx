'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISPLAY_STATUSES,
  STATUS_BOARD_SORT_FIELDS,
  type DisplayStatus,
  type MachineLiveStatus,
} from '@app/shared';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Grid2X2,
  List,
  RefreshCw,
  Search,
  Stethoscope,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DisplayStatusBadge } from '@/components/display-status-badge';
import { MachineConditionBadge } from '@/components/machine-condition-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  MachineUsageActionDialog,
  MachineUsageQuickActions,
  type UsageActionKind,
} from '@/components/machine-usage-actions';
import { categoriesApi } from '@/lib/api/categories';
import { departmentsApi, locationsApi } from '@/lib/api/reference';
import { statusApi } from '@/lib/api/status';
import {
  STATUS_POLL_BASE_MS,
  STATUS_STALE_AFTER_MS,
  elapsedFromAsOf,
  hasClockSkew,
  statusPollDelay,
} from '@/lib/status/polling';
import {
  STATUS_BOARD_PAGE_SIZES,
  parseStatusBoardState,
  serializeStatusBoardState,
  toStatusApiQuery,
  type StatusBoardUrlState,
} from '@/lib/status/url-state';

const selectClass =
  'h-10 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

const NAIROBI_FORMAT = new Intl.DateTimeFormat('en-KE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Nairobi',
});

const formatTime = (value: string | null) =>
  value === null ? 'No expected end' : NAIROBI_FORMAT.format(new Date(value));

const relativeTime = (value: string, asOf: string, receivedAt: number, now: number): string => {
  const anchoredNow = Date.parse(asOf) + Math.max(0, now - receivedAt);
  const seconds = Math.round((Date.parse(value) - anchoredNow) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (absolute < 60) return formatter.format(seconds, 'second');
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), 'hour');
  return formatter.format(Math.round(seconds / 86_400), 'day');
};

function DebouncedSearch({
  initialValue,
  onSearch,
}: {
  initialValue: string;
  onSearch: (value?: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  useEffect(() => {
    const trimmed = draft.trim();
    const timer = window.setTimeout(() => {
      const next = trimmed.length >= 2 && trimmed.length <= 100 ? trimmed : undefined;
      if (next !== (initialValue || undefined)) onSearch(next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, initialValue, onSearch]);
  return (
    <div className="sm:col-span-2 xl:col-span-3">
      <label className="sr-only" htmlFor="status-search">
        Search status board
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="status-search"
          className="pl-9"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Machine name, asset tag, or serial number"
        />
      </div>
      {draft.trim().length === 1 ? (
        <p className="mt-1 text-xs text-muted-foreground">Enter at least 2 characters to search.</p>
      ) : null}
    </div>
  );
}

function StatusSummary({
  counts,
  selected,
  toggle,
}: {
  counts: Record<DisplayStatus, number>;
  selected: readonly DisplayStatus[];
  toggle: (status: DisplayStatus) => void;
}) {
  return (
    <section
      aria-label="Status summary"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
    >
      {DISPLAY_STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          aria-pressed={selected.includes(status)}
          onClick={() => toggle(status)}
          className="min-h-20 rounded-lg border bg-card p-3 text-left shadow-sm outline-none transition hover:border-primary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/20"
        >
          <DisplayStatusBadge status={status} />
          <span className="mt-2 block text-2xl font-semibold tabular-nums">{counts[status]}</span>
        </button>
      ))}
    </section>
  );
}

function MachineStatusSummary({
  machine,
  asOf,
  receivedAt,
  now,
}: {
  machine: MachineLiveStatus;
  asOf: string;
  receivedAt: number;
  now: number;
}) {
  const session = machine.open_session;
  const higherPrioritySession = session !== null && machine.display_status !== 'IN_USE';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <DisplayStatusBadge status={machine.display_status} />
        {machine.display_status === 'IN_USE' && machine.stored_condition !== 'OPERATIONAL' ? (
          <MachineConditionBadge condition={machine.stored_condition} />
        ) : null}
        {machine.service_due ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-status-needs-service">
            <Stethoscope className="size-3.5" aria-hidden="true" /> Service due
          </span>
        ) : null}
      </div>
      {session ? (
        <div
          className={
            higherPrioritySession
              ? 'rounded-md border border-status-out-of-service-border bg-status-out-of-service-bg p-2 text-sm'
              : 'text-sm'
          }
        >
          <p className={higherPrioritySession ? 'font-semibold' : undefined}>
            {higherPrioritySession ? 'Still checked out by ' : 'Checked out by '}
            {session.holder.full_name}{' '}
            <span className="text-muted-foreground">
              {relativeTime(session.started_at, asOf, receivedAt, now)}
            </span>
          </p>
          <p
            className={
              session.overdue ? 'font-medium text-status-out-of-service' : 'text-muted-foreground'
            }
          >
            {session.expected_end_at
              ? `${session.overdue ? 'Overdue' : 'Expected end'} ${relativeTime(session.expected_end_at, asOf, receivedAt, now)}`
              : 'No expected end'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

type ActionKind = UsageActionKind;
const UsageActionDialog = MachineUsageActionDialog;
const QuickActions = MachineUsageQuickActions;

function StatusCard({
  machine,
  asOf,
  receivedAt,
  now,
  openAction,
}: {
  machine: MachineLiveStatus;
  asOf: string;
  receivedAt: number;
  now: number;
  openAction: (action: ActionKind, machine: MachineLiveStatus) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <Link
            href={`/machines/${machine.id}?tab=status`}
            className="font-semibold underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {machine.name}
          </Link>
          <p className="font-mono text-xs text-muted-foreground">{machine.asset_tag}</p>
        </div>
        <MachineStatusSummary machine={machine} asOf={asOf} receivedAt={receivedAt} now={now} />
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Category</dt>
            <dd>{machine.category.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Department</dt>
            <dd>{machine.department.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Location</dt>
            <dd>{machine.location.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Next booking</dt>
            <dd>
              {machine.next_booking_at
                ? relativeTime(machine.next_booking_at, asOf, receivedAt, now)
                : 'None confirmed'}
            </dd>
          </div>
        </dl>
        <QuickActions machine={machine} open={openAction} />
      </CardContent>
    </Card>
  );
}

export function StatusBoard({ initialState }: { initialState: StatusBoardUrlState }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const parsed = useMemo(() => {
    const values = new URLSearchParams(searchParams.toString());
    return values.size === 0 ? initialState : parseStatusBoardState(values);
  }, [initialState, searchParams]);
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [clockNotice, setClockNotice] = useState(true);
  const [liveMessage, setLiveMessage] = useState('');
  const [userInitiatedLoad, setUserInitiatedLoad] = useState(false);
  const [action, setAction] = useState<{ kind: ActionKind; machine: MachineLiveStatus } | null>(
    null,
  );
  const previousData = useRef<unknown>(null);

  const update = (patch: Partial<StatusBoardUrlState>, resetPage = true) => {
    const next = { ...parsed, ...patch, ...(resetPage ? { page: 1 } : {}) };
    if (patch.view && patch.view !== parsed.view && patch.page_size === undefined)
      next.page_size = patch.view === 'grid' ? 24 : 50;
    const query = serializeStatusBoardState(next);
    setUserInitiatedLoad(true);
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  };

  const board = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => statusApi.board(toStatusApiQuery(parsed)),
    queryKey: ['status-board', toStatusApiQuery(parsed)],
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && (document.hidden || !navigator.onLine)) return false;
      return statusPollDelay(query.state.fetchFailureCount, Math.random() * 0.2 - 0.1);
    },
    refetchIntervalInBackground: false,
    retry: false,
    structuralSharing: (oldData, newData) =>
      JSON.stringify(oldData) === JSON.stringify(newData) ? oldData : newData,
  });
  const categories = useQuery({
    queryFn: categoriesApi.list,
    queryKey: ['categories'],
    staleTime: 300_000,
  });
  const departments = useQuery({
    queryFn: departmentsApi.list,
    queryKey: ['departments'],
    staleTime: 300_000,
  });
  const locations = useQuery({
    queryFn: () => locationsApi.list({ page: 1, pageSize: 200 }),
    queryKey: ['locations', { page: 1, pageSize: 200 }],
    staleTime: 300_000,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (board.dataUpdatedAt > 0 && board.data !== previousData.current) {
      previousData.current = board.data;
      setReceivedAt(board.dataUpdatedAt);
      setUserInitiatedLoad(false);
    }
  }, [board.data, board.dataUpdatedAt]);
  useEffect(() => {
    const refreshIfOld = () => {
      if (
        !document.hidden &&
        navigator.onLine &&
        Date.now() - board.dataUpdatedAt > STATUS_POLL_BASE_MS
      )
        void board.refetch();
    };
    document.addEventListener('visibilitychange', refreshIfOld);
    window.addEventListener('online', refreshIfOld);
    return () => {
      document.removeEventListener('visibilitychange', refreshIfOld);
      window.removeEventListener('online', refreshIfOld);
    };
  }, [board]);

  const data = board.data;
  const activeFilters = Boolean(
    parsed.category_id ||
    parsed.department_id ||
    parsed.location_id ||
    parsed.q ||
    parsed.service_due ||
    parsed.status?.length,
  );
  const selectedStatuses = parsed.status ?? [];
  const elapsed = data ? elapsedFromAsOf(data.as_of, receivedAt, now) : 0;
  const stale = Boolean(data && elapsed > STATUS_STALE_AFTER_MS);
  const rangeStart = data && data.total > 0 ? (data.page - 1) * data.page_size + 1 : 0;
  const rangeEnd = data ? Math.min(data.page * data.page_size, data.total) : 0;
  const openAction = (kind: ActionKind, machine: MachineLiveStatus) => setAction({ kind, machine });

  if (!data && board.isPending)
    return (
      <div aria-label="Loading status board" className="space-y-4">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
    );
  if (!data && board.isError)
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Status board unavailable</AlertTitle>
        <AlertDescription>
          <p>The live machine status could not be loaded. Your session remains signed in.</p>
          <Button className="mt-3" variant="outline" onClick={() => board.refetch()}>
            <RefreshCw className="size-4" /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Live status</h1>
          <p className="mt-1 text-muted-foreground">
            Active-registry equipment, current usage and service readiness.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          <p>Updated {relativeTime(data.as_of, data.as_of, receivedAt, now)}</p>
          <p>As of {formatTime(data.as_of)}</p>
          {board.isFetching && !board.isPending ? (
            <span className="inline-flex items-center gap-1">
              <RefreshCw className="size-3 animate-spin" aria-hidden="true" /> Refreshing
            </span>
          ) : null}
        </div>
      </header>
      {clockNotice && hasClockSkew(data.as_of, receivedAt) ? (
        <Alert>
          <Clock3 className="size-4" />
          <AlertTitle>This device’s clock looks wrong</AlertTitle>
          <AlertDescription>
            Relative times use the server clock.{' '}
            <Button variant="link" className="h-auto p-0" onClick={() => setClockNotice(false)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {stale || (board.isError && data) ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{stale ? 'Status data is stale' : 'Background refresh failed'}</AlertTitle>
          <AlertDescription>
            The last successful board remains visible.{' '}
            <Button variant="link" className="h-auto p-0" onClick={() => board.refetch()}>
              Retry now
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <StatusSummary
        counts={data.counts as Record<DisplayStatus, number>}
        selected={selectedStatuses}
        toggle={(status) =>
          update({
            status: selectedStatuses.includes(status)
              ? selectedStatuses.filter((item) => item !== status)
              : [...selectedStatuses, status],
          })
        }
      />
      <section
        aria-label="Status board filters"
        className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-6"
      >
        <DebouncedSearch
          key={parsed.q ?? ''}
          initialValue={parsed.q ?? ''}
          onSearch={(q) => update({ q })}
        />
        <div>
          <label className="text-sm font-medium" htmlFor="status-department">
            Department
          </label>
          <select
            id="status-department"
            className={`${selectClass} mt-1 w-full`}
            value={parsed.department_id ?? ''}
            onChange={(event) => update({ department_id: event.target.value || undefined })}
          >
            <option value="">All departments</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="status-category">
            Category
          </label>
          <select
            id="status-category"
            className={`${selectClass} mt-1 w-full`}
            value={parsed.category_id ?? ''}
            onChange={(event) => update({ category_id: event.target.value || undefined })}
          >
            <option value="">All categories</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="status-location">
            Location
          </label>
          <select
            id="status-location"
            className={`${selectClass} mt-1 w-full`}
            value={parsed.location_id ?? ''}
            onChange={(event) => update({ location_id: event.target.value || undefined })}
          >
            <option value="">All locations</option>
            {locations.data?.items.map((location) => (
              <option key={location.id} value={location.id}>
                {location.department.name} — {location.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-10 items-center gap-2 self-end text-sm font-medium">
          <input
            type="checkbox"
            checked={parsed.service_due === true}
            onChange={(event) => update({ service_due: event.target.checked ? true : undefined })}
          />{' '}
          Service due only
        </label>
        <div>
          <label className="text-sm font-medium" htmlFor="status-sort">
            Sort
          </label>
          <select
            id="status-sort"
            className={`${selectClass} mt-1 w-full`}
            value={parsed.sort}
            onChange={(event) =>
              update({ sort: event.target.value as StatusBoardUrlState['sort'] })
            }
          >
            {STATUS_BOARD_SORT_FIELDS.map((sort) => (
              <option key={sort} value={sort}>
                {sort === 'asset_tag' ? 'Asset tag' : sort === 'name' ? 'Name' : 'Status'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="status-order">
            Order
          </label>
          <select
            id="status-order"
            className={`${selectClass} mt-1 w-full`}
            value={parsed.order}
            onChange={(event) => update({ order: event.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={parsed.view === 'grid' ? 'default' : 'outline'}
            aria-pressed={parsed.view === 'grid'}
            aria-label="Grid view"
            onClick={() => update({ view: 'grid' })}
          >
            <Grid2X2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant={parsed.view === 'table' ? 'default' : 'outline'}
            aria-pressed={parsed.view === 'table'}
            aria-label="Table view"
            onClick={() => update({ view: 'table' })}
          >
            <List className="size-4" />
          </Button>
        </div>
        {activeFilters ? (
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={() => router.replace(`${pathname}?view=${parsed.view}`)}
            >
              Clear filters
            </Button>
          </div>
        ) : null}
      </section>
      <div className="sr-only" aria-live="polite">
        {liveMessage}
      </div>
      <section aria-busy={userInitiatedLoad} aria-label="Status board results">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Showing {rangeStart} to {rangeEnd} of {data.total}
          </p>
          <label>
            Page size{' '}
            <select
              aria-label="Page size"
              className={`${selectClass} ml-2`}
              value={parsed.page_size}
              onChange={(event) =>
                update({
                  page_size: Number(event.target.value) as StatusBoardUrlState['page_size'],
                })
              }
            >
              {STATUS_BOARD_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
        {data.items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No machines match this view</EmptyTitle>
              <EmptyDescription>Clear a filter or try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : parsed.view === 'grid' ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((machine) => (
              <StatusCard
                key={machine.id}
                machine={machine}
                asOf={data.as_of}
                receivedAt={receivedAt}
                now={now}
                openAction={openAction}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <caption className="sr-only">Live machine status board</caption>
              <TableHeader>
                <TableRow>
                  <TableHead
                    aria-sort={
                      parsed.sort === 'name'
                        ? parsed.order === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        update({
                          sort: 'name',
                          order: parsed.sort === 'name' && parsed.order === 'asc' ? 'desc' : 'asc',
                        })
                      }
                    >
                      Machine{' '}
                      {parsed.sort === 'name' ? (
                        parsed.order === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Placement</TableHead>
                  <TableHead>Next booking</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((machine) => (
                  <TableRow key={machine.id}>
                    <TableCell>
                      <Link
                        href={`/machines/${machine.id}?tab=status`}
                        className="font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {machine.name}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">{machine.asset_tag}</p>
                      <p className="text-xs text-muted-foreground">{machine.category.name}</p>
                    </TableCell>
                    <TableCell className="min-w-64">
                      <MachineStatusSummary
                        machine={machine}
                        asOf={data.as_of}
                        receivedAt={receivedAt}
                        now={now}
                      />
                    </TableCell>
                    <TableCell>
                      {machine.department.name}
                      <br />
                      <span className="text-muted-foreground">{machine.location.name}</span>
                    </TableCell>
                    <TableCell>
                      {machine.next_booking_at ? (
                        <>
                          <span>{formatTime(machine.next_booking_at)}</span>
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {relativeTime(machine.next_booking_at, data.as_of, receivedAt, now)}
                          </span>
                        </>
                      ) : (
                        'None confirmed'
                      )}
                    </TableCell>
                    <TableCell>
                      <QuickActions machine={machine} open={openAction} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <nav
          aria-label="Status board pagination"
          className="mt-4 flex items-center justify-between"
        >
          <Button
            variant="outline"
            disabled={data.page <= 1}
            onClick={() => update({ page: data.page - 1 }, false)}
          >
            <ChevronLeft className="size-4" /> Previous
          </Button>
          <span className="text-sm">Page {data.page}</span>
          <Button
            variant="outline"
            disabled={rangeEnd >= data.total}
            onClick={() => update({ page: data.page + 1 }, false)}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </nav>
      </section>
      {action ? (
        <UsageActionDialog
          action={action.kind}
          machine={action.machine}
          onClose={() => setAction(null)}
          onSuccess={(message) => {
            setLiveMessage(message);
            void queryClient.invalidateQueries({ queryKey: ['status-board'] });
          }}
        />
      ) : null}
    </div>
  );
}
