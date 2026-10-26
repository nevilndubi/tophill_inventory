import { redirect } from 'next/navigation';
import { MachineForm } from '@/components/machine-form';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function NewMachinePage() {
  const user = await requireCurrentAppUser('/machines/new');
  const failure = permissionFailureDestination(user.role, 'machine:create');
  if (failure) redirect(failure);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Inventory registry</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Register machine</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The asset tag and initial operational condition are assigned by the system.
        </p>
      </div>
      <MachineForm />
    </div>
  );
}
