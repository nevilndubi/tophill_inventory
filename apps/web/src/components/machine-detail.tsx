'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { can } from '@app/shared';
import { ArrowLeft, ArchiveX, CalendarClock, Info, Pencil, Printer, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MachineConditionBadge } from '@/components/machine-condition-badge';
import { MachineForm } from '@/components/machine-form';
import { MachineAttachments } from '@/components/machine-attachments';
import { MachineRegistryActions } from '@/components/machine-registry-actions';
import { MachineConditionPanel } from '@/components/machine-condition-panel';
import { MachineConditionHistory } from '@/components/machine-condition-history';
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { formatDateOnly, formatNairobiDateTime, isServiceOverdue } from '@/lib/machines/formatting';

const TABS = ['overview', 'status', 'bookings', 'service', 'files', 'history'] as const;
type MachineTab = (typeof TABS)[number];
const TAB_LABELS: Record<MachineTab, string> = {
  bookings: 'Bookings',
  files: 'Files',
  history: 'History',
  overview: 'Overview',
  service: 'Service',
  status: 'Status',
};

const DetailGroup = ({ children, title }: { children: React.ReactNode; title: string }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
    </CardContent>
  </Card>
);
const Detail = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd className="mt-1 text-sm">{value}</dd>
  </div>
);

