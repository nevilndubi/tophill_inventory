import { SetPasswordForm } from '@/components/set-password-form';
import { safeReturnPath } from '@/lib/auth/return-path';

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = safeReturnPath((await searchParams).returnTo);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">Account setup</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground">
          Choose your password
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          Use at least 12 characters. This invitation can only be accepted once.
        </p>
        <SetPasswordForm returnTo={returnTo} />
      </section>
    </main>
  );
}
