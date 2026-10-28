'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ManagedMachine } from '@app/shared';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { machinesApi } from '@/lib/api/machines';
import { formatNairobiDateTime } from '@/lib/machines/formatting';
import { MachineConditionBadge } from './machine-condition-badge';

const SOURCE_LABELS = {
  MANUAL: 'Manual',
  SCHEDULE: 'Schedule',
  SERVICE_TICKET: 'Service ticket',
  SYSTEM: 'System',
} as const;

export function MachineConditionHistory({ machine }: { machine: ManagedMachine }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryFn: () => machinesApi.history(machine.id, page, machine.registryStatus === 'DELETED'),
    queryKey: ['machine-history', machine.id, page, machine.registryStatus],
  });
  if (history.isPending) return <Skeleton className="h-64 w-full" aria-label="Loading history" />;
  if (history.isError)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Unable to load history</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void history.refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  if (history.data.items.length === 0)
    return (
      <p className="rounded-xl border p-6 text-sm text-muted-foreground">
        No condition history has been recorded.
      </p>
    );
  const first = (page - 1) * history.data.pageSize + 1;
  const last = Math.min(first + history.data.items.length - 1, history.data.total);
  return (
    <div className="space-y-4">
      <ol className="space-y-3" aria-label="Condition history, newest first">
        {history.data.items.map((item) => (
          <li key={item.id} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              {item.fromCondition === null ? (
                <span className="text-sm font-medium">Registered</span>
              ) : (
                <MachineConditionBadge condition={item.fromCondition} />
              )}
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
              <MachineConditionBadge condition={item.toCondition} />
            </div>
            <p className="mt-3 text-sm">{item.reason}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {SOURCE_LABELS[item.source]} · {item.actor.fullName} ·{' '}
              {formatNairobiDateTime(item.createdAt)}
            </p>
          </li>
        ))}
      </ol>
      <nav className="flex items-center justify-between gap-3" aria-label="Condition history pages">
        <Button
          variant="outline"
          disabled={page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Showing {first} to {last} of {history.data.total}
        </span>
        <Button
          variant="outline"
          disabled={last >= history.data.total}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </Button>
      </nav>
    </div>
  );
}
