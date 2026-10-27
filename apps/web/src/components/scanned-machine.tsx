'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, LogIn, LogOut, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { machineAssetTagSchema } from '@app/shared';
import { MachineConditionBadge } from '@/components/machine-condition-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';

const MIN_LOOKUP_TIME_MS = 180;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

async function lookupMachine(rawAssetTag: string) {
  const started = performance.now();
  try {
    const machine = await machinesApi.getByTag(rawAssetTag);
    await wait(Math.max(0, MIN_LOOKUP_TIME_MS - (performance.now() - started)));
    return machine;
  } catch (error) {
    await wait(Math.max(0, MIN_LOOKUP_TIME_MS - (performance.now() - started)));
    throw error;
  }
}

function ScanNotFound() {
  return (
    <Card data-scan-result="not-found" data-scan-timing-class="bounded-lookup">
      <CardHeader>
        <CardTitle>Machine not found</CardTitle>
        <CardDescription>
          Check the printed tag and try again. The machine may no longer be in the active registry.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/scan">Enter another tag</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/machines">Machines list</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

const ACTIONS = [
  {
    icon: LogOut,
    id: 'check-out',
    label: 'Check out',
    phase: 'Usage sessions arrive in Task 4.2.',
  },
  { icon: LogIn, id: 'check-in', label: 'Check in', phase: 'Usage sessions arrive in Task 4.2.' },
  { icon: CalendarDays, id: 'book', label: 'Book', phase: 'Booking actions arrive in Phase 5.' },
  {
    icon: TriangleAlert,
    id: 'report-fault',
    label: 'Report a fault',
    phase: 'Fault reporting arrives in Task 6.1.',
  },
] as const;

export function ScannedMachine({ rawAssetTag }: { rawAssetTag: string }) {
  const parsedTag = machineAssetTagSchema.safeParse(rawAssetTag);
  const lookupValue = parsedTag.success ? parsedTag.data : rawAssetTag;
  const machine = useQuery({
    queryFn: () => lookupMachine(lookupValue),
    queryKey: ['machine-by-tag', lookupValue],
    retry: false,
  });

  if (machine.isPending) {
    return (
      <div aria-label="Looking up machine" className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (
    machine.isError &&
    (machine.error instanceof ApiClientError
      ? machine.error.code === 'MACHINE_NOT_FOUND'
      : !parsedTag.success)
  ) {
    return <ScanNotFound />;
  }
  if (machine.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Machine lookup is temporarily unavailable</AlertTitle>
        <AlertDescription>
          Your session remains signed in. Retry when the service is available.{' '}
          <Button variant="outline" size="sm" onClick={() => void machine.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const value = machine.data;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/scan">
          <ArrowLeft aria-hidden="true" /> Enter another tag
        </Link>
      </Button>
      <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-lg font-black tabular-nums text-primary">
              {value.assetTag}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{value.name}</h1>
          </div>
          <MachineConditionBadge condition={value.condition} className="self-start" />
        </div>
        <dl className="mt-5 grid gap-3 border-t pt-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Location</dt>
            <dd className="font-medium">{value.location.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Owning department</dt>
            <dd className="font-medium">
              {value.department.name} ({value.department.code})
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="scan-actions-title">
        <h2 id="scan-actions-title" className="text-lg font-semibold">
          Actions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These workflows are visible for orientation but are not active yet.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {ACTIONS.map(({ icon: Icon, id, label, phase }) => (
            <div className="rounded-lg border bg-card p-4" key={label}>
              <Button
                className="min-h-11 w-full justify-start"
                disabled
                aria-describedby={`action-${id}`}
              >
                <Icon aria-hidden="true" /> {label} — Coming soon
              </Button>
              <p id={`action-${id}`} className="mt-2 text-xs text-muted-foreground">
                {phase}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
