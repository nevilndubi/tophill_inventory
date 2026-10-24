import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '@/env/public';
import { loginUrl, safeReturnPath } from '@/lib/auth/return-path';
import { supabaseCookieOptions } from './cookie-options';

type ProxyClientFactory = typeof createServerClient;

export async function updateSession(
  request: NextRequest,
  clientFactory: ProxyClientFactory = createServerClient,
) {
  let response = NextResponse.next({ request });

  const supabase = clientFactory(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: supabaseCookieOptions,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, options, value }) => {
            response.cookies.set(name, value, options as CookieOptions);
          });
          Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );

  // Supabase's validated claims call also refreshes an expiring session.
  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !error && Boolean(data?.claims);
  const pathname = request.nextUrl.pathname;

  if (error && isAuthRetryableFetchError(error)) {
    // The proxy is only an optimistic UX boundary. Let the server page render
    // the retryable unavailable state without clearing or redirecting a session.
    return response;
  }

  if (!isAuthenticated && pathname !== '/login') {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = new URL(
      loginUrl(`${pathname}${request.nextUrl.search}`),
      request.url,
    ).search;
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthenticated && pathname === '/login') {
    const redirectUrl = request.nextUrl.clone();
    const returnPath = safeReturnPath(request.nextUrl.searchParams.get('returnTo'));
    const target = new URL(returnPath, request.url);
    redirectUrl.pathname = target.pathname;
    redirectUrl.search = target.search;
    redirectUrl.hash = target.hash;
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
