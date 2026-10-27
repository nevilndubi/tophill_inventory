import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));

vi.mock('@/lib/supabase/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { signInWithPassword: mocks.signInWithPassword },
  }),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    mocks.refresh.mockReset();
    mocks.replace.mockReset();
    mocks.signInWithPassword.mockReset();
  });

  it('signs in with password and lands on the validated return path', async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginForm returnTo="/admin" />);

    await user.type(screen.getByLabelText('Email address'), 'masked-identity');
    await user.type(screen.getByLabelText('Password'), 'not-a-real-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'masked-identity',
      password: 'not-a-real-password',
    });
    expect(mocks.replace).toHaveBeenCalledWith('/admin');
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('uses one generic message for invalid credentials and exposes no alternative auth links', async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: new Error('provider detail') });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email address'), 'masked-identity');
    await user.type(screen.getByLabelText('Password'), 'wrong-value');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
    expect(screen.queryByText(/sign up|magic link|reset password/i)).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('disables the form while a sign-in request is pending', async () => {
    let resolveSignIn: ((value: { error: null }) => void) | undefined;
    mocks.signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email address'), 'masked-identity');
    await user.type(screen.getByLabelText('Password'), 'not-a-real-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByLabelText('Email address')).toBeDisabled();
    resolveSignIn?.({ error: null });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'));
  });

  it('supports the development-only browser journey without contacting Supabase', async () => {
    const user = userEvent.setup();
    render(<LoginForm e2eMockMode returnTo="/scan/HM-000123" />);
    await user.type(screen.getByLabelText('Email address'), 'browser@example.invalid');
    await user.type(screen.getByLabelText('Password'), 'not-a-real-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(document.cookie).toContain('tophill-e2e-auth=signed-in');
    expect(mocks.replace).toHaveBeenCalledWith('/scan/HM-000123');
  });
});
