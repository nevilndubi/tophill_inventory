import type { AuthenticatedUser } from '../auth/auth.types';
import { assertDepartmentAccess, departmentScopeFilter } from './department-scope';

const user = (role: AuthenticatedUser['role'], departmentId: string | null): AuthenticatedUser => ({
  department:
    departmentId === null ? null : { code: 'ICU', id: departmentId, name: 'Intensive Care Unit' },
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role,
});

describe('department authorization helpers', () => {
  it('allows only a DEPT_MANAGER whose database department matches the resource', () => {
    expect(() => assertDepartmentAccess(user('DEPT_MANAGER', 'dept-a'), 'dept-a')).not.toThrow();
    expect(() => assertDepartmentAccess(user('DEPT_MANAGER', 'dept-a'), 'dept-b')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertDepartmentAccess(user('DEPT_MANAGER', null), 'dept-a')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertDepartmentAccess(user('DEPT_MANAGER', 'dept-a'), null)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertDepartmentAccess(user('STAFF', 'dept-a'), 'dept-a')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('returns a global list filter only for globally scoped access', () => {
    expect(departmentScopeFilter(user('ADMIN', null), 'booking:approve')).toEqual({});
  });

  it('returns the database-backed department filter for scoped access', () => {
    expect(departmentScopeFilter(user('DEPT_MANAGER', 'dept-a'), 'booking:approve')).toEqual({
      departmentId: 'dept-a',
    });
    expect(departmentScopeFilter(user('DEPT_MANAGER', 'dept-a'), 'usage:force-end')).toEqual({
      departmentId: 'dept-a',
    });
    expect(departmentScopeFilter(user('DEPT_MANAGER', 'dept-a'), 'report:read')).toEqual({
      departmentId: 'dept-a',
    });
  });

  it('denies missing departments and permissions with NONE scope', () => {
    expect(() => departmentScopeFilter(user('DEPT_MANAGER', null), 'booking:approve')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => departmentScopeFilter(user('STAFF', 'dept-a'), 'booking:approve')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
