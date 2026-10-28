'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, LoaderCircle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ManagedMachine } from '@app/shared';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { readLabelSelection, writeLabelSelection } from '@/lib/machines/asset-labels';

const registryError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The registry change could not be completed.';
  if (error.code === 'MACHINE_HAS_ACTIVE_BOOKINGS') {
    const details =
      typeof error.details === 'object' && error.details !== null
        ? (error.details as Record<string, unknown>)
        : {};
    const count = typeof details.booking_count === 'number' ? details.booking_count : 0;
    return `This machine has ${count} active booking${count === 1 ? '' : 's'}. Resolve them before removing it.`;
  }
  const messages: Record<string, string> = {
    MACHINE_ALREADY_DELETED: 'This machine has already been removed from the active registry.',
    MACHINE_HAS_OPEN_SESSION: 'Check in the open usage session before removing this machine.',
    MACHINE_NOT_DELETED: 'This machine is already in the active registry.',
    MACHINE_NOT_FOUND: 'This machine could not be found.',
    PERMISSION_DENIED: 'You do not have permission to change this machine’s registry status.',
  };
  return messages[error.code] ?? 'The registry change could not be completed.';
};

export function MachineRegistryActions({ machine }: { machine: ManagedMachine }) {
  const deleted = machine.registryStatus === 'DELETED';
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      deleted ? machinesApi.restore(machine.id, reason) : machinesApi.remove(machine.id, reason),
    onError: (cause) => setError(registryError(cause)),
    onSuccess: async () => {
      setError(null);
      if (!deleted) {
        writeLabelSelection(readLabelSelection().filter((item) => item.id !== machine.id));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['machines'] }),
        queryClient.invalidateQueries({ queryKey: ['machine', machine.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine-attachments', machine.id] }),
      ]);
      setOpen(false);
      if (deleted) router.replace(`/machines/${machine.id}`);
      else router.replace('/machines?registry=deleted');
    },
  });
  const reasonMissing = !deleted && reason.trim().length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        setOpen(next);
        if (!next) {
          setError(null);
          setReason('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={deleted ? 'default' : 'destructive'}>
          {deleted ? <ArchiveRestore aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          {deleted ? 'Restore to active registry' : 'Remove from active registry'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deleted ? 'Restore' : 'Remove'} {machine.name}?
          </DialogTitle>
          <DialogDescription>
            {deleted
              ? 'Restoring makes the machine visible for normal lookup again. Its asset tag, history, bookings and files remain unchanged.'
              : 'This is not retirement. The machine disappears from normal lists, QR lookup and new-work selectors, while its asset tag, history, bookings and files remain untouched.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="registry-reason">
            Reason {deleted ? '(optional)' : '(required)'}
          </label>
          <Textarea
            id="registry-reason"
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-describedby="registry-reason-hint"
            aria-invalid={reasonMissing && reason.length > 0}
          />
          <p id="registry-reason-hint" className="text-xs text-muted-foreground">
            1–200 characters. Do not enter patient names or identifiers.
          </p>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Registry change blocked</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={mutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={deleted ? 'default' : 'destructive'}
            disabled={mutation.isPending || reasonMissing}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : null}
            {deleted ? 'Restore machine' : 'Remove machine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
