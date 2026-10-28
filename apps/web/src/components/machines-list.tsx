'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  MACHINE_CONDITIONS,
  MACHINE_SORT_FIELDS,
  type ListMachinesQuery,
  type MachineSortField,
  type ManagedMachine,
} from '@app/shared';
import {
  ArrowDown,
  ArrowUp,
  ArchiveX,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClockAlert,
  Printer,
  Upload,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
import { categoriesApi } from '@/lib/api/categories';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { departmentsApi, locationsApi } from '@/lib/api/reference';
import { can } from '@app/shared';
import { formatNairobiDateTime, isServiceOverdue } from '@/lib/machines/formatting';
import { parseMachineListState, serializeMachineListState } from '@/lib/machines/url-state';
import {
  MAX_LABEL_SELECTION,
  getLabelSelectionSnapshot,
  getServerLabelSelectionSnapshot,
  isLabelSelectable,
  subscribeLabelSelection,
  toLabelMachine,
  writeLabelSelection,
  type LabelMachine,
} from '@/lib/machines/asset-labels';

const CONDITION_LABELS: Record<(typeof MACHINE_CONDITIONS)[number], string> = {
  NEEDS_SERVICE: 'Needs service',
  OPERATIONAL: 'Operational',
  OUT_OF_SERVICE: 'Out of service',
  RETIRED: 'Retired',
  UNDER_MAINTENANCE: 'Under maintenance',
};

const SORT_LABELS: Record<MachineSortField, string> = {
  asset_tag: 'Asset tag',
  condition: 'Condition',
  manufacturer: 'Manufacturer',
  name: 'Name',
  next_service_due_at: 'Next service',
  serial_number: 'Serial number',
};

const selectClass =
  'h-10 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

const queryError = (error: unknown): string =>
  error instanceof ApiClientError && error.code === 'VALIDATION_ERROR'
    ? 'One or more filters are invalid. Reset the filters and try again.'
    : 'Machines could not be loaded. Try again.';

function LoadingRows() {
  return (
    <div aria-label="Loading machines" className="space-y-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

function ServiceDue({ value }: { value: string | null }) {
  if (value === null) return <span className="text-muted-foreground">Not scheduled</span>;
  const overdue = isServiceOverdue(value);
  return (
    <span className={overdue ? 'font-medium text-status-out-of-service' : undefined}>
      {formatNairobiDateTime(value)}
      {overdue ? (
        <span className="ml-2 inline-flex items-center gap-1 text-xs">
          <ClockAlert className="size-3.5" aria-hidden="true" /> Overdue
        </span>
      ) : null}
    </span>
  );
}

function DebouncedMachineSearch({
  initialValue,
  onSearch,
}: {
  initialValue: string;
  onSearch: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  useEffect(() => {
    const trimmed = draft.trim();
    const timer = window.setTimeout(() => {
      const next = trimmed.length >= 2 ? trimmed : undefined;
      if (next !== (initialValue || undefined)) onSearch(next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, initialValue, onSearch]);

  return (
    <div className="xl:col-span-2">
      <label className="sr-only" htmlFor="machine-search">
        Search machines
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="machine-search"
          className="pl-9"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Name, asset tag, or serial number"
        />
      </div>
      {draft.trim().length === 1 ? (
        <p className="mt-1 text-xs text-muted-foreground">Enter at least 2 characters to search.</p>
      ) : null}
    </div>
  );
}

function MachineCard({
  machine,
  returnQuery,
  selected,
  toggleSelected,
}: {
  machine: ManagedMachine;
  returnQuery: string;
  selected: boolean;
  toggleSelected: (machine: ManagedMachine) => void;
}) {
  const selectable = isLabelSelectable(machine);
  const deleted = machine.registryStatus === 'DELETED';
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Link
              className="font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={`/machines/${machine.id}${returnQuery ? `?return=${encodeURIComponent(returnQuery)}` : ''}`}
            >
              {machine.name}
            </Link>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{machine.assetTag}</p>
          </div>
          <MachineConditionBadge condition={machine.condition} />
        </div>
        {deleted ? (
          <p className="inline-flex items-center gap-1 text-sm font-medium text-destructive">
            <ArchiveX className="size-4" aria-hidden="true" /> Removed from active registry
          </p>
        ) : null}
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
            <dt className="text-muted-foreground">Service</dt>
            <dd>
              <ServiceDue value={machine.nextServiceDueAt} />
            </dd>
          </div>
        </dl>
        <label className="flex min-h-11 items-center gap-3 border-t pt-4 text-sm font-medium">
          <input
            type="checkbox"
            checked={selected}
            disabled={!selectable}
            onChange={() => toggleSelected(machine)}
            className="size-4 accent-primary"
          />
          {selectable
            ? 'Select for label printing'
            : deleted
              ? 'Removed machines cannot be selected'
              : 'Retired machines cannot be selected'}
        </label>
      </CardContent>
    </Card>
  );
}

export function MachinesList({ initialState }: { initialState: ListMachinesQuery }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuthenticatedUser();
  const labelSelection = useSyncExternalStore(
    subscribeLabelSelection,
    getLabelSelectionSnapshot,
    getServerLabelSelectionSnapshot,
  );
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const mayRestore = can(user.role, 'machine:restore');
  const parsed = useMemo(() => parseMachineListState(searchParams), [searchParams]);
  const queryString = serializeMachineListState(parsed);

  const update = (patch: Partial<ListMachinesQuery>, resetPage = true) => {
    const next = { ...parsed, ...patch, ...(resetPage ? { page: 1 } : {}) };
    const nextQuery = serializeMachineListState(next);
    router.replace(`${pathname}${nextQuery ? `?${nextQuery}` : ''}`, { scroll: false });
  };

  const machines = useQuery({
    initialData: undefined,
    placeholderData: keepPreviousData,
    queryFn: () => machinesApi.list(parsed),
    queryKey: ['machines', parsed],
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
    queryFn: () => locationsApi.list({ pageSize: 200 }),
    queryKey: ['locations', { pageSize: 200 }],
    staleTime: 300_000,
  });

  const commitSelection = (next: readonly LabelMachine[]) => {
    const stored = writeLabelSelection(next);
    return stored;
  };
  const toggleSelected = (machine: ManagedMachine) => {
    if (!isLabelSelectable(machine)) return;
    setSelectionMessage(null);
    const exists = labelSelection.some((item) => item.id === machine.id);
    if (!exists && labelSelection.length >= MAX_LABEL_SELECTION) {
      setSelectionMessage(`A print batch can contain at most ${MAX_LABEL_SELECTION} labels.`);
      return;
    }
    commitSelection(
      exists
        ? labelSelection.filter((item) => item.id !== machine.id)
        : [...labelSelection, toLabelMachine(machine)],
    );
  };

  const page = machines.data ?? {
    items: [],
    page: initialState.page,
    pageSize: initialState.pageSize,
    total: 0,
  };
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.page * page.pageSize, page.total);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const hasFilters = Boolean(
    parsed.search ||
    parsed.department_id ||
    parsed.category_id ||
    parsed.location_id ||
    parsed.condition ||
    parsed.is_bookable !== undefined ||
    parsed.service_due !== undefined ||
    parsed.registry !== 'active',
  );

  const sortBy = (sort: MachineSortField) => {
    const direction = parsed.sort === sort && parsed.direction === 'asc' ? 'desc' : 'asc';
    update({ direction, sort });
  };

  const selectPage = () => {
    const eligible = page.items.filter(isLabelSelectable).map(toLabelMachine);
    const stored = commitSelection([...labelSelection, ...eligible]);
    const requested = new Set([...labelSelection, ...eligible].map((item) => item.id)).size;
    setSelectionMessage(
      requested > MAX_LABEL_SELECTION
        ? `Selected the first ${MAX_LABEL_SELECTION} eligible machines; that is the print-batch limit.`
        : `${stored.length} machine${stored.length === 1 ? '' : 's'} selected for printing.`,
    );
  };

  const selectAllMatching = async () => {
    setSelectingAll(true);
    setSelectionMessage(null);
    try {
      const matching = await machinesApi.list({ ...parsed, page: 1, pageSize: 100 });
      const eligible = matching.items.filter(isLabelSelectable).map(toLabelMachine);
      const stored = commitSelection(eligible);
      const capped = matching.total > MAX_LABEL_SELECTION || eligible.length > MAX_LABEL_SELECTION;
      setSelectionMessage(
        capped
          ? `Selected the first ${MAX_LABEL_SELECTION} eligible matches; split larger jobs into another batch.`
          : `${stored.length} matching machine${stored.length === 1 ? '' : 's'} selected.`,
      );
    } catch {
      setSelectionMessage('Matching machines could not be selected. Try again.');
    } finally {
      setSelectingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Inventory registry</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Machines</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Search equipment, review its stored condition, and keep placement and service details
            current.
          </p>
        </div>
        {can(user.role, 'machine:create') ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/machines/import">
                <Upload aria-hidden="true" /> Import CSV
              </Link>
            </Button>
            <Button asChild>
              <Link href="/machines/new">
                <Plus aria-hidden="true" /> Register machine
              </Link>
            </Button>
          </div>
        ) : null}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="size-4" aria-hidden="true" /> Find machines
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <DebouncedMachineSearch
              key={parsed.search ?? ''}
              initialValue={parsed.search ?? ''}
              onSearch={(search) => update({ search })}
            />
            <label className="grid gap-1 text-xs text-muted-foreground">
              Department
              <select
                className={selectClass}
                value={parsed.department_id ?? ''}
                onChange={(event) => update({ department_id: event.target.value || undefined })}
              >
                <option value="">All departments</option>
                {departments.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {mayRestore ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Registry visibility
                <select
                  className={selectClass}
                  value={parsed.registry}
                  onChange={(event) =>
                    update({ registry: event.target.value as ListMachinesQuery['registry'] })
                  }
                >
                  <option value="active">Active</option>
                  <option value="deleted">Deleted</option>
                  <option value="all">All</option>
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-xs text-muted-foreground">
              Category
              <select
                className={selectClass}
                value={parsed.category_id ?? ''}
                onChange={(event) => update({ category_id: event.target.value || undefined })}
              >
                <option value="">All categories</option>
                {categories.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Location
              <select
                className={selectClass}
                value={parsed.location_id ?? ''}
                onChange={(event) => update({ location_id: event.target.value || undefined })}
              >
                <option value="">All locations</option>
                {locations.data?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.department.name} — {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Condition
              <select
                className={selectClass}
                value={parsed.condition ?? ''}
                onChange={(event) =>
                  update({
                    condition: (event.target.value || undefined) as ListMachinesQuery['condition'],
                  })
                }
              >
                <option value="">All conditions</option>
                {MACHINE_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {CONDITION_LABELS[condition]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Bookable flag
              <select
                className={selectClass}
                value={parsed.is_bookable === undefined ? '' : String(parsed.is_bookable)}
                onChange={(event) =>
                  update({
                    is_bookable:
                      event.target.value === '' ? undefined : event.target.value === 'true',
                  })
                }
              >
                <option value="">Either</option>
                <option value="true">Bookable</option>
                <option value="false">Not bookable</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Service due
              <select
                className={selectClass}
                value={parsed.service_due === undefined ? '' : String(parsed.service_due)}
                onChange={(event) =>
                  update({
                    service_due:
                      event.target.value === '' ? undefined : event.target.value === 'true',
                  })
                }
              >
                <option value="">Either</option>
                <option value="true">Due or overdue</option>
                <option value="false">Not due</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-muted-foreground">
              Sort{' '}
              <select
                className={selectClass}
                value={parsed.sort}
                onChange={(event) => update({ sort: event.target.value as MachineSortField })}
              >
                {MACHINE_SORT_FIELDS.map((sort) => (
                  <option key={sort} value={sort}>
                    {SORT_LABELS[sort]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update({ direction: parsed.direction === 'asc' ? 'desc' : 'asc' })}
            >
              {parsed.direction === 'asc' ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              )}{' '}
              {parsed.direction === 'asc' ? 'Ascending' : 'Descending'}
            </Button>
            {hasFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => router.replace(pathname)}
              >
                Reset filters
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <section
        className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
        aria-label="Asset label selection"
      >
        <div>
          <p className="font-medium">Asset labels</p>
          <p className="text-sm text-muted-foreground">
            {labelSelection.length} of {MAX_LABEL_SELECTION} selected. Selection follows you across
            pages in this session.
          </p>
          {selectionMessage ? (
            <p className="mt-1 text-sm" role="status">
              {selectionMessage}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={selectPage}
            disabled={page.items.length === 0}
          >
            Select this page
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void selectAllMatching()}
            disabled={selectingAll || page.total === 0}
          >
            {selectingAll ? 'Selecting…' : 'Select all matching'}
          </Button>
          {labelSelection.length === 0 ? (
            <Button type="button" disabled>
              <Printer aria-hidden="true" /> Print labels (0)
            </Button>
          ) : (
            <Button asChild>
              <Link href="/machines/labels">
                <Printer aria-hidden="true" /> Print labels ({labelSelection.length})
              </Link>
            </Button>
          )}
        </div>
      </section>

      {machines.isPending ? (
        <LoadingRows />
      ) : machines.isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Unable to load machines</AlertTitle>
          <AlertDescription>
            {queryError(machines.error)}{' '}
            <Button
              className="ml-2"
              variant="outline"
              size="sm"
              onClick={() => void machines.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : page.items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {hasFilters ? 'No machines match this view' : 'No machines registered'}
            </EmptyTitle>
            <EmptyDescription>
              {hasFilters
                ? 'Adjust or reset the filters to broaden the results.'
                : 'Register the first machine to start the active inventory.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
            <Table>
              <caption className="sr-only">Machine inventory matching the selected filters</caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <span className="sr-only">Select for printing</span>
                  </TableHead>
                  {(['asset_tag', 'name', 'condition'] as const).map((sort) => (
                    <TableHead
                      key={sort}
                      aria-sort={
                        parsed.sort === sort
                          ? parsed.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button
                        className="inline-flex items-center gap-1 rounded px-1 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => sortBy(sort)}
                      >
                        {SORT_LABELS[sort]}
                        {parsed.sort === sort ? (
                          parsed.direction === 'asc' ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : null}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>Category</TableHead>
                  <TableHead>Placement</TableHead>
                  <TableHead>Next service</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((machine) => (
                  <TableRow
                    key={machine.id}
                    className={
                      machine.registryStatus === 'DELETED' ? 'bg-destructive/5' : undefined
                    }
                  >
                    <TableCell>
                      <input
                        aria-label={`Select ${machine.assetTag} for label printing`}
                        type="checkbox"
                        checked={labelSelection.some((item) => item.id === machine.id)}
                        disabled={!isLabelSelectable(machine)}
                        onChange={() => toggleSelected(machine)}
                        className="size-4 accent-primary"
                        title={
                          isLabelSelectable(machine)
                            ? undefined
                            : machine.registryStatus === 'DELETED'
                              ? 'Removed machines cannot be selected or printed'
                              : 'Retired machines cannot be selected'
                        }
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{machine.assetTag}</TableCell>
                    <TableCell>
                      <Link
                        className="font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={`/machines/${machine.id}${queryString ? `?return=${encodeURIComponent(queryString)}` : ''}`}
                      >
                        {machine.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {machine.manufacturer} · {machine.model}
                      </p>
                      {machine.registryStatus === 'DELETED' ? (
                        <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-destructive">
                          <ArchiveX className="size-3.5" aria-hidden="true" /> Removed from registry
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <MachineConditionBadge condition={machine.condition} />
                    </TableCell>
                    <TableCell>{machine.category.name}</TableCell>
                    <TableCell>
                      {machine.department.name}
                      <p className="text-xs text-muted-foreground">{machine.location.name}</p>
                    </TableCell>
                    <TableCell>
                      <ServiceDue value={machine.nextServiceDueAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-4 md:hidden">
            {page.items.map((machine) => (
              <MachineCard
                key={machine.id}
                machine={machine}
                returnQuery={queryString}
                selected={labelSelection.some((item) => item.id === machine.id)}
                toggleSelected={toggleSelected}
              />
            ))}
          </div>
        </>
      )}

      <nav
        aria-label="Machine list pagination"
        className="flex flex-col items-center justify-between gap-3 border-t pt-4 sm:flex-row"
      >
        <p className="text-sm text-muted-foreground">
          Showing {first} to {last} of {page.total}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page.page <= 1 || machines.isFetching}
            onClick={() => update({ page: page.page - 1 }, false)}
          >
            <ChevronLeft aria-hidden="true" /> Previous
          </Button>
          <span className="text-sm">
            Page {page.page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page.page >= pages || machines.isFetching}
            onClick={() => update({ page: page.page + 1 }, false)}
          >
            Next <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </div>
  );
}
