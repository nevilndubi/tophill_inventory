import {
  DISPLAY_STATUS_METADATA,
  type DisplayStatus,
  type MachineStatusStyleName,
} from '@app/shared';
import type { LucideIcon } from 'lucide-react';
import { Archive, CircleCheck, CircleX, Clock3, TriangleAlert, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

const STYLE = {
  available: {
    className: 'border-status-available-border bg-status-available-bg text-status-available',
    icon: CircleCheck,
  },
  'in-use': {
    className: 'border-status-in-use-border bg-status-in-use-bg text-status-in-use',
    icon: Clock3,
  },
  'needs-service': {
    className:
      'border-status-needs-service-border bg-status-needs-service-bg text-status-needs-service',
    icon: TriangleAlert,
  },
  maintenance: {
    className: 'border-status-maintenance-border bg-status-maintenance-bg text-status-maintenance',
    icon: Wrench,
  },
  'out-of-service': {
    className:
      'border-status-out-of-service-border bg-status-out-of-service-bg text-status-out-of-service',
    icon: CircleX,
  },
  retired: {
    className: 'border-status-retired-border bg-status-retired-bg text-status-retired',
    icon: Archive,
  },
} as const satisfies Record<MachineStatusStyleName, { className: string; icon: LucideIcon }>;

export function DisplayStatusBadge({
  className,
  status,
}: {
  className?: string;
  status: DisplayStatus;
}) {
  const metadata = DISPLAY_STATUS_METADATA[status];
  const style = STYLE[metadata.style];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
        style.className,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {metadata.label}
    </span>
  );
}
