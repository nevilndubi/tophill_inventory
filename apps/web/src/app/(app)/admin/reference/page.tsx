import { redirect } from 'next/navigation';
import { ReferenceManagement } from '@/components/reference-management';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function ReferenceDataPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const user = await requireCurrentAppUser('/admin/reference');
  const failure = permissionFailureDestination(user.role, 'reference:manage');
  if (failure) redirect(failure);
  const section = (await searchParams).section;
  const initialSection =
    section === 'departments' || section === 'locations' ? section : 'categories';
  return <ReferenceManagement initialSection={initialSection} />;
}
