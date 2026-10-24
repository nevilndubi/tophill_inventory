import type { Request } from 'express';
import type { Permission, PermissionScope } from '@app/shared';
import type { Role } from '../generated/prisma/enums';

export type AuthenticatedUser = {
  department: {
    code: string;
    id: string;
    name: string;
  } | null;
  email: string;
  fullName: string;
  id: string;
  isActive: boolean;
  role: Role;
};

export type AuthenticatedRequest = Request & {
  authorizationContext?: {
    permission: Permission | 'undeclared';
    scope?: PermissionScope;
  };
  user?: AuthenticatedUser;
};

export type VerifiedAccessToken = {
  subject: string;
};
