import { redirect } from 'next/navigation';
import { UserManagement } from '@/components/user-management';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function AdminPage() {
  const user = await requireCurrentAppUser('/admin');
  const failure = permissionFailureDestination(user.role, 'user:manage');
  if (failure) redirect(failure);

  return <UserManagement />;
}
