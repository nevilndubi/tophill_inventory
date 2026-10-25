import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({
    signOut: vi.fn(),
    user: {
      department: null,
      email: 'masked',
      fullName: 'Test User',
      id: '00000000-0000-4000-8000-000000000001',
      isActive: true,
      role: 'STAFF',
    },
  }),
}));

describe('AppShell', () => {
  it('opens the mobile navigation drawer from the top bar', async () => {
    const user = userEvent.setup();
    render(
      <AppShell>
        <p>Page content</p>
      </AppShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('Tophill Inventory')).toBeInTheDocument();
    expect(within(dialog).getByText('Overview')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
