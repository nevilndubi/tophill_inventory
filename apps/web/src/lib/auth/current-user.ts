import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ROLES } from '@app/shared';
import { z } from 'zod';
import { ApiClientError } from '@/lib/api/client';
import { createServerApi } from '@/lib/api/server-client';
import { getValidatedAccessToken } from '@/lib/supabase/server';
import { loginUrl, safeReturnPath } from './return-path';
import type { AppUser } from './types';
import { e2eMockUser, isE2EMockAuthEnabled } from './e2e-mock';

const appUserSchema = z.object({
  department: z
    .object({
      code: z.string(),
      id: z.uuid(),
      name: z.string(),
    })
    .nullable(),
  email: z.email(),
  fullName: z.string(),
  id: z.uuid(),
  isActive: z.boolean(),
  role: z.enum(ROLES),
});

type AppUserResult =
  | { kind: 'authenticated'; user: AppUser }
  | { kind: 'no-access' }
  | { kind: 'session-invalid' }
  | { kind: 'unavailable' };

export const loadCurrentAppUser = cache(async (): Promise<AppUserResult> => {
  if (isE2EMockAuthEnabled()) {
    return { kind: 'authenticated', user: e2eMockUser((await headers()).get('x-e2e-role')) };
  }
  const accessToken = await getValidatedAccessToken();
  if (accessToken.kind === 'unavailable') {
    return { kind: 'unavailable' };
  }
  if (accessToken.kind === 'missing') {
    return { kind: 'session-invalid' };
  }

  try {
    const data = await createServerApi(accessToken.token).request<AppUser>('/me');
    const parsed = appUserSchema.safeParse(data);
    return parsed.success ? { kind: 'authenticated', user: parsed.data } : { kind: 'unavailable' };
  } catch (error) {
    if (error instanceof ApiClientError) {
      if (error.status === 401) {
        return { kind: 'session-invalid' };
      }
      if (
        error.status === 403 &&
        (error.code === 'USER_INACTIVE' || error.code === 'USER_NOT_PROVISIONED')
      ) {
        return { kind: 'no-access' };
      }
      if (error.status === 503 && error.code === 'AUTH_UNAVAILABLE') {
        return { kind: 'unavailable' };
      }
    }
    return { kind: 'unavailable' };
  }
});

export async function requireCurrentAppUser(returnPath = '/'): Promise<AppUser> {
  const result = await loadCurrentAppUser();
  const safePath = safeReturnPath(returnPath);

  if (result.kind === 'session-invalid') {
    redirect(`/auth/session-invalid?returnTo=${encodeURIComponent(safePath)}`);
  }
  if (result.kind === 'no-access') {
    redirect('/no-access');
  }
  if (result.kind === 'unavailable') {
    redirect(`/temporarily-unavailable?returnTo=${encodeURIComponent(safePath)}`);
  }

  return result.user;
}

export function unauthenticatedLoginUrl(returnPath: string): string {
  return loginUrl(safeReturnPath(returnPath));
}
