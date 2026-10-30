import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { MachineDetail } from './machine-detail';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  history: vi.fn(),
  timeline: vi.fn(),
  status: vi.fn(),
  remove: vi.fn(),
  replace: vi.fn(),
  restore: vi.fn(),
  transition: vi.fn(),
  role: 'ADMIN',
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/machines/44444444-4444-4444-8444-444444444444',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.search,
}));
vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({
    user: {
      department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
      id: '99999999-9999-4999-8999-999999999999',
      role: mocks.role,
    },
  }),
}));
vi.mock('@/lib/api/machines', () => ({
  machinesApi: {
    get: mocks.get,
    history: mocks.history,
    timeline: mocks.timeline,
    remove: mocks.remove,
    restore: mocks.restore,
    transition: mocks.transition,
  },
}));
vi.mock('@/lib/api/status', () => ({
  statusApi: {
    checkIn: vi.fn(),
    checkOut: vi.fn(),
    machine: mocks.status,
  },
}));
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
  registryStatus: 'ACTIVE',
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
    mocks.remove.mockResolvedValue({ ...machine, registryStatus: 'DELETED' });
    mocks.restore.mockResolvedValue(machine);
    mocks.transition.mockResolvedValue({
      condition: 'NEEDS_SERVICE',
      machineId: machine.id,
      retiredOn: null,
    });
    mocks.history.mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
    mocks.timeline.mockResolvedValue({
      as_of: '2026-10-30T12:00:00.000Z',
      items: [],
      page: 1,
      page_size: 50,
      total: 0,
      until: '2026-10-30T12:00:00.000Z',
    });
    mocks.status.mockResolvedValue({
      as_of: '2026-10-30T12:00:00.000Z',
      asset_tag: machine.assetTag,
      category: machine.category,
      department: machine.department,
      display_status: 'AVAILABLE_OK',
      id: machine.id,
      location: machine.location,
      name: machine.name,
      next_booking_at: null,
      open_session: null,
      service_due: false,
      stored_condition: machine.condition,
      usable: true,
    });
    sessionStorage.clear();
  });

  it('renders the complete overview, stored condition, calculated service explanation and edit action', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: machine.name })).toBeInTheDocument();
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.getByText(/calculated from the last-service timestamp/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit machine' })).toBeInTheDocument();
  });

  it('keeps tabs keyboard reachable, makes Status functional, and records it in the URL', async () => {
    const user = userEvent.setup();
    const view = renderDetail();
    await screen.findByRole('heading', { name: machine.name });
    const status = screen.getByRole('tab', { name: /Status/ });
    status.focus();
    await user.keyboard('{Enter}');
    expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining('tab=status'), {
      scroll: false,
    });
    expect(status).toHaveAccessibleName('Status');
    view.unmount();
    mocks.search = new URLSearchParams('tab=status');
    renderDetail();
    expect(await screen.findByText('Current condition')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as needs service' })).toBeInTheDocument();
  });

  it('renders Files as a functional panel rather than a coming-soon placeholder', async () => {
    mocks.search = new URLSearchParams('tab=files');
    renderDetail();
    expect(await screen.findByText(`Files for ${machine.id}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAccessibleName('Files');
  });

  it('renders minimized newest-first condition history with safe actor metadata', async () => {
    mocks.search = new URLSearchParams('tab=history');
    mocks.timeline.mockResolvedValue({
      as_of: '2026-10-30T12:00:00.000Z',
      items: [
        {
          actor: { full_name: 'Test Technician' },
          event_id: 'condition:55555555-5555-4555-8555-555555555555',
          from_condition: 'OPERATIONAL',
          kind: 'CONDITION_CHANGED',
          occurred_at: '2026-10-28T12:00:00.000Z',
          reason: 'Inspection found a fault',
          source: 'MANUAL',
          to_condition: 'NEEDS_SERVICE',
        },
      ],
      page: 1,
      page_size: 50,
      total: 1,
      until: '2026-10-30T12:00:00.000Z',
    });
    renderDetail();
    expect(await screen.findByText(/Inspection found a fault/)).toBeInTheDocument();
    expect(screen.getByText(/by Test Technician/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAccessibleName('History');
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('requires a PHI-safe removal reason and navigates to the deleted registry view', async () => {
    const user = userEvent.setup();
    mocks.remove.mockImplementationOnce(async () => {
      const deleted = { ...machine, registryStatus: 'DELETED' };
      mocks.get.mockResolvedValue(deleted);
      return deleted;
    });
    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Remove from active registry' }));
    expect(screen.getByText(/This is not retirement/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not enter patient names/i)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Remove machine' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason \(required\)/i), 'Registry correction');
    await user.click(submit);
    expect(mocks.remove).toHaveBeenCalledWith(machine.id, 'Registry correction');
    expect(await screen.findByRole('button', { name: 'Restore to active registry' })).toBeVisible();
    expect(mocks.replace).toHaveBeenCalledWith('/machines?registry=deleted');
  });

  it('shows a deleted banner, hides files and editing, and restores without changing history', async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ ...machine, registryStatus: 'DELETED' });
    mocks.restore.mockResolvedValue(machine);
    mocks.search = new URLSearchParams('tab=files');
    renderDetail();
    expect(await screen.findByText('Removed from the active registry')).toBeInTheDocument();
    expect(screen.queryByText(`Files for ${machine.id}`)).not.toBeInTheDocument();
    expect(screen.getByText(/Attachments remain private and hidden/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit machine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Print label' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore to active registry' }));
    await user.click(screen.getByRole('button', { name: 'Restore machine' }));
    expect(mocks.restore).toHaveBeenCalledWith(machine.id, '');
    expect(mocks.replace).toHaveBeenCalledWith(`/machines/${machine.id}`);
  });

  it('hides editing from read-only roles and shows a friendly stable-code not-found state', async () => {
    mocks.role = 'STAFF';
    const view = renderDetail();
    await screen.findByRole('heading', { name: machine.name });
    expect(screen.queryByRole('link', { name: 'Edit machine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /active registry/i })).not.toBeInTheDocument();
    view.unmount();
    mocks.get.mockRejectedValue(
      new ApiClientError({ code: 'MACHINE_NOT_FOUND', details: {}, message: 'Missing' }, 404),
    );
    renderDetail();
    expect(await screen.findByText('Machine not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to machines/i })).toBeInTheDocument();
  });
});
