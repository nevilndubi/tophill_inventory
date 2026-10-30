'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  can,
  MACHINE_ALLOWED_TRANSITIONS,
  type AppRole,
  type MachineCondition,
  type ManagedMachine,
} from '@app/shared';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { MachineConditionBadge } from './machine-condition-badge';

const LABELS: Record<MachineCondition, string> = {
  NEEDS_SERVICE: 'Mark as needs service',
  OPERATIONAL: 'Verify as operational',
  OUT_OF_SERVICE: 'Take out of service',
  RETIRED: 'Retire machine',
  UNDER_MAINTENANCE: 'Start maintenance',
};

const transitionError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The condition change could not be completed.';
  const messages: Record<string, string> = {
    CONDITION_CHANGED: 'Another user changed the condition. Reload to see the new state.',
    CONDITION_FORCE_INVALID: 'The forced safety path is not valid for this condition change.',
    CONDITION_REASON_INVALID: 'Enter a clear reason between 1 and 200 characters.',
    CONDITION_UNCHANGED: 'The machine is already in that condition.',
    INVALID_TRANSITION: 'That transition is not allowed from the current condition.',
    MACHINE_DELETED: 'A machine outside the active registry cannot change condition.',
    MACHINE_HAS_OPEN_SESSION: 'This machine has an open usage session.',
    MACHINE_NOT_FOUND: 'This machine could not be found.',
    PERMISSION_DENIED: 'You do not have permission to make this condition change.',
  };
  return messages[error.code] ?? 'The condition change could not be completed.';
};

export function MachineConditionPanel({
  machine,
  role,
}: {
  machine: ManagedMachine;
  role: AppRole;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<MachineCondition | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forceAvailable, setForceAvailable] = useState(false);
  const [force, setForce] = useState(false);
  const mutation = useMutation({
    mutationFn: () => {
      if (target === null) throw new Error('Missing transition target');
      return machinesApi.transition(machine.id, {
        force,
        fromCondition: machine.condition,
        reason,
        toCondition: target,
      });
    },
    onError: (cause) => {
      if (
        cause instanceof ApiClientError &&
        cause.code === 'MACHINE_HAS_OPEN_SESSION' &&
        target === 'OUT_OF_SERVICE'
      ) {
        setForceAvailable(true);
      }
      setError(transitionError(cause));
      if (cause instanceof ApiClientError && cause.code === 'CONDITION_CHANGED') {
        void queryClient.invalidateQueries({ queryKey: ['machine', machine.id] });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['machine', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine-history', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine-timeline', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine-status', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['status-board'] }),
        queryClient.invalidateQueries({ queryKey: ['machines'] }),
      ]);
      close();
    },
  });
  const close = () => {
    setTarget(null);
    setReason('');
    setError(null);
    setForce(false);
    setForceAvailable(false);
  };
  const transitions = can(role, 'service:manage')
    ? MACHINE_ALLOWED_TRANSITIONS[machine.condition].filter(
        (condition) =>
          (condition !== 'RETIRED' && machine.condition !== 'RETIRED') ||
          can(role, 'machine:retire'),
      )
    : [];
  const minimum = force ? 10 : 1;

  return (
    <div className="space-y-4">
      <CardLike title="Current condition">
        <MachineConditionBadge condition={machine.condition} />
        <p className="text-sm text-muted-foreground">
          Condition is independent of whether a machine is currently in use.
        </p>
      </CardLike>
      {machine.registryStatus === 'DELETED' ? (
        <Alert>
          <AlertTitle>Condition is read-only</AlertTitle>
          <AlertDescription>
            Restore this machine to the active registry before changing its condition.
          </AlertDescription>
        </Alert>
      ) : transitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No permitted transitions are available.</p>
      ) : (
        <div className="flex flex-wrap gap-2" aria-label="Available condition transitions">
          {transitions.map((condition) => (
            <Button key={condition} variant="outline" onClick={() => setTarget(condition)}>
              {LABELS[condition]}
            </Button>
          ))}
        </div>
      )}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && !mutation.isPending && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{target === null ? 'Change condition' : LABELS[target]}</DialogTitle>
            <DialogDescription>
              Confirm the observed condition and record why this change is being made.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="text-sm font-medium" htmlFor="condition-reason">
              Reason
            </label>
            <Textarea
              id="condition-reason"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby="condition-reason-hint"
            />
            <p id="condition-reason-hint" className="text-xs text-muted-foreground">
              1–200 characters. Visible to everyone who can read machine history. Do not enter
              patient names or identifiers.
            </p>
            {forceAvailable ? (
              <label className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                <span>
                  <strong className="flex items-center gap-1">
                    <ShieldAlert className="size-4" aria-hidden="true" /> Force safety transition
                  </strong>
                  Use only when the machine is unsafe while in use. This does not end the open
                  session and requires at least 10 characters of explanation.
                </span>
              </label>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Condition change blocked</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={mutation.isPending || reason.trim().length < minimum}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              Confirm condition change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CardLike({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}
