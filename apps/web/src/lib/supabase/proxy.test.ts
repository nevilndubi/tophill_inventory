import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { updateSession } from './proxy';

type TestCookie = {
  name: string;
  options: { path?: string };
  value: string;
};

type TestClientOptions = {
  cookies: {
    setAll: (cookies: TestCookie[], headers: Record<string, string>) => void;
  };
};

const clientFactory = (
  result: { data: { claims?: { sub: string } } | null; error: Error | null },
  onClaims?: (options: TestClientOptions) => void,
) =>
  ((...args: unknown[]) => {
    const options = args[2] as TestClientOptions;
    return {
      auth: {
        getClaims: vi.fn(async () => {
          onClaims?.(options);
          return result;
        }),
      },
    };
  }) as never;

describe('Supabase request proxy', () => {
  it('redirects an unauthenticated application visit to login with a safe return path', async () => {
    const request = new NextRequest('http://localhost:3000/admin?tab=users');
    const response = await updateSession(
      request,
      clientFactory({ data: null, error: new Error('missing session') }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?returnTo=%2Fadmin%3Ftab%3Dusers',
    );
  });

  it('refreshes session cookies and forwards the required private cache headers', async () => {
    const request = new NextRequest('http://localhost:3000/');
    const response = await updateSession(
      request,
      clientFactory(
        { data: { claims: { sub: '00000000-0000-4000-8000-000000000001' } }, error: null },
        (options) => {
          options.cookies.setAll(
            [{ name: 'sb-test-auth-token', value: 'opaque-cookie-value', options: { path: '/' } }],
            { 'cache-control': 'private, no-store' },
          );
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.cookies.has('sb-test-auth-token')).toBe(true);
    expect(response.headers.get('x-middleware-request-x-tophill-return-path')).toBe('/');
  });

  it('redirects an authenticated login visit to a validated same-origin target', async () => {
    const request = new NextRequest(
      'http://localhost:3000/login?returnTo=https%3A%2F%2Fattacker.example%2Fcollect',
    );
    const response = await updateSession(
      request,
      clientFactory({
        data: { claims: { sub: '00000000-0000-4000-8000-000000000001' } },
        error: null,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
  });

  it('does not turn a retryable provider outage into a login redirect', async () => {
    const request = new NextRequest('http://localhost:3000/admin');
    const response = await updateSession(
      request,
      clientFactory({
        data: null,
        error: new AuthRetryableFetchError('temporarily unavailable', 503),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
