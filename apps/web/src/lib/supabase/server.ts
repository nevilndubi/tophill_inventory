import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { publicEnv } from '@/env/public';
import { supabaseCookieOptions } from './cookie-options';

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: supabaseCookieOptions,
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, options, value }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot write cookies. The request proxy owns refresh writes.
          }
        },
      },
    },
  );
}

export type ValidatedAccessToken =
  { kind: 'missing' } | { kind: 'unavailable' } | { kind: 'valid'; token: string };

export async function getValidatedAccessToken(): Promise<ValidatedAccessToken> {
  const supabase = await createServerSupabaseClient();
  const claims = await supabase.auth.getClaims();

  if (claims.error) {
    return isAuthRetryableFetchError(claims.error) ? { kind: 'unavailable' } : { kind: 'missing' };
  }
  if (!claims.data?.claims) {
    return { kind: 'missing' };
  }

  // getClaims() above is the trust decision. getSession() is used only to obtain
  // the opaque bearer that the API independently verifies again.
  const session = await supabase.auth.getSession();
  if (session.error) {
    return isAuthRetryableFetchError(session.error) ? { kind: 'unavailable' } : { kind: 'missing' };
  }
  return session.data.session?.access_token
    ? { kind: 'valid', token: session.data.session.access_token }
    : { kind: 'missing' };
}
