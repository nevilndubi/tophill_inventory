import type { AppRole } from '@app/shared';

export type AppUser = {
  department: {
    code: string;
    id: string;
    name: string;
  } | null;
  email: string;
  fullName: string;
  id: string;
  isActive: boolean;
  role: AppRole;
};

export type AuthFailureKind =
  'AUTH_UNAVAILABLE' | 'PERMISSION_DENIED' | 'USER_INACTIVE' | 'USER_NOT_PROVISIONED';
