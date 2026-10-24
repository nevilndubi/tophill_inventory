import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getValidatedAccessToken: vi.fn(),
  request: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  getValidatedAccessToken: mocks.getValidatedAccessToken,
}));
vi.mock('@/lib/api/server-client', () => ({
  createServerApi: () => ({ request: mocks.request }),
}));

describe('local application-user bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getValidatedAccessToken.mockReset();
    mocks.request.mockReset();
  });

  it('loads the documented /me fields with a request-scoped bearer', async () => {
    mocks.getValidatedAccessToken.mockResolvedValue({ kind: 'valid', token: 'opaque-value' });
    mocks.request.mockResolvedValue({
      department: { code: 'ICU', id: '00000000-0000-4000-8000-000000000002', name: 'ICU' },
      email: `masked${String.fromCharCode(64)}example.invalid`,
      fullName: 'Test User',
      id: '00000000-0000-4000-8000-000000000001',
      isActive: true,
      role: 'STAFF',
    });
    const { loadCurrentAppUser } = await import('./current-user');

    await expect(loadCurrentAppUser()).resolves.toMatchObject({
      kind: 'authenticated',
      user: {
        department: { code: 'ICU' },
        id: '00000000-0000-4000-8000-000000000001',
        isActive: true,
        role: 'STAFF',
      },
    });
    expect(mocks.request).toHaveBeenCalledWith('/me');
  });

  it('does not call the API when validated Supabase claims are absent', async () => {
    mocks.getValidatedAccessToken.mockResolvedValue({ kind: 'missing' });
    const { loadCurrentAppUser } = await import('./current-user');

    await expect(loadCurrentAppUser()).resolves.toEqual({ kind: 'session-invalid' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
