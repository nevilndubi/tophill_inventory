'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { MachineLabel } from '@/components/machine-label';
import { PrintOriginWarning } from '@/components/print-origin-warning';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { publicEnv } from '@/env/public';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { toLabelMachine } from '@/lib/machines/asset-labels';

export function SingleMachineLabel({ id }: { id: string }) {
  const machine = useQuery({ queryFn: () => machinesApi.get(id), queryKey: ['machine', id] });
  if (machine.isPending) return <Skeleton aria-label="Loading label" className="h-72 w-full" />;
  if (machine.isError) {
    const missing =
      machine.error instanceof ApiClientError && machine.error.code === 'MACHINE_NOT_FOUND';
    return (
      <Card>
        <CardHeader>
          <CardTitle>{missing ? 'Machine not found' : 'Unable to load label'}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/machines">Back to machines</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const labelMachine = toLabelMachine(machine.data);
  return (
    <div className="space-y-6">
      <div className="print-controls flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
            <Link href={`/machines/${machine.data.id}`}>
              <ArrowLeft aria-hidden="true" /> Back to machine
            </Link>
          </Button>
          <h1 className="text-3xl font-semibold tracking-tight">Print asset label</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Single label preset: 100 mm × 50 mm. Print at 100% scale with “Fit to page” disabled.
          </p>
        </div>
        <Button type="button" onClick={() => window.print()}>
          <Printer aria-hidden="true" /> Print label
        </Button>
      </div>
      <PrintOriginWarning origin={publicEnv.NEXT_PUBLIC_APP_ORIGIN} />
      <Alert className="print-controls">
        <AlertTitle>Before using this label</AlertTitle>
        <AlertDescription>
          Check the printed 100 mm × 50 mm outline with a ruler and scan it from a phone before
          attaching it to equipment.
        </AlertDescription>
      </Alert>
      <div className="single-label-print-area flex justify-center overflow-auto rounded-lg border bg-muted/30 p-6">
        <MachineLabel
          appOrigin={publicEnv.NEXT_PUBLIC_APP_ORIGIN}
          machine={labelMachine}
          preset="single"
        />
      </div>
    </div>
  );
}
