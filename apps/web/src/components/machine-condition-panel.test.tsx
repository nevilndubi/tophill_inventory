import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRole, ManagedMachine } from '@app/shared';
import { ApiClientError } from '@/lib/api/client';
import { MachineConditionPanel } from './machine-condition-panel';

const mocks = vi.hoisted(() => ({ transition: vi.fn() }));
vi.mock('@/lib/api/machines', () => ({ machinesApi: { transition: mocks.transition } }));

const machine = {
  condition: 'OPERATIONAL',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ward ventilator',
  registryStatus: 'ACTIVE',
} as ManagedMachine;

const renderPanel = (role: AppRole = 'ADMIN', value = machine) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MachineConditionPanel machine={value} role={role} />
    </QueryClientProvider>,
  );
};

describe('MachineConditionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transition.mockResolvedValue({
      condition: 'NEEDS_SERVICE',
      machineId: machine.id,
      retiredOn: null,
    });
  });

  it('shows only valid, permission-aware targets', () => {
    const admin = renderPanel('ADMIN');
    expect(screen.getByRole('button', { name: 'Retire machine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify as operational' })).not.toBeInTheDocument();
    admin.unmount();
    renderPanel('BIOMED_TECH');
    expect(screen.queryByRole('button', { name: 'Retire machine' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start maintenance' })).toBeInTheDocument();
  });

  it('shows condition read-only to roles without service management', () => {
    renderPanel('STAFF');
    expect(screen.getByText('No permitted transitions are available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as needs service' })).not.toBeInTheDocument();
  });

  it('submits the observed condition and PHI-safe reason', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Mark as needs service' }));
    expect(
      screen.getByText(/Visible to everyone who can read machine history/i),
    ).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm condition change' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Inspection found a fault');
    await user.click(confirm);
    expect(mocks.transition).toHaveBeenCalledWith(machine.id, {
      force: false,
      fromCondition: 'OPERATIONAL',
      reason: 'Inspection found a fault',
      toCondition: 'NEEDS_SERVICE',
    });
  });

  it('offers the explicit force path only after an open-session response', async () => {
    const user = userEvent.setup();
    mocks.transition.mockRejectedValueOnce(
      new ApiClientError(
        { code: 'MACHINE_HAS_OPEN_SESSION', details: {}, message: 'Open session' },
        409,
      ),
    );
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Take out of service' }));
    await user.type(screen.getByLabelText('Reason'), 'Unsafe');
    await user.click(screen.getByRole('button', { name: 'Confirm condition change' }));
    expect(await screen.findByText(/Force safety transition/i)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Confirm condition change' })).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), ' condition');
    expect(screen.getByRole('button', { name: 'Confirm condition change' })).toBeEnabled();
  });

  it('keeps deleted machines read-only', () => {
    renderPanel('ADMIN', { ...machine, registryStatus: 'DELETED' });
    expect(screen.getByText('Condition is read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as needs service' })).not.toBeInTheDocument();
  });
});
