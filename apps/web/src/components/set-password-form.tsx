'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { safeReturnPath } from '@/lib/auth/return-path';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';

export function SetPasswordForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');
    setError(null);

    if (password.length < 12 || password !== confirmation) {
      setError(
        password.length < 12 ? 'Use at least 12 characters.' : 'The two passwords do not match.',
      );
      return;
    }

    setPending(true);
    const { error: updateError } = await createBrowserSupabaseClient().auth.updateUser({
      password,
    });
    if (updateError) {
      setError(
        'Your invitation could not be completed. Ask an administrator for a new invitation.',
      );
      setPending(false);
      return;
    }

    router.replace(safeReturnPath(returnTo));
    router.refresh();
  };

  return (
    <form className="mt-8" onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        <Field data-invalid={error !== null}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            disabled={pending}
            aria-invalid={error !== null}
          />
          <FieldDescription>At least 12 characters.</FieldDescription>
        </Field>
        <Field data-invalid={error !== null}>
          <FieldLabel htmlFor="confirmation">Confirm password</FieldLabel>
          <Input
            id="confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            disabled={pending}
            aria-describedby={error ? 'set-password-error' : undefined}
            aria-invalid={error !== null}
          />
        </Field>
        <p
          id="set-password-error"
          role="alert"
          aria-live="polite"
          className="min-h-6 text-sm text-destructive"
        >
          {error}
        </p>
        <Button type="submit" disabled={pending}>
          {pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <KeyRound data-icon="inline-start" />
          )}
          {pending ? 'Saving…' : 'Set password and continue'}
        </Button>
      </FieldGroup>
    </form>
  );
}
