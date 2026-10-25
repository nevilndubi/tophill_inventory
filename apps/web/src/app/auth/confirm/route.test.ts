import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mocks = vi.hoisted(() => ({ verifyOtp: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));

describe('invite confirmation route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges only an invite token hash and removes it from the redirect URL', async () => {
    mocks.verifyOtp.mockResolvedValue({ error: null });
    const response = await GET(
      new NextRequest(
        'http://127.0.0.1:3000/auth/confirm?token_hash=test-only-hash&type=invite&returnTo=%2Fadmin',
      ),
    );

    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 'test-only-hash', type: 'invite' });
    const location = new URL(response.headers.get('location')!);
    expect(`${location.pathname}${location.search}`).toBe('/auth/set-password?returnTo=%2Fadmin');
    expect(location.search).not.toContain('token_hash');
  });

  it.each([
    ['missing hash', 'http://127.0.0.1:3000/auth/confirm?type=invite'],
    [
      'unsupported type',
      'http://127.0.0.1:3000/auth/confirm?token_hash=test-only-hash&type=recovery',
    ],
  ])('rejects %s without calling Supabase', async (_label, url) => {
    const response = await GET(new NextRequest(url));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/auth/invite-invalid');
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it('uses the same non-disclosing page for expired or reused invite links', async () => {
    mocks.verifyOtp.mockResolvedValue({ error: new Error('provider detail') });
    const response = await GET(
      new NextRequest('http://127.0.0.1:3000/auth/confirm?token_hash=test-only-hash&type=invite'),
    );
    expect(new URL(response.headers.get('location')!).pathname).toBe('/auth/invite-invalid');
  });
});