export function MachineDetail({ id }: { id: string }) {
  const { user } = useAuthenticatedUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnQuery = searchParams.get('return');
  const requestedTab = searchParams.get('tab');
  const tab: MachineTab = TABS.includes(requestedTab as MachineTab)
    ? (requestedTab as MachineTab)
    : 'overview';
  const [createdTag, setCreatedTag] = useState<string | null>(null);
  const mayRestore = can(user.role, 'machine:restore');
  const machine = useQuery({
    queryFn: () => machinesApi.get(id, mayRestore),
    queryKey: ['machine', id, { includeDeleted: mayRestore }],
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = sessionStorage.getItem('machine-created-asset-tag');
      if (value) {
        setCreatedTag(value);
        sessionStorage.removeItem('machine-created-asset-tag');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const backHref = returnQuery ? `/machines?${returnQuery}` : '/machines';
  if (machine.isPending)
    return (
      <div className="space-y-4" aria-label="Loading machine">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (machine.isError) {
    const missing =
      machine.error instanceof ApiClientError && machine.error.code === 'MACHINE_NOT_FOUND';
    return (
      <Card>
        <CardHeader>
          <CardTitle>{missing ? 'Machine not found' : 'Unable to load machine'}</CardTitle>
          <CardDescription>
            {missing
              ? 'This machine does not exist or is no longer in the active registry.'
              : 'Try again when the service is available.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft aria-hidden="true" /> Back to machines
            </Link>
          </Button>
          {!missing ? <Button onClick={() => void machine.refetch()}>Retry</Button> : null}
        </CardContent>
      </Card>
    );
  }

  const value = machine.data;
  const deleted = value.registryStatus === 'DELETED';
  const overdue = isServiceOverdue(value.nextServiceDueAt);
  return (
    <div className="space-y-6">
      {createdTag ? (
        <Alert>
          <Sparkles aria-hidden="true" />
          <AlertTitle>Machine registered as {createdTag}</AlertTitle>
          <AlertDescription>
            Asset tags are unique, but sequence rollbacks can leave gaps between numbers.
          </AlertDescription>
        </Alert>
      ) : null}
      {deleted ? (
        <Alert variant="destructive">
          <ArchiveX aria-hidden="true" />
          <AlertTitle>Removed from the active registry</AlertTitle>
          <AlertDescription>
            Normal lists, QR scans and new-work selectors hide this machine. Its permanent asset
            tag, condition, history, bookings and files remain preserved.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
            <Link href={backHref}>
              <ArrowLeft aria-hidden="true" /> Back to machines
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{value.name}</h1>
            <MachineConditionBadge condition={value.condition} />
          </div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">{value.assetTag}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!deleted ? (
            <Button asChild variant="outline">
              <Link href={`/machines/${value.id}/label`}>
                <Printer aria-hidden="true" /> Print label
              </Link>
            </Button>
          ) : null}
          {!deleted && can(user.role, 'machine:update') ? (
            <Button asChild>
              <Link href={`/machines/${value.id}/edit`}>
                <Pencil aria-hidden="true" /> Edit machine
              </Link>
            </Button>
          ) : null}
          {can(user.role, deleted ? 'machine:restore' : 'machine:retire') ? (
            <MachineRegistryActions machine={value} />
          ) : null}
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => {
          const params = new URLSearchParams(searchParams.toString());
          if (next === 'overview') params.delete('tab');
          else params.set('tab', next);
          router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false });
        }}
      >
        <div className="overflow-x-auto pb-1">
          <TabsList aria-label="Machine detail sections" className="h-auto min-w-max">
            {TABS.map((item) => (
              <TabsTrigger key={item} value={item}>
                {TAB_LABELS[item]}
                {item !== 'overview' &&
                item !== 'files' &&
                item !== 'status' &&
                item !== 'history' ? (
                  <span className="sr-only"> — Coming soon</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="space-y-4 pt-3">
          <DetailGroup title="Identity and placement">
            <Detail label="Category" value={value.category.name} />
            <Detail
              label="Owning department"
              value={`${value.department.name} (${value.department.code})`}
            />
            <Detail label="Location" value={value.location.name} />
            <Detail label="Manufacturer" value={value.manufacturer} />
            <Detail label="Model" value={value.model} />
            <Detail label="Serial number" value={value.serialNumber} />
            <Detail label="Description" value={value.description ?? 'Not recorded'} />
          </DetailGroup>
          <div className="grid gap-4 lg:grid-cols-2">
            <DetailGroup title="Lifecycle">
              <Detail label="Purchased" value={formatDateOnly(value.purchaseDate)} />
              <Detail label="Commissioned" value={formatDateOnly(value.commissionedOn)} />
              <Detail label="Warranty expires" value={formatDateOnly(value.warrantyExpiresOn)} />
            </DetailGroup>
            <DetailGroup title="Service">
              <Detail label="Last serviced" value={formatNairobiDateTime(value.lastServicedAt)} />
              <Detail
                label="Service interval"
                value={
                  value.serviceIntervalDays === null
                    ? 'Not set'
                    : `${value.serviceIntervalDays} days`
                }
              />
              <Detail
                label="Next service due"
                value={
                  <span
                    className={
                      overdue
                        ? 'inline-flex items-center gap-1 font-medium text-status-out-of-service'
                        : ''
                    }
                  >
                    {overdue ? <CalendarClock className="size-4" aria-hidden="true" /> : null}
                    {formatNairobiDateTime(value.nextServiceDueAt)}
                    {overdue ? ' — Overdue' : ''}
                  </span>
                }
              />
            </DetailGroup>
          </div>
          <DetailGroup title="Booking policy">
            <Detail label="Bookable flag" value={value.isBookable ? 'Yes' : 'No'} />
            <Detail label="Approval required" value={value.requiresApproval ? 'Yes' : 'No'} />
            <Detail
              label="Allow when needs service"
              value={value.allowBookingWhenNeedsService ? 'Yes' : 'No'}
            />
            <Detail
              label="Maximum duration"
              value={
                value.maxBookingMinutes === null
                  ? 'Category or system default'
                  : `${value.maxBookingMinutes} minutes`
              }
            />
            <Detail
              label="Buffer"
              value={
                value.bufferMinutes === null
                  ? 'Category or system default'
                  : `${value.bufferMinutes} minutes`
              }
            />
          </DetailGroup>
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>Calculated service date</AlertTitle>
            <AlertDescription>
              Next service due is read-only and calculated from the last-service timestamp and
              service interval.
            </AlertDescription>
          </Alert>
        </TabsContent>
        <TabsContent value="files" className="pt-3">
          {deleted ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Files are preserved</h2>
                </CardTitle>
                <CardDescription>
                  Attachments remain private and hidden while this machine is outside the active
                  registry. Restore it to see the existing files again.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <MachineAttachments machineId={value.id} />
          )}
        </TabsContent>
        <TabsContent value="status" className="pt-3">
          <MachineConditionPanel machine={value} role={user.role} />
        </TabsContent>
        <TabsContent value="history" className="pt-3">
          <MachineConditionHistory machine={value} />
        </TabsContent>
        {TABS.filter((item) => !['overview', 'files', 'status', 'history'].includes(item)).map(
          (item) => (
            <TabsContent key={item} value={item} className="pt-3">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>{TAB_LABELS[item]}</h2>
                  </CardTitle>
                  <CardDescription>Coming soon</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    This section arrives in a later project phase. No{' '}
                    {TAB_LABELS[item].toLowerCase()} workflow is available yet.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          ),
        )}
      </Tabs>
    </div>
  );
}

export function MachineEditor({ id }: { id: string }) {
  const machine = useQuery({ queryFn: () => machinesApi.get(id), queryKey: ['machine', id] });
  if (machine.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (machine.isError) {
    const missing =
      machine.error instanceof ApiClientError && machine.error.code === 'MACHINE_NOT_FOUND';
    return (
      <Card>
        <CardHeader>
          <CardTitle>{missing ? 'Machine not found' : 'Unable to load machine'}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/machines">Back to machines</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  return <MachineForm machine={machine.data} />;
}
