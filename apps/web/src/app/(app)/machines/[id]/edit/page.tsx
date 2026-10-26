import { Suspense } from 'react';
import { machineIdParamsSchema } from '@app/shared';
import { redirect } from 'next/navigation';
import { MachineEditor } from '@/components/machine-detail';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function EditMachinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCurrentAppUser('/machines');
  const failure = permissionFailureDestination(user.role, 'machine:update');
  if (failure) redirect(failure);
  const parsed = machineIdParamsSchema.safeParse(await params);
  if (!parsed.success) redirect('/machines');
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Inventory registry</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Edit machine</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Stored condition and generated identifiers are managed by dedicated workflows.
        </p>
      </div>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
        <MachineEditor id={parsed.data.id} />
      </Suspense>
    </div>
  );
}
