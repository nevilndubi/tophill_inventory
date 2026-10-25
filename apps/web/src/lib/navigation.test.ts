import { describe, expect, it } from 'vitest';
import { ROLES, isPermission, type AppRole } from '@app/shared';
import { NAVIGATION_ENTRIES, navigationForRole } from './navigation';

const expectedLabels = {
  SUPER_ADMIN: [
    'Overview',
    'Machines',
    'Status board',
    'Bookings',
    'Service',
    'Reports',
    'Administration',
  ],
  ADMIN: [
    'Overview',
    'Machines',
    'Status board',
    'Bookings',
    'Service',
    'Reports',
    'Administration',
  ],
  BIOMED_TECH: ['Overview', 'Machines', 'Status board', 'Bookings', 'Service', 'Reports'],
  DEPT_MANAGER: ['Overview', 'Machines', 'Status board', 'Bookings', 'Reports'],
  STAFF: ['Overview', 'Machines', 'Status board', 'Bookings'],
  VIEWER: ['Overview', 'Machines', 'Status board', 'Reports'],
} as const satisfies Record<AppRole, readonly string[]>;

describe('role-aware navigation', () => {
  it('references only real shared permissions', () => {
    expect(NAVIGATION_ENTRIES.every((entry) => isPermission(entry.permission))).toBe(true);
  });

  it.each(ROLES)('matches the hand-transcribed matrix for %s', (role) => {
    expect(navigationForRole(role).map((entry) => entry.label)).toEqual(expectedLabels[role]);
  });

  it('hides administrative navigation from STAFF', () => {
    expect(navigationForRole('STAFF').some((entry) => entry.label === 'Administration')).toBe(
      false,
    );
  });

  it('marks every unbuilt destination as coming soon instead of linking to a missing page', () => {
    expect(
      NAVIGATION_ENTRIES.filter((entry) => !['/', '/admin'].includes(entry.href)).every(
        (entry) => entry.status === 'coming-soon',
      ),
    ).toBe(true);
    expect(NAVIGATION_ENTRIES.find((entry) => entry.href === '/admin')?.status).toBe('available');
  });
});
