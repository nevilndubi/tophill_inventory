import { AlertTriangle } from 'lucide-react';
import { RetryButton } from '@/components/retry-button';
import { safeReturnPath } from '@/lib/auth/return-path';

export const dynamic = 'force-dynamic';

export default async function TemporarilyUnavailablePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = safeReturnPath((await searchParams).returnTo);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <section
        className="w-full max-w-lg rounded-xl border border-status-needs-service-border bg-status-needs-service-bg p-8 text-center"
        role="alert"
      >
        <AlertTriangle className="mx-auto size-12 text-status-needs-service" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold text-card-foreground">
          Authentication is temporarily unavailable
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          Your session has not been cleared. Please retry when the service is reachable.
        </p>
        <div className="mt-6">
          <RetryButton returnTo={returnTo} />
        </div>
      </section>
    </main>
  );
}
