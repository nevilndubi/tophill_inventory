'use client';

import type { ReactNode } from 'react';
import {
  CalendarDays,
  ClipboardList,
  FileChartColumn,
  LayoutDashboard,
  Menu,
  MonitorCog,
  Stethoscope,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const navigation = [
  { label: 'Overview', icon: LayoutDashboard, active: true },
  { label: 'Machines', icon: MonitorCog },
  { label: 'Status board', icon: ClipboardList },
  { label: 'Bookings', icon: CalendarDays },
  { label: 'Service', icon: Stethoscope },
  { label: 'Reports', icon: FileChartColumn },
];

function Navigation({ compact = false }: { compact?: boolean }) {
  return (
    <nav aria-label="Primary navigation" className="mt-8 space-y-1.5 px-3">
      {navigation.map(({ active, icon: Icon, label }) => (
        <div
          key={label}
          aria-current={active ? 'page' : undefined}
          aria-disabled={active ? undefined : true}
          className={cn(
            'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium',
            active
              ? 'bg-sidebar-accent text-white shadow-[inset_3px_0_0_var(--color-primary)]'
              : 'cursor-not-allowed text-sidebar-muted',
            compact && 'justify-center px-2 lg:justify-start lg:px-3',
          )}
          title={compact ? label : undefined}
        >
          <Icon className="size-5 shrink-0" aria-hidden="true" />
          <span className={cn(compact && 'sr-only lg:not-sr-only')}>{label}</span>
        </div>
      ))}
    </nav>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-16 items-center px-6',
        compact && 'justify-center px-2 lg:justify-start lg:px-6',
      )}
    >
      <span
        className={cn(
          'text-lg font-semibold tracking-tight text-white',
          compact && 'sr-only lg:not-sr-only',
        )}
      >
        Tophill Inventory
      </span>
      {compact ? (
        <span className="hidden size-9 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground md:flex lg:hidden">
          TI
        </span>
      ) : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-20 border-r border-sidebar-border bg-sidebar md:block lg:w-64">
        <Brand compact />
        <Navigation compact />
      </aside>

      <div className="md:pl-20 lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mr-2 md:hidden"
                aria-label="Open navigation"
              >
                <Menu className="size-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle className="sr-only">Tophill Inventory navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Navigate between inventory workspace areas.
              </SheetDescription>
              <Brand />
              <Navigation />
            </SheetContent>
          </Sheet>
          <p className="text-base font-semibold tracking-tight sm:text-lg">Overview</p>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
          {children}
        </main>
      </div>
    </div>
  );
}
