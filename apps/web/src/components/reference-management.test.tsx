import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceManagement } from './reference-management';

const mocks = vi.hoisted(() => ({
  createDepartment: vi.fn(),
  createLocation: vi.fn(),
  deleteDepartment: vi.fn(),
  deleteLocation: vi.fn(),
  eligibleManagers: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  replace: vi.fn(),
  updateDepartment: vi.fn(),
  updateLocation: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/reference',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api/categories', () => ({
  categoriesApi: { create: vi.fn(), delete: vi.fn(), list: vi.fn(async () => []), update: vi.fn() },
}));
vi.mock('@/lib/api/reference', () => ({
  departmentsApi: {
    create: mocks.createDepartment,
    delete: mocks.deleteDepartment,
    eligibleManagers: mocks.eligibleManagers,
    list: mocks.listDepartments,
    update: mocks.updateDepartment,
  },
  locationsApi: {
    create: mocks.createLocation,
    delete: mocks.deleteLocation,
    list: mocks.listLocations,
    update: mocks.updateLocation,
  },
}));

const department = {
  code: 'ICU',
  id: '22222222-2222-4222-8222-222222222222',
  is_deletable: false,
  location_count: 1,
  machine_count: 2,
  manager: null,
  name: 'Intensive Care',
  user_count: 3,
};
const location = {
  building: 'Main',
  department: { code: 'ICU', id: department.id, name: department.name },
  floor: '1',
  id: '33333333-3333-4333-8333-333333333333',
  is_deletable: true,
  machine_count: 0,
  name: 'Bay A',
  room: '101',
};

const renderPage = (section: 'categories' | 'departments' | 'locations') => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReferenceManagement initialSection={section} />
    </QueryClientProvider>,
  );
};

describe('ReferenceManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDepartments.mockResolvedValue([department]);
    mocks.listLocations.mockResolvedValue({ items: [location], page: 1, pageSize: 50, total: 1 });
    mocks.eligibleManagers.mockResolvedValue([]);
    mocks.updateDepartment.mockResolvedValue(department);
    mocks.updateLocation.mockResolvedValue(location);
  });

  it('keeps keyboard-accessible sections in the URL and preserves Categories', async () => {
    const user = userEvent.setup();
    renderPage('categories');
    expect(screen.getByRole('tab', { name: 'Categories' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: 'Locations' }));
    expect(mocks.replace).toHaveBeenCalledWith('/admin/reference?section=locations', {
      scroll: false,
    });
  });

  it('shows minimized department state, no-manager state and dependency deletion guidance', async () => {
    renderPage('departments');
    expect(await screen.findByText(/No manager/)).toBeInTheDocument();
    expect(screen.getByText(/3 users · 1 locations · 2 machines/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Intensive Care' })).toBeDisabled();
  });

  it('loads only eligible manager names and warns that codes affect reports', async () => {
    const user = userEvent.setup();
    mocks.eligibleManagers.mockResolvedValue([
      { full_name: 'Manager One', id: '11111111-1111-4111-8111-111111111111' },
    ]);
    renderPage('departments');
    await user.click(await screen.findByRole('button', { name: 'Edit Intensive Care' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/changes future report labels/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: 'Manager' }));
    expect(await screen.findByRole('option', { name: 'Manager One' })).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('filters locations, keeps department immutable on edit and names destructive actions', async () => {
    const user = userEvent.setup();
    renderPage('locations');
    expect(await screen.findByText('Bay A')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Bay A' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Department' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete Bay A' }));
    expect(within(screen.getByRole('alertdialog')).getByText('Delete Bay A?')).toBeInTheDocument();
  });

  it('normalizes department input through the shared schema', async () => {
    const user = userEvent.setup();
    mocks.createDepartment.mockResolvedValue({ ...department, code: 'RAD-1', name: 'Radiology' });
    renderPage('departments');
    await user.click(await screen.findByRole('button', { name: 'Add department' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), '  Radiólogy   Unit ');
    await user.type(within(dialog).getByLabelText('Code'), ' rad-1 ');
    await user.click(within(dialog).getByRole('button', { name: 'Create department' }));
    await waitFor(() =>
      expect(mocks.createDepartment).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'RAD-1', managerUserId: null }),
      ),
    );
  });
});
