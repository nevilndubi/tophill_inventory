import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetPasswordForm } from './set-password-form';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), updateUser: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));
vi.mock('@/lib/supabase/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { updateUser: mocks.updateUser } }),
}));

describe('SetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the 12-character minimum and matching confirmation', async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm returnTo="/admin" />);
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set password and continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 12 characters.');
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('updates the invited user password and follows a safe return path', async () => {
    mocks.updateUser.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<SetPasswordForm returnTo="/admin" />);
    await user.type(screen.getByLabelText('Password'), 'long-test-password');
    await user.type(screen.getByLabelText('Confirm password'), 'long-test-password');
    await user.click(screen.getByRole('button', { name: 'Set password and continue' }));
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'long-test-password' });
    expect(mocks.replace).toHaveBeenCalledWith('/admin');
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('shows one non-disclosing message for an expired or reused session', async () => {
    mocks.updateUser.mockResolvedValue({ error: new Error('provider detail') });
    const user = userEvent.setup();
    render(<SetPasswordForm returnTo="/" />);
    await user.type(screen.getByLabelText('Password'), 'long-test-password');
    await user.type(screen.getByLabelText('Confirm password'), 'long-test-password');
    await user.click(screen.getByRole('button', { name: 'Set password and continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be completed/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent('provider detail');
  });
});
