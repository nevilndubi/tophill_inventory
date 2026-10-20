'use client';

import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="max-w-xl rounded-lg border border-status-out-of-service-border bg-card p-6">
      <CircleAlert className="size-7 text-status-out-of-service" aria-hidden="true" />
      <h1 className="mt-4 text-xl font-semibold">The workspace could not be loaded</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Try the request again. If the problem continues, contact the application administrator.
      </p>
      <Button className="mt-5" onClick={reset}>
        Try again
      </Button>
    </section>
  );
}
