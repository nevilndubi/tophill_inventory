import type { Request } from 'express';
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
  user?: AuthenticatedUser;
};

export type VerifiedAccessToken = {
  subject: string;
};
