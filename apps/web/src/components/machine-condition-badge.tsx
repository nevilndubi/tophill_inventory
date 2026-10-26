import type { MachineCondition } from '@app/shared';
import type { LucideIcon } from 'lucide-react';
import { Archive, CircleCheck, CircleX, TriangleAlert, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

const CONDITIONS: Record<MachineCondition, { className: string; icon: LucideIcon; label: string }> =
  {
    OPERATIONAL: {
      className: 'border-status-available-border bg-status-available-bg text-status-available',
      icon: CircleCheck,
      label: 'Operational',
    },
    NEEDS_SERVICE: {
      className:
        'border-status-needs-service-border bg-status-needs-service-bg text-status-needs-service',
      icon: TriangleAlert,
      label: 'Needs service',
    },
    UNDER_MAINTENANCE: {
      className:
        'border-status-maintenance-border bg-status-maintenance-bg text-status-maintenance',
      icon: Wrench,
      label: 'Under maintenance',
    },
    OUT_OF_SERVICE: {
      className:
        'border-status-out-of-service-border bg-status-out-of-service-bg text-status-out-of-service',
      icon: CircleX,
      label: 'Out of service',
    },
    RETIRED: {
      className: 'border-status-retired-border bg-status-retired-bg text-status-retired',
      icon: Archive,
      label: 'Retired',
    },
  };

export function MachineConditionBadge({
  className,
  condition,
}: {
  className?: string;
  condition: MachineCondition;
}) {
  const value = CONDITIONS[condition];
  const Icon = value.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
        value.className,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {value.label}
    </span>
  );
}
