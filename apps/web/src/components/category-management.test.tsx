import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { CategoryManagement } from './category-management';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/api/categories', () => ({
  categoriesApi: {
    create: mocks.create,
    delete: mocks.delete,
    list: mocks.list,
    update: mocks.update,
  },
}));

const category = {
  defaultMaxBookingMinutes: 120,
  defaultServiceIntervalDays: 180,
  description: 'Life support equipment',
  id: '11111111-1111-4111-8111-111111111111',
  is_deletable: true,
  machine_count: 0,
  name: 'Ventilator',
};

const renderManagement = () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CategoryManagement />
    </QueryClientProvider>,
  );
};

describe('CategoryManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([category]);
    mocks.create.mockResolvedValue(category);
    mocks.update.mockResolvedValue(category);
    mocks.delete.mockResolvedValue(category);
  });

  it('shows all category fields and responsive desktop/mobile representations', async () => {
    renderManagement();
    expect((await screen.findAllByText('Ventilator')).length).toBeGreaterThan(1);
    expect(screen.getAllByText('Life support equipment').length).toBeGreaterThan(1);
    expect(screen.getAllByText('180 days').length).toBeGreaterThan(1);
    expect(screen.getAllByText('120 min').length).toBeGreaterThan(1);
  });

  it('normalizes input, clears blank optionals, and creates through the typed client', async () => {
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Ventilator');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), '  Patient   Monitor  ');
    await user.type(within(dialog).getByLabelText('Description'), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        defaultMaxBookingMinutes: null,
        defaultServiceIntervalDays: null,
        description: null,
        name: 'Patient Monitor',
      }),
    );
  });

  it('focuses the first invalid field and shows shared-schema bounds inline', async () => {
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Ventilator');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Default booking limit (minutes)'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));
    expect(await within(dialog).findByText('Name is required')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    expect(within(dialog).getByText('Maximum booking time must be at least 5')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('edits with explicit null clears and translates duplicate-name conflicts', async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      new ApiClientError({ code: 'CATEGORY_NAME_TAKEN', details: {}, message: 'internal' }, 409),
    );
    renderManagement();
    await screen.findAllByText('Ventilator');
    await user.click(screen.getAllByRole('button', { name: 'Edit Ventilator' })[0]!);
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Default service interval (days)'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/already exists/i)).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledWith(
      category.id,
      expect.objectContaining({ defaultServiceIntervalDays: null }),
    );
    expect(within(dialog).queryByText('internal')).not.toBeInTheDocument();
  });

  it('names the category in destructive confirmation', async () => {
    const user = userEvent.setup();
    renderManagement();
    await screen.findAllByText('Ventilator');
    await user.click(screen.getAllByRole('button', { name: 'Delete Ventilator' })[0]!);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Delete Ventilator?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith(category.id));
  });

  it('disables delete and explains references even when active machine count is zero', async () => {
    mocks.list.mockResolvedValue([
      { ...category, is_deletable: false, machine_count: 0, name: 'Archived equipment' },
    ]);
    renderManagement();
    const buttons = await screen.findAllByRole('button', { name: 'Delete Archived equipment' });
    expect(buttons[0]).toBeDisabled();
    expect(
      screen.getAllByText(/Referenced by archived or retired machines/).length,
    ).toBeGreaterThan(0);
  });

  it('provides loading, empty, and recoverable error states', async () => {
    mocks.list.mockResolvedValueOnce([]);
    const empty = renderManagement();
    expect(await screen.findByText('No machine categories')).toBeInTheDocument();
    empty.unmount();

    mocks.list.mockRejectedValueOnce(new Error('offline'));
    renderManagement();
    expect(await screen.findByText('Categories could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
