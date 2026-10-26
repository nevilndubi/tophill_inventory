import { describe, expect, it } from 'vitest';
import { can, ROLES, type AppRole } from '@app/shared';

const expected = {
  SUPER_ADMIN: { create: true, edit: true, view: true },
  ADMIN: { create: true, edit: true, view: true },
  BIOMED_TECH: { create: false, edit: true, view: true },
  DEPT_MANAGER: { create: false, edit: false, view: true },
  STAFF: { create: false, edit: false, view: true },
  VIEWER: { create: false, edit: false, view: true },
} as const satisfies Record<AppRole, { create: boolean; edit: boolean; view: boolean }>;

describe('machine UI capability table', () => {
  it.each(ROLES)('matches the hand-written Task 3.4 table for %s', (role) => {
    expect({
      create: can(role, 'machine:create'),
      edit: can(role, 'machine:update'),
      view: can(role, 'machine:read'),
    }).toEqual(expected[role]);
  });
});
