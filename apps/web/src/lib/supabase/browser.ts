'use client';

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '@/env/public';
import { supabaseCookieOptions } from './cookie-options';

export function createBrowserSupabaseClient() {
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { cookieOptions: supabaseCookieOptions },
  );
}
