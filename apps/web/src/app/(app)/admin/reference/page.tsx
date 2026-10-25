import { redirect } from 'next/navigation';
import { CategoryManagement } from '@/components/category-management';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function ReferenceDataPage() {
  const user = await requireCurrentAppUser('/admin/reference');
  const failure = permissionFailureDestination(user.role, 'reference:manage');
  if (failure) redirect(failure);
  return <CategoryManagement />;
}
