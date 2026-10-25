import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays,
  ClipboardList,
  FileChartColumn,
  LayoutDashboard,
  MonitorCog,
  Settings,
  Stethoscope,
} from 'lucide-react';
import type { AppRole, Permission } from '@app/shared';
import { can, getPermissionScope } from '@app/shared';

export type NavigationEntry = {
  href: string;
  icon: LucideIcon;
  label: string;
  permission: Permission;
  status: 'available' | 'coming-soon';
};

export const NAVIGATION_ENTRIES = [
  {
    href: '/',
    icon: LayoutDashboard,
    label: 'Overview',
    permission: 'machine:read',
    status: 'available',
  },
  {
    href: '/machines',
    icon: MonitorCog,
    label: 'Machines',
    permission: 'machine:read',
    status: 'coming-soon',
  },
  {
    href: '/status',
    icon: ClipboardList,
    label: 'Status board',
    permission: 'machine:read',
    status: 'coming-soon',
  },
  {
    href: '/bookings',
    icon: CalendarDays,
    label: 'Bookings',
    permission: 'booking:create',
    status: 'coming-soon',
  },
  {
    href: '/service',
    icon: Stethoscope,
    label: 'Service',
    permission: 'service:manage',
    status: 'coming-soon',
  },
  {
    href: '/reports',
    icon: FileChartColumn,
    label: 'Reports',
    permission: 'report:read',
    status: 'coming-soon',
  },
  {
    href: '/admin',
    icon: Settings,
    label: 'Administration',
    permission: 'user:manage',
    status: 'available',
  },
] as const satisfies readonly NavigationEntry[];

export const navigationForRole = (role: AppRole): readonly NavigationEntry[] =>
  NAVIGATION_ENTRIES.filter(
    (entry) => can(role, entry.permission) && getPermissionScope(role, entry.permission) !== 'NONE',
  );
