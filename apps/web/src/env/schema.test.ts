import { describe, expect, it } from 'vitest';
import { parseWebPublicEnvironment, parseWebServerEnvironment } from './schema';

describe('web environment', () => {
  it('accepts only browser-safe Supabase configuration in the public schema', () => {
    expect(
      parseWebPublicEnvironment({
        NEXT_PUBLIC_APP_ORIGIN: 'https://inventory.example.test',
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_browser_safe',
      }),
    ).toEqual({
      NEXT_PUBLIC_APP_ORIGIN: 'https://inventory.example.test',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_browser_safe',
    });
  });

  it('rejects a legacy or server-only key in the public key slot', () => {
    expect(() =>
      parseWebPublicEnvironment({
        NEXT_PUBLIC_APP_ORIGIN: 'https://inventory.example.test',
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_must_never_be_public',
      }),
    ).toThrow('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: must be a modern sb_publishable_ key');
  });

  it('requires a path-free HTTPS application origin outside development localhost', () => {
    expect(() =>
      parseWebPublicEnvironment({
        NEXT_PUBLIC_APP_ORIGIN: 'https://inventory.example.test/app',
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_browser_safe',
      }),
    ).toThrow('NEXT_PUBLIC_APP_ORIGIN: must be an origin without a path or query');

    expect(() =>
      parseWebPublicEnvironment({
        NEXT_PUBLIC_APP_ORIGIN: 'https://inventory.example.test/',
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_browser_safe',
      }),
    ).toThrow('NEXT_PUBLIC_APP_ORIGIN: must not have a trailing slash');
  });

  it('keeps Supabase credentials out of the server-only web schema', () => {
    expect(
      parseWebServerEnvironment({
        API_BASE_URL: 'http://127.0.0.1:3001',
        SUPABASE_SECRET_KEY: 'sb_secret_ignored_by_schema',
      }),
    ).toEqual({ API_BASE_URL: 'http://127.0.0.1:3001' });
  });
});
