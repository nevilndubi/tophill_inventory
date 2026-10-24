import { UserRoundX } from 'lucide-react';
import { SessionSignOutButton } from '@/components/session-sign-out-button';

export const dynamic = 'force-dynamic';

export default function NoAccessPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <UserRoundX className="mx-auto size-12 text-status-needs-service" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold text-card-foreground">
          Account access required
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          Your account has no access to this system. Contact your administrator.
        </p>
        <div className="mt-6">
          <SessionSignOutButton />
        </div>
      </section>
    </main>
  );
}
