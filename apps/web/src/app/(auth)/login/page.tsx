import { ShieldCheck } from 'lucide-react';
import { LoginForm } from '@/components/login-form';
import { safeReturnPath } from '@/lib/auth/return-path';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = safeReturnPath((await searchParams).returnTo);

  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1fr)_minmax(32rem,0.72fr)]">
      <section className="hidden bg-sidebar px-12 py-16 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-lg font-semibold">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            TI
          </span>
          Tophill Inventory
        </div>
        <div className="max-w-xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sidebar-ring">
            Hospital equipment workspace
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
            Keep essential equipment visible, ready and accountable.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-8 text-sidebar-muted">
            Secure access for authorised Tophill Hospital staff.
          </p>
        </div>
        <p className="text-sm text-sidebar-muted">No patient information belongs in this system.</p>
      </section>

      <section className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-7 shadow-sm sm:p-9">
          <div className="flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground lg:hidden">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </div>
          <p className="mt-6 text-sm font-semibold uppercase tracking-wide text-primary lg:mt-0">
            Authorised access
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground">
            Sign in to continue
          </h2>
          <p className="mt-3 leading-7 text-muted-foreground">
            Use the email address and password issued by your administrator.
          </p>
          <LoginForm returnTo={returnTo} />
        </div>
      </section>
    </main>
  );
}
