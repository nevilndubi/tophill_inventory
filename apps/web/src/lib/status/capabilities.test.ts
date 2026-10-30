import { describe, expect, it } from 'vitest';
import { ROLES, type AppRole, type MachineLiveStatus } from '@app/shared';
import { statusQuickActions } from './capabilities';

const machine = (holder: 'none' | 'own' | 'other', departmentId = 'dept-a'): MachineLiveStatus => ({
  as_of: '2026-10-30T06:00:00.000Z',
  asset_tag: 'HM-000001',
  category: { id: 'category', name: 'Ventilator' },
  department: { code: 'ICU', id: departmentId, name: 'ICU' },
  display_status: holder === 'none' ? 'AVAILABLE_OK' : 'IN_USE',
  id: 'machine',
  location: { id: 'location', name: 'Bay A' },
  name: 'Ventilator',
  next_booking_at: null,
  open_session:
    holder === 'none'
      ? null
      : {
          expected_end_at: null,
          held_by_current_user: holder === 'own',
          holder: { full_name: 'Masked User', id: holder === 'own' ? 'actor' : 'other' },
          id: 'session',
          overdue: false,
          started_at: '2026-10-30T05:00:00.000Z',
        },
  service_due: false,
  stored_condition: 'OPERATIONAL',
  usable: holder === 'none',
});

const expected = {
  SUPER_ADMIN: { unused: 'OUT', own: 'IN', same: 'FORCE', other: 'FORCE' },
  ADMIN: { unused: 'OUT', own: 'IN', same: 'FORCE', other: 'FORCE' },
  BIOMED_TECH: { unused: 'OUT', own: 'IN', same: 'NONE', other: 'NONE' },
  DEPT_MANAGER: { unused: 'OUT', own: 'IN', same: 'FORCE', other: 'NONE' },
  STAFF: { unused: 'OUT', own: 'IN', same: 'NONE', other: 'NONE' },
  VIEWER: { unused: 'NONE', own: 'NONE', same: 'NONE', other: 'NONE' },
} as const satisfies Record<
  AppRole,
  Record<'unused' | 'own' | 'same' | 'other', 'OUT' | 'IN' | 'FORCE' | 'NONE'>
>;

describe('status quick actions', () => {
  it.each(ROLES)('matches the hand-written scope table for %s', (role) => {
    const actor = { departmentId: 'dept-a', id: 'actor', role };
    const scenarios = {
      unused: machine('none'),
      own: machine('own'),
      same: machine('other'),
      other: machine('other', 'dept-b'),
    } as const;
    const result = Object.fromEntries(
      Object.entries(scenarios).map(([key, value]) => {
        const actions = statusQuickActions(actor, value);
        return [
          key,
          actions.canCheckOut
            ? 'OUT'
            : actions.canCheckIn
              ? 'IN'
              : actions.canForceEnd
                ? 'FORCE'
                : 'NONE',
        ];
      }),
    );
    expect(result).toEqual(expected[role]);
  });

  it('denies department scope when the manager has no department', () => {
    expect(
      statusQuickActions(
        { departmentId: null, id: 'actor', role: 'DEPT_MANAGER' },
        machine('other'),
      ).canForceEnd,
    ).toBe(false);
  });
});
