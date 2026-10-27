import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { MachineDetail } from './machine-detail';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  replace: vi.fn(),
  role: 'ADMIN',
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/machines/44444444-4444-4444-8444-444444444444',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.search,
}));
vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({ user: { role: mocks.role } }),
}));
vi.mock('@/lib/api/machines', () => ({ machinesApi: { get: mocks.get } }));
vi.mock('./machine-attachments', () => ({
  MachineAttachments: ({ machineId }: { machineId: string }) => <div>Files for {machineId}</div>,
}));

const machine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  category: { id: '11111111-1111-4111-8111-111111111111', name: 'Ventilator' },
  commissionedOn: '2026-01-01',
  condition: 'OPERATIONAL',
  department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
  description: 'Ward equipment',
  id: '44444444-4444-4444-8444-444444444444',
  isBookable: true,
  lastServicedAt: '2026-09-01T06:00:00.000Z',
  location: { id: '33333333-3333-4333-8333-333333333333', name: 'Bay A' },
  manufacturer: 'acme',
  maxBookingMinutes: 240,
  model: 'V1',
  name: 'Ward ventilator',
  nextServiceDueAt: '2026-10-01T06:00:00.000Z',
  purchaseDate: '2025-01-01',
  requiresApproval: true,
  serialNumber: 'serial-1',
  serviceIntervalDays: 30,
  warrantyExpiresOn: '2027-01-01',
};

const renderDetail = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MachineDetail id={machine.id} />
    </QueryClientProvider>,
  );
};

describe('MachineDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'ADMIN';
    mocks.search = new URLSearchParams();
    mocks.get.mockResolvedValue(machine);
    sessionStorage.clear();
  });

  it('renders the complete overview, stored condition, calculated service explanation and edit action', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: machine.name })).toBeInTheDocument();
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.getByText(/calculated from the last-service timestamp/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit machine' })).toBeInTheDocument();
  });

  it('keeps all placeholder tabs keyboard reachable and records the active tab in the URL', async () => {
    const user = userEvent.setup();
    const view = renderDetail();
    await screen.findByRole('heading', { name: machine.name });
    const status = screen.getByRole('tab', { name: /Status/ });
    status.focus();
    await user.keyboard('{Enter}');
    expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining('tab=status'), {
      scroll: false,
    });
    expect(status).toHaveAccessibleName(/Status.*Coming soon/);
    view.unmount();
    mocks.search = new URLSearchParams('tab=status');
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('renders Files as a functional panel rather than a coming-soon placeholder', async () => {
    mocks.search = new URLSearchParams('tab=files');
    renderDetail();
    expect(await screen.findByText(`Files for ${machine.id}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAccessibleName('Files');
  });

  it('hides editing from read-only roles and shows a friendly stable-code not-found state', async () => {
    mocks.role = 'STAFF';
    const view = renderDetail();
    await screen.findByRole('heading', { name: machine.name });
    expect(screen.queryByRole('link', { name: 'Edit machine' })).not.toBeInTheDocument();
    view.unmount();
    mocks.get.mockRejectedValue(
      new ApiClientError({ code: 'MACHINE_NOT_FOUND', details: {}, message: 'Missing' }, 404),
    );
    renderDetail();
    expect(await screen.findByText('Machine not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to machines/i })).toBeInTheDocument();
  });
});
