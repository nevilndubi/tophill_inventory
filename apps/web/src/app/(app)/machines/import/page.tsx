import { redirect } from 'next/navigation';
import { MachineImport } from '@/components/machine-import';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function MachineImportPage() {
  const user = await requireCurrentAppUser('/machines/import');
  const failure = permissionFailureDestination(user.role, 'machine:create');
  if (failure) redirect(failure);
  return <MachineImport />;
}
