import type { AppRole } from '@app/shared';
import { isAppRole } from '@app/shared';
import type { AppUser } from './types';

export const isE2EMockAuthEnabled = (): boolean =>
  process.env.NODE_ENV !== 'production' && process.env.PLAYWRIGHT_MOCK_MODE === '1';

export const e2eMockUser = (requestedRole: string | null): AppUser => {
  const role: AppRole =
    requestedRole !== null && isAppRole(requestedRole) ? requestedRole : 'ADMIN';
  return {
    department: {
      code: 'TEST',
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Test Department',
    },
    email: 'masked@example.invalid',
    fullName: 'Browser Test User',
    id: '00000000-0000-4000-8000-000000000001',
    isActive: true,
    role,
  };
};
