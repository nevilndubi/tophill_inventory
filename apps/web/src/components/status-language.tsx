import type { LucideIcon } from 'lucide-react';
import { Archive, CircleCheck, CircleX, Clock3, TriangleAlert, Wrench } from 'lucide-react';

type MachineStatus = {
  key: string;
  label: string;
  icon: LucideIcon;
  className: string;
};

const machineStatuses: MachineStatus[] = [
  {
    key: 'available',
    label: 'Available',
    icon: CircleCheck,
    className: 'border-status-available-border bg-status-available-bg text-status-available',
  },
  {
    key: 'in-use',
    label: 'In use',
    icon: Clock3,
    className: 'border-status-in-use-border bg-status-in-use-bg text-status-in-use',
  },
  {
    key: 'needs-service',
    label: 'Needs service',
    icon: TriangleAlert,
    className:
      'border-status-needs-service-border bg-status-needs-service-bg text-status-needs-service',
  },
  {
    key: 'maintenance',
    label: 'Under maintenance',
    icon: Wrench,
    className: 'border-status-maintenance-border bg-status-maintenance-bg text-status-maintenance',
  },
  {
    key: 'out-of-service',
    label: 'Out of service',
    icon: CircleX,
    className:
      'border-status-out-of-service-border bg-status-out-of-service-bg text-status-out-of-service',
  },
  {
    key: 'retired',
    label: 'Retired',
    icon: Archive,
    className: 'border-status-retired-border bg-status-retired-bg text-status-retired',
  },
];

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
        {machineStatuses.map(({ className, icon: Icon, key, label }) => (
          <li
            key={key}
            data-machine-status={key}
            className={`flex min-h-16 items-center gap-3 rounded-md border px-4 py-3 ${className}`}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold">{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
