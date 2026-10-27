import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUser } from '@/lib/auth/types';
import { AuthenticatedUserProvider, useAuthenticatedUser } from './authenticated-user-provider';
import { LogoutButton } from './logout-button';
import { LABEL_SELECTION_STORAGE_KEY } from '@/lib/machines/asset-labels';

const mocks = vi.hoisted(() => ({
  authStateCallback: undefined as ((event: string) => void) | undefined,
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock('@/lib/supabase/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      onAuthStateChange: (callback: (event: string) => void) => {
        mocks.authStateCallback = callback;
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
      signOut: mocks.signOut,
    },
  }),
}));

const userFromMe: AppUser = {
  department: { code: 'ICU', id: '00000000-0000-4000-8000-000000000002', name: 'ICU' },
  email: 'masked',
  fullName: 'Test User',
  id: '00000000-0000-4000-8000-000000000001',
  isActive: true,
  role: 'STAFF',
};

function UserProbe() {
  const { user } = useAuthenticatedUser();
  return <p>{`${user.id}:${user.role}:${user.department?.code}`}</p>;
}

const renderProvider = (queryClient: QueryClient, navigateToLogin = vi.fn()) =>
  render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider initialUser={userFromMe} navigateToLogin={navigateToLogin}>
        <UserProbe />
        <LogoutButton />
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );

describe('AuthenticatedUserProvider', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.authStateCallback = undefined;
    mocks.push.mockReset();
    mocks.refresh.mockReset();
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.unsubscribe.mockReset();
  });

  it('exposes only the local /me application context to client children', () => {
    renderProvider(new QueryClient());
    expect(screen.getByText(`${userFromMe.id}:STAFF:ICU`)).toBeInTheDocument();
  });

  it('clears the entire query cache before logout and redirects to login', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['previous-person', 'private'], { private: true });
    const navigate = vi.fn();
    sessionStorage.setItem(LABEL_SELECTION_STORAGE_KEY, '[{"id":"private"}]');
    renderProvider(queryClient, navigate);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(sessionStorage.getItem(LABEL_SELECTION_STORAGE_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('reacts to a signed-out event from another tab and clears cached data', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['previous-person'], { private: true });
    const navigate = vi.fn();
    sessionStorage.setItem(LABEL_SELECTION_STORAGE_KEY, '[{"id":"private"}]');
    renderProvider(queryClient, navigate);

    act(() => mocks.authStateCallback?.('SIGNED_OUT'));

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionStorage.getItem(LABEL_SELECTION_STORAGE_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('clears local state after a terminal 401 without creating a redirect loop', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['previous-person'], { private: true });
    const navigate = vi.fn();
    renderProvider(queryClient, navigate);

    act(() => window.dispatchEvent(new CustomEvent('tophill:session-invalid')));

    await vi.waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('keeps 403 and auth-outage behavior separate from sign-out', () => {
    renderProvider(new QueryClient());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('tophill:forbidden', { detail: { code: 'PERMISSION_DENIED' } }),
      );
    });
    expect(mocks.push).toHaveBeenCalledWith('/forbidden');

    act(() => window.dispatchEvent(new CustomEvent('tophill:auth-unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['USER_INACTIVE', 'USER_NOT_PROVISIONED'])(
    'routes %s to the dedicated no-access page',
    (code) => {
      renderProvider(new QueryClient());

      act(() => {
        window.dispatchEvent(new CustomEvent('tophill:forbidden', { detail: { code } }));
      });

      expect(mocks.push).toHaveBeenCalledWith('/no-access');
      expect(mocks.signOut).not.toHaveBeenCalled();
    },
  );
});
