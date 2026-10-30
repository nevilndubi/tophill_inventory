import { DISPLAY_STATUSES, DISPLAY_STATUS_METADATA } from '@app/shared';
import { DisplayStatusBadge } from './display-status-badge';

export function StatusLanguage() {
  return (
    <section aria-labelledby="status-language-title" className="mt-8">
      <div>
        <h2 id="status-language-title" className="text-lg font-semibold text-foreground">
          Status language
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every machine state combines a label, icon, and colour.
        </p>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {DISPLAY_STATUSES.map((status) => (
          <li
            key={status}
            data-machine-status={DISPLAY_STATUS_METADATA[status].style}
            className="flex min-h-16 items-center rounded-md border bg-card px-4 py-3"
          >
            <DisplayStatusBadge status={status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
