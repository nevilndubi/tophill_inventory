import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell } from './app-shell';

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
  });
});
