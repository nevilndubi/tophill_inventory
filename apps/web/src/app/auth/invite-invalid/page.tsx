import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function InvalidInvitePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <AlertTriangle className="size-10 text-destructive" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold text-card-foreground">
          This invitation cannot be used
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          The invitation may have expired or already been accepted. Ask an administrator for a new
          invitation.
        </p>
        <Button asChild className="mt-7">
          <Link href="/login">Return to sign in</Link>
        </Button>
      </section>
    </main>
  );
}
