'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  USAGE_EXPECTED_END_HOURS_MAX,
  USAGE_EXPECTED_END_MINUTES_MIN,
  type MachineLiveStatus,
} from '@app/shared';
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError } from '@/lib/api/client';
import { statusApi } from '@/lib/api/status';
import { statusQuickActions } from '@/lib/status/capabilities';

const selectClass =
  'h-10 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const NAIROBI_FORMAT = new Intl.DateTimeFormat('en-KE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Nairobi',
});

const errorDetails = (error: ApiClientError): Record<string, unknown> =>
  typeof error.details === 'object' && error.details !== null
    ? (error.details as Record<string, unknown>)
    : {};

export const friendlyUsageActionError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The action could not be completed. Try again.';
  const details = errorDetails(error);
  switch (error.code) {
    case 'MACHINE_IN_USE':
      return details.held_by_current_user === true
        ? 'You already have this machine. Use Check in when you are finished.'
        : `This machine was checked out by ${typeof (details.holder as { full_name?: unknown } | undefined)?.full_name === 'string' ? (details.holder as { full_name: string }).full_name : 'another user'}. The status has been refreshed.`;
    case 'UPCOMING_BOOKING_CONFLICT':
      return typeof details.starts_at === 'string'
        ? `This machine is reserved from ${NAIROBI_FORMAT.format(new Date(details.starts_at))}.`
        : 'This machine is reserved for a confirmed booking.';
    case 'MACHINE_NOT_AVAILABLE':
      return 'The machine is no longer available. Its current status has been refreshed.';
    case 'NO_OPEN_SESSION':
      return 'This machine no longer has an open session.';
    case 'SESSION_NOT_HELD':
      return 'This session belongs to another user. Refresh and use Force end if permitted.';
    case 'PERMISSION_DENIED':
      return 'You do not have permission to end this session.';
    case 'SETTINGS_INVALID':
      return 'Check-out is temporarily unavailable because its settings could not be read. Retry shortly.';
    case 'MACHINE_BUSY':
      return 'This machine is busy processing another change. Retry shortly.';
    default:
      return error.message || 'The action could not be completed. Try again.';
  }
};

export type UsageActionKind = 'check-in' | 'check-out' | 'force-end';

export function MachineUsageActionDialog({
  action,
  machine,
  onClose,
  onSuccess,
}: {
  action: UsageActionKind;
  machine: MachineLiveStatus;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [preset, setPreset] = useState('60');
  const [openedAt] = useState(() => Date.now());
  const [customEnd, setCustomEnd] = useState('');
  const [purpose, setPurpose] = useState('');
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (action === 'check-out') {
        let expectedEndAt: string | undefined;
        if (preset === 'custom')
          expectedEndAt = customEnd ? new Date(customEnd).toISOString() : undefined;
        else if (preset !== 'open')
          expectedEndAt = new Date(Date.now() + Number(preset) * 60_000).toISOString();
        return statusApi.checkOut(machine.id, {
          ...(expectedEndAt ? { expectedEndAt } : {}),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        });
      }
      return statusApi.checkIn(
        machine.id,
        action === 'force-end' ? { force: true, reason: reason.trim() } : { force: false },
      );
    },
    onError: async (error) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['status-board'] }),
        queryClient.invalidateQueries({ queryKey: ['machine-status', machine.id] }),
      ]);
      if (
        error instanceof ApiClientError &&
        ['MACHINE_IN_USE', 'MACHINE_NOT_AVAILABLE', 'NO_OPEN_SESSION'].includes(error.code)
      )
        onClose();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['status-board'] }),
        queryClient.invalidateQueries({ queryKey: ['machine-status', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine-timeline', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machines'] }),
      ]);
      onSuccess(
        action === 'check-out'
          ? 'Machine checked out.'
          : action === 'force-end'
            ? 'Usage session force-ended.'
            : 'Machine checked in.',
      );
      onClose();
    },
  });
  const validForceReason = reason.trim().length >= 10 && reason.trim().length <= 200;
  const invalidCustom = preset === 'custom' && !customEnd;
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById('usage-dialog-title')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle id="usage-dialog-title" tabIndex={-1}>
            {action === 'check-out'
              ? 'Check out'
              : action === 'force-end'
                ? 'Force end usage'
                : 'Check in'}{' '}
            {machine.name}
          </DialogTitle>
          <DialogDescription>
            {action === 'check-out'
              ? 'Choose an expected end and an optional generic purpose.'
              : action === 'force-end'
                ? 'End another user’s session only when operationally necessary.'
                : 'Confirm that the machine has been returned.'}
          </DialogDescription>
        </DialogHeader>
        {action === 'check-out' ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium" htmlFor="expected-end">
                Expected end
              </label>
              <select
                id="expected-end"
                className={`${selectClass} mt-1 w-full`}
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
              >
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="240">4 hours</option>
                <option value="open">Until I check in</option>
                <option value="custom">Custom time</option>
              </select>
            </div>
            {preset === 'custom' ? (
              <div>
                <label className="text-sm font-medium" htmlFor="custom-end">
                  Custom expected end
                </label>
                <Input
                  id="custom-end"
                  type="datetime-local"
                  min={new Date(openedAt + USAGE_EXPECTED_END_MINUTES_MIN * 60_000)
                    .toISOString()
                    .slice(0, 16)}
                  max={new Date(openedAt + USAGE_EXPECTED_END_HOURS_MAX * 3_600_000)
                    .toISOString()
                    .slice(0, 16)}
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </div>
            ) : null}
            <div>
              <label className="text-sm font-medium" htmlFor="usage-purpose">
                Purpose (optional)
              </label>
              <Textarea
                id="usage-purpose"
                maxLength={200}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Ward round"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {['Ward round', 'Pre-op check', 'Routine monitoring'].map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setPurpose(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Do not enter patient names or identifiers.
              </p>
            </div>
          </div>
        ) : null}
        {action === 'force-end' ? (
          <div>
            <label className="text-sm font-medium" htmlFor="force-reason">
              Reason
            </label>
            <Textarea
              id="force-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={10}
              maxLength={200}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              10–200 characters. Do not enter patient names or identifiers.
            </p>
          </div>
        ) : null}
        {mutation.error ? (
          <Alert variant="destructive">
            <AlertTitle>Action not completed</AlertTitle>
            <AlertDescription>{friendlyUsageActionError(mutation.error)}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={mutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={
              mutation.isPending || invalidCustom || (action === 'force-end' && !validForceReason)
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? 'Saving…'
              : action === 'check-out'
                ? 'Check out'
                : action === 'force-end'
                  ? 'Force end'
                  : 'Check in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MachineUsageQuickActions({
  machine,
  open,
}: {
  machine: MachineLiveStatus;
  open: (action: UsageActionKind, machine: MachineLiveStatus) => void;
}) {
  const { user } = useAuthenticatedUser();
  const actions = statusQuickActions(
    { departmentId: user.department?.id ?? null, id: user.id, role: user.role },
    machine,
  );
  if (!actions.canCheckOut && !actions.canCheckIn && !actions.canForceEnd) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.canCheckOut ? (
        <Button size="sm" onClick={() => open('check-out', machine)}>
          Check out
        </Button>
      ) : null}
      {actions.canCheckIn ? (
        <Button size="sm" onClick={() => open('check-in', machine)}>
          Check in
        </Button>
      ) : null}
      {actions.canForceEnd ? (
        <Button size="sm" variant="destructive" onClick={() => open('force-end', machine)}>
          Force end
        </Button>
      ) : null}
    </div>
  );
}
