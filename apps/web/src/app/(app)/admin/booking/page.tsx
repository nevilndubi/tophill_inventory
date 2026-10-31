import { redirect } from 'next/navigation';
import { BookingSettingsManagement } from '@/components/booking-settings';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function BookingSettingsPage() {
  const user = await requireCurrentAppUser('/admin/booking');
  const failure = permissionFailureDestination(user.role, 'reference:manage');
  if (failure) redirect(failure);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">Administration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Booking rules</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Configure the global defaults and limits used when resolving each machine’s booking
          policy.
        </p>
      </header>
      <BookingSettingsManagement />
    </div>
  );
}
