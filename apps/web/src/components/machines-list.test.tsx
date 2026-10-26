import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MACHINE_LIST_STATE } from '@/lib/machines/url-state';
import { MachinesList } from './machines-list';

const mocks = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  listMachines: vi.fn(),
  replace: vi.fn(),
  role: 'ADMIN',
  search: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/machines',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.search,
}));
vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({ user: { role: mocks.role } }),
}));
vi.mock('@/lib/api/categories', () => ({ categoriesApi: { list: mocks.listCategories } }));
vi.mock('@/lib/api/reference', () => ({
  departmentsApi: { list: mocks.listDepartments },
  locationsApi: { list: mocks.listLocations },
}));
vi.mock('@/lib/api/machines', () => ({ machinesApi: { list: mocks.listMachines } }));

const machine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  category: { id: '11111111-1111-4111-8111-111111111111', name: 'Ventilator' },
  commissionedOn: '2026-01-01',
  condition: 'NEEDS_SERVICE',
  department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
  description: '<script>alert(1)</script>',
  id: '33333333-3333-4333-8333-333333333333',
  isBookable: true,
  lastServicedAt: '2026-09-01T06:00:00.000Z',
  location: { id: '44444444-4444-4444-8444-444444444444', name: 'Bay A' },
  manufacturer: 'acme',
  maxBookingMinutes: null,
  model: 'V1',
  name: 'Ward ventilator',
  nextServiceDueAt: '2026-10-01T06:00:00.000Z',
  purchaseDate: '2025-01-01',
  requiresApproval: true,
  serialNumber: 'serial-1',
  serviceIntervalDays: 30,
  warrantyExpiresOn: null,
};

const renderList = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MachinesList initialState={DEFAULT_MACHINE_LIST_STATE} />
    </QueryClientProvider>,
  );
};

describe('MachinesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'ADMIN';
    mocks.search = new URLSearchParams();
    mocks.listCategories.mockResolvedValue([machine.category]);
    mocks.listDepartments.mockResolvedValue([machine.department]);
    mocks.listLocations.mockResolvedValue({
      items: [{ ...machine.location, department: machine.department }],
      page: 1,
      pageSize: 200,
      total: 1,
    });
    mocks.listMachines.mockResolvedValue({ items: [machine], page: 1, pageSize: 25, total: 1 });
  });

  it('renders equivalent accessible table and mobile-card information without interpreting HTML', async () => {
    renderList();
    expect(await screen.findByRole('table', { name: /machine inventory/i })).toBeInTheDocument();
    expect(screen.getAllByText('Ward ventilator')).toHaveLength(2);
    expect(document.querySelectorAll('.text-status-needs-service')).toHaveLength(2);
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(mocks.listMachines).toHaveBeenCalledTimes(1);
    expect(mocks.listCategories).toHaveBeenCalledTimes(1);
    expect(mocks.listDepartments).toHaveBeenCalledTimes(1);
    expect(mocks.listLocations).toHaveBeenCalledTimes(1);
  });

  it('debounces valid search, hints for one character, and resets the page', async () => {
    const user = userEvent.setup();
    mocks.search = new URLSearchParams('page=3');
    renderList();
    const search = screen.getByLabelText('Search machines');
    await user.type(search, 'v');
    expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument();
    await user.type(search, 'e');
    await waitFor(
      () => expect(mocks.replace).toHaveBeenCalledWith('/machines?search=ve', { scroll: false }),
      { timeout: 1_000 },
    );
  });

  it('shows total range, filter controls and an empty no-results state', async () => {
    mocks.search = new URLSearchParams('condition=RETIRED');
    mocks.listMachines.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
    renderList();
    expect(await screen.findByText('No machines match this view')).toBeInTheDocument();
    expect(screen.getByText('Showing 0 to 0 of 0')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition')).toHaveValue('RETIRED');
  });

  it('hides creation for a technician but keeps viewing available', async () => {
    mocks.role = 'BIOMED_TECH';
    renderList();
    expect(await screen.findAllByText('Ward ventilator')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: /register machine/i })).not.toBeInTheDocument();
  });
});
