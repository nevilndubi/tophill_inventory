import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { UserManagement } from './user-management';

const mocks = vi.hoisted(() => ({
  actor: {
    department: null,
    email: 'actor@example.invalid',
    fullName: 'Test Administrator',
    id: '11111111-1111-4111-8111-111111111111',
    isActive: true,
    role: 'SUPER_ADMIN' as const,
  },
  departments: vi.fn(),
  invite: vi.fn(),
  list: vi.fn(),
  setActive: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/components/authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({ signOut: vi.fn(), user: mocks.actor }),
}));
vi.mock('@/lib/api/users', () => ({
  usersApi: {
    departments: mocks.departments,
    invite: mocks.invite,
    list: mocks.list,
    setActive: mocks.setActive,
    update: mocks.update,
  },
}));

const managedUser = {
  department: {
    code: 'ICU',
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Intensive Care Unit',
  },
  email: 'managed@example.invalid',
  fullName: 'Managed Person',
  id: '33333333-3333-4333-8333-333333333333',
  isActive: true,
  lastLoginAt: null,
  role: 'STAFF' as const,
};

const renderManagement = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UserManagement />
    </QueryClientProvider>,
  );
};

describe('UserManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.actor, { id: '11111111-1111-4111-8111-111111111111', role: 'SUPER_ADMIN' });
    mocks.departments.mockResolvedValue([managedUser.department]);
    mocks.list.mockResolvedValue({ items: [managedUser], page: 1, pageSize: 25, total: 1 });
    mocks.invite.mockResolvedValue(managedUser);
    mocks.setActive.mockResolvedValue({ ...managedUser, isActive: false });
    mocks.update.mockResolvedValue(managedUser);
  });

  it('renders the user, status, department, and invited-not-signed-in state', async () => {
    renderManagement();
    expect(await screen.findAllByText('Managed Person')).not.toHaveLength(0);
    expect(screen.getAllByText('Invited, not yet signed in')).not.toHaveLength(0);
    expect(screen.getAllByText('Intensive Care Unit')).not.toHaveLength(0);
    expect(screen.queryByText(/supabase/i)).not.toBeInTheDocument();
  });

  it('submits server-side search filters with stable pagination', async () => {
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Managed Person');
    await user.type(screen.getByLabelText('Name or email'), 'ward');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, pageSize: 25, search: 'ward' }),
      ),
    );
  });

  it('creates an invitation and reports duplicate identities with a friendly message', async () => {
    const user = userEvent.setup();
    mocks.invite.mockRejectedValueOnce(
      new ApiClientError({ code: 'AUTH_IDENTITY_EXISTS', details: {}, message: 'internal' }, 409),
    );
    renderManagement();
    await screen.findAllByText('Managed Person');
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Full name'), 'New Person');
    await user.type(within(dialog).getByLabelText('Email address'), 'new@example.invalid');
    await user.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    expect(
      await within(dialog).findByText(/authentication identity already exists/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('internal')).not.toBeInTheDocument();
  });

  it('hides forbidden role choices and disables SUPER_ADMIN controls for ADMIN', async () => {
    Object.assign(mocks.actor, { role: 'ADMIN' });
    mocks.list.mockResolvedValue({
      items: [{ ...managedUser, role: 'SUPER_ADMIN' }],
      page: 1,
      pageSize: 25,
      total: 1,
    });
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Managed Person');
    expect(screen.getAllByRole('button', { name: 'Edit' })[0]).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.click(within(screen.getByRole('dialog')).getByLabelText('Role'));
    expect(screen.queryByRole('option', { name: 'Super administrator' })).not.toBeInTheDocument();
  });

  it('uses a named destructive confirmation before deactivation', async () => {
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Managed Person');
    await user.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]!);
    const alert = screen.getByRole('alertdialog');
    expect(within(alert).getByText(/Deactivate Managed Person/)).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(managedUser.id, false));
  });
});
