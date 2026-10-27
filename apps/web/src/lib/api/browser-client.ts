import { publicEnv } from '@/env/public';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { ApiClientError, createApiClient, isConfiguredApiUrl } from './client';

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

export const authenticatedBrowserFetch = async (
  path: string,
  options: RequestInit = {},
): Promise<Response> => {
  const target = browserApi.versionedUrl(path);
  const token = await getBrowserAccessToken();
  const headers = new Headers(options.headers);
  headers.set('accept', options.headers && headers.has('accept') ? headers.get('accept')! : '*/*');
  if (token && isConfiguredApiUrl(publicEnv.NEXT_PUBLIC_API_URL, target)) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return fetch(target, { ...options, headers });
};
