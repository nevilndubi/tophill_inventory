'use client';

import { useState } from 'react';
import type { MachineLiveStatus, ManagedMachine } from '@app/shared';
import { AlertTriangle, CalendarClock, Clock3, RefreshCw } from 'lucide-react';
import { DisplayStatusBadge } from '@/components/display-status-badge';
import { MachineConditionPanel } from '@/components/machine-condition-panel';
import {
  MachineUsageActionDialog,
  MachineUsageQuickActions,
  type UsageActionKind,
} from '@/components/machine-usage-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
import { formatNairobiDateTime } from '@/lib/machines/formatting';

export function MachineLiveStatusPanel({
  machine,
  onRetry,
  status,
  statusError,
}: {
  machine: ManagedMachine;
  onRetry: () => void;
  status?: MachineLiveStatus;
  statusError: boolean;
}) {
  const { user } = useAuthenticatedUser();
  const [action, setAction] = useState<{
    kind: UsageActionKind;
    machine: MachineLiveStatus;
  } | null>(null);
  const [message, setMessage] = useState<string>();
  if (machine.registryStatus === 'DELETED') {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>Read-only registry record</AlertTitle>
          <AlertDescription>
            Live usage actions and condition changes are unavailable while this machine is removed.
          </AlertDescription>
        </Alert>
        <MachineConditionPanel machine={machine} role={user.role} />
      </div>
    );
  }
  if (statusError || status === undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Live status unavailable</AlertTitle>
        <AlertDescription>
          The last machine record is still available. Retry the live status request.
        </AlertDescription>
        <Button className="mt-3" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Retry
        </Button>
      </Alert>
    );
  }
  return (
    <div className="space-y-4">
      {message ? (
        <Alert>
          <AlertTitle>{message}</AlertTitle>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Live status</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <DisplayStatusBadge status={status.display_status} />
            <span className="text-sm text-muted-foreground">
              As of {formatNairobiDateTime(status.as_of)}
            </span>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Usable now</dt>
              <dd>{status.usable ? 'Yes' : 'No'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Service due</dt>
              <dd className={status.service_due ? 'font-medium text-status-needs-service' : ''}>
                {status.service_due ? 'Due or overdue' : 'No'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next confirmed booking</dt>
              <dd>{formatNairobiDateTime(status.next_booking_at)}</dd>
            </div>
          </dl>
          {status.open_session ? (
            <Alert
              variant={
                ['OUT_OF_SERVICE', 'UNDER_MAINTENANCE', 'RETIRED'].includes(status.display_status)
                  ? 'destructive'
                  : 'default'
              }
            >
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>Still checked out by {status.open_session.holder.full_name}</AlertTitle>
              <AlertDescription>
                Since {formatNairobiDateTime(status.open_session.started_at)}.{' '}
                {status.open_session.expected_end_at
                  ? `Expected back ${formatNairobiDateTime(status.open_session.expected_end_at)}.`
                  : 'No expected end.'}{' '}
                {status.open_session.overdue ? 'This session is overdue.' : ''}
              </AlertDescription>
            </Alert>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock3 className="size-4" aria-hidden="true" /> No open usage session.
            </p>
          )}
          {status.service_due ? (
            <p className="flex items-center gap-2 text-sm">
              <CalendarClock className="size-4" aria-hidden="true" /> Preventive service is due.
            </p>
          ) : null}
          <MachineUsageQuickActions
            machine={status}
            open={(kind, value) => setAction({ kind, machine: value })}
          />
        </CardContent>
      </Card>
      <MachineConditionPanel machine={machine} role={user.role} />
      {action ? (
        <MachineUsageActionDialog
          action={action.kind}
          machine={action.machine}
          onClose={() => setAction(null)}
          onSuccess={setMessage}
        />
      ) : null}
    </div>
  );
}
