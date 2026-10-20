'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { browserApi } from '@/lib/api/browser-client';
import { ApiClientError } from '@/lib/api/client';

export function HealthConnection() {
  const health = useQuery({
    queryKey: ['api', 'health'],
    queryFn: () => browserApi.health(),
  });

  return (
    <section
      aria-labelledby="api-connection-title"
      className="rounded-lg border border-border bg-card p-5 sm:p-6"
    >
      <h2 id="api-connection-title" className="text-base font-semibold text-card-foreground">
        API connection
      </h2>
      <div className="mt-4 flex items-start gap-3" aria-live="polite">
        {health.isPending ? (
          <LoaderCircle
            className="mt-0.5 size-6 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : health.isError ? (
          <CircleX
            className="mt-0.5 size-6 shrink-0 text-status-out-of-service"
            aria-hidden="true"
          />
        ) : (
          <CircleCheck
            className="mt-0.5 size-6 shrink-0 text-status-available"
            aria-hidden="true"
          />
        )}
        <div>
          <p className="font-semibold text-card-foreground">
            {health.isPending
              ? 'Checking connection'
              : health.isError
                ? 'Unavailable'
                : 'Connected'}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {health.isPending
              ? 'Contacting the API health endpoint.'
              : health.isError
                ? health.error instanceof ApiClientError
                  ? health.error.message
                  : 'The API health check failed.'
                : 'The web app can reach the API.'}
          </p>
        </div>
      </div>
    </section>
  );
}
