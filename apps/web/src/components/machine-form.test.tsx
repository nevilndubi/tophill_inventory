import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedMachine } from '@app/shared';
import { MachineForm } from './machine-form';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listCategories: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  policy: vi.fn(),
  push: vi.fn(),
  update: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn(), push: mocks.push }) }));
vi.mock('@/lib/api/categories', () => ({ categoriesApi: { list: mocks.listCategories } }));
vi.mock('@/lib/api/booking', () => ({ bookingApi: { policy: mocks.policy } }));
vi.mock('@/lib/api/reference', () => ({
  departmentsApi: { list: mocks.listDepartments },
  locationsApi: { list: mocks.listLocations },
}));
vi.mock('@/lib/api/machines', () => ({
  machinesApi: { create: mocks.create, update: mocks.update },
}));

const category = { id: '11111111-1111-4111-8111-111111111111', name: 'Ventilator' };
const department = { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' };
const location = { department, id: '33333333-3333-4333-8333-333333333333', name: 'Bay A' };
const saved: ManagedMachine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: null,
  category,
  commissionedOn: null,
  condition: 'OPERATIONAL',
  department,
  description: null,
  id: '44444444-4444-4444-8444-444444444444',
  isBookable: true,
  registryStatus: 'ACTIVE',
  lastServicedAt: null,
  location,
  manufacturer: 'acme',
  maxBookingMinutes: null,
  model: 'V1',
  name: 'Ward ventilator',
  nextServiceDueAt: null,
  purchaseDate: null,
  requiresApproval: true,
  serialNumber: 'serial-1',
  serviceIntervalDays: null,
  warrantyExpiresOn: null,
};

const renderForm = (machine: typeof saved | null = null) => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MachineForm machine={machine} />
    </QueryClientProvider>,
  );
};

describe('MachineForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.listCategories.mockResolvedValue([category]);
    mocks.listDepartments.mockResolvedValue([department]);
    mocks.listLocations.mockResolvedValue({ items: [location], page: 1, pageSize: 200, total: 1 });
    mocks.create.mockResolvedValue(saved);
    mocks.update.mockResolvedValue(saved);
    mocks.policy.mockResolvedValue({
      bufferMinutes: { source: 'global', value: 0 },
      bookable: { reason: null, value: true },
      maxDurationMinutes: { source: 'category', value: 180 },
      maxAdvanceDays: { source: 'global', value: 60 },
      minDurationMinutes: { source: 'global', value: 15 },
      minLeadMinutes: { source: 'global', value: 15 },
      requiresApproval: { source: 'machine', value: true },
    });
  });

  it('normalizes registration values and omits booking booleans left at system defaults', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Machine name'), '  Ward   Ventilator ');
    await user.selectOptions(await screen.findByLabelText('Category'), category.id);
    await user.type(screen.getByLabelText('Manufacturer'), ' ACME ');
    await user.type(screen.getByLabelText('Model'), ' V1 ');
    await user.type(screen.getByLabelText('Serial number'), ' SERIAL-1 ');
    await user.selectOptions(screen.getByLabelText('Owning department'), department.id);
    await user.selectOptions(screen.getByLabelText('Location'), location.id);
    await user.click(screen.getByRole('button', { name: 'Register machine' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'acme',
          name: 'Ward Ventilator',
          serialNumber: 'serial-1',
        }),
      ),
    );
    const input = mocks.create.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('isBookable');
    expect(input).not.toHaveProperty('requiresApproval');
    expect(sessionStorage.getItem('machine-created-asset-tag')).toBe('HM-000061');
  });

  it('does not send an empty PATCH and sends only changed fields', async () => {
    const user = userEvent.setup();
    const { unmount } = renderForm(saved);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('No changes to save.')).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    unmount();

    renderForm(saved);
    const name = await screen.findByLabelText('Machine name');
    await user.clear(name);
    await user.type(name, 'Updated name');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(saved.id, { name: 'Updated name' }),
    );
  });

  it('shows effective inherited values and allows custom overrides including a zero buffer', async () => {
    const user = userEvent.setup();
    renderForm(saved);
    expect(await screen.findByText('180 minutes (category)')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum booking override (minutes)')).toHaveValue(null);
    const buffer = screen.getByLabelText('Machine buffer override (minutes)');
    expect(buffer).toHaveValue(null);
    await user.type(screen.getByLabelText('Maximum booking override (minutes)'), '120');
    await user.type(buffer, '0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(saved.id, {
        bufferMinutes: 0,
        maxBookingMinutes: 120,
      }),
    );
  });

  it('focuses the first invalid field and exposes no internal machine fields', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Register machine' }));
    await waitFor(() => expect(screen.getByLabelText('Machine name')).toHaveFocus());
    expect(screen.queryByLabelText(/asset tag/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^condition$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/next service due/i)).not.toBeInstanceOf(HTMLInputElement);
  });
});
