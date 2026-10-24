import { ShieldX } from 'lucide-react';

export default function ForbiddenPage() {
  return (
    <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-sm">
      <ShieldX className="mx-auto size-12 text-status-out-of-service" aria-hidden="true" />
      <p className="mt-5 text-sm font-semibold uppercase tracking-wide text-status-out-of-service">
        403 — Permission denied
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-card-foreground">
        You cannot open this area
      </h1>
      <p className="mt-3 leading-7 text-muted-foreground">
        Your account is signed in, but it does not have permission to view this page.
      </p>
    </section>
  );
}
