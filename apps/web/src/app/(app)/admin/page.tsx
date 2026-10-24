import { redirect } from 'next/navigation';
import { requireCurrentAppUser } from '@/lib/auth/current-user';
import { permissionFailureDestination } from '@/lib/auth/route-authorization';

export default async function AdminPage() {
  const user = await requireCurrentAppUser('/admin');
  const failure = permissionFailureDestination(user.role, 'user:manage');
  if (failure) redirect(failure);

  return (
    <section className="max-w-2xl rounded-lg border border-border bg-card p-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-primary">Coming soon</p>
      <h1 className="mt-2 text-2xl font-semibold text-card-foreground">Administration</h1>
      <p className="mt-3 leading-7 text-muted-foreground">
        User management is scheduled for Task 2.5. This route exists only to enforce and verify the
        authenticated permission boundary.
      </p>
    </section>
  );
}
