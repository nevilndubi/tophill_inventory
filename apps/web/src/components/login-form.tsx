'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { safeReturnPath } from '@/lib/auth/return-path';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';

const GENERIC_SIGN_IN_ERROR = 'Incorrect email or password';

export function LoginForm({
  e2eMockMode = false,
  returnTo,
}: {
  e2eMockMode?: boolean;
  returnTo?: string;
}) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setErrorMessage(null);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    if (e2eMockMode) {
      document.cookie = 'tophill-e2e-auth=signed-in; Path=/; SameSite=Lax';
      router.replace(safeReturnPath(returnTo));
      router.refresh();
      return;
    }

    const { error } = await createBrowserSupabaseClient().auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setErrorMessage(GENERIC_SIGN_IN_ERROR);
      setPending(false);
      return;
    }

    router.replace(safeReturnPath(returnTo));
    router.refresh();
  };

  return (
    <form className="mt-8 space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-card-foreground">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          disabled={pending}
          aria-describedby={errorMessage ? 'login-error' : undefined}
          className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-card-foreground">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          aria-describedby={errorMessage ? 'login-error' : undefined}
          className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </div>

      <div
        id="login-error"
        role="alert"
        aria-live="polite"
        className="min-h-6 text-sm text-status-out-of-service"
      >
        {errorMessage}
      </div>

      <Button className="h-11 w-full" type="submit" disabled={pending}>
        {pending ? (
          <>
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Signing in…
          </>
        ) : (
          <>
            <LockKeyhole className="size-4" aria-hidden="true" />
            Sign in
          </>
        )}
      </Button>
    </form>
  );
}
