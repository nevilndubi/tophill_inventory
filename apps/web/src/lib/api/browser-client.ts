import { publicEnv } from '@/env/public';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { ApiClientError, createApiClient } from './client';

const getBrowserAccessToken = async (): Promise<string | null> => {
  const supabase = createBrowserSupabaseClient();
  const session = await supabase.auth.getSession();
  return session.data.session?.access_token ?? null;
};

const refreshBrowserAccessToken = async (): Promise<string | null> => {
  const supabase = createBrowserSupabaseClient();
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error && isAuthRetryableFetchError(refreshed.error)) {
    throw new ApiClientError(
      {
        code: 'AUTH_UNAVAILABLE',
        message: 'Authentication is temporarily unavailable.',
        details: {},
      },
      503,
    );
  }
  return refreshed.data.session?.access_token ?? null;
};

const dispatchAuthEvent = (name: string, detail?: unknown) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
};

export const browserApi = createApiClient({
  origin: publicEnv.NEXT_PUBLIC_API_URL,
  getAccessToken: getBrowserAccessToken,
  refreshAccessToken: refreshBrowserAccessToken,
  onForbidden(error) {
    dispatchAuthEvent('tophill:forbidden', { code: error.code });
  },
  onUnauthorized() {
    dispatchAuthEvent('tophill:session-invalid');
  },
  onUnavailable() {
    dispatchAuthEvent('tophill:auth-unavailable');
  },
});
