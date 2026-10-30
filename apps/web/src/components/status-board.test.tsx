import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISPLAY_STATUSES,
  type AppRole,
  type DisplayStatus,
  type MachineLiveStatus,
} from '@app/shared';
import { defaultStatusBoardState } from '@/lib/status/url-state';
import { StatusBoard } from './status-board';

const mocks = vi.hoisted(() => ({
  board: vi.fn(),
  checkIn: vi.fn(),
  checkOut: vi.fn(),
  listCategories: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  replace: vi.fn(),
  role: 'ADMIN' as AppRole,
  search: new URLSearchParams(),
  userId: 'actor',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/status',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.search,
}));
vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({
    user: { department: { id: 'dept-a' }, id: mocks.userId, role: mocks.role },
  }),
}));
vi.mock('@/lib/api/status', () => ({
  statusApi: { board: mocks.board, checkIn: mocks.checkIn, checkOut: mocks.checkOut },
}));
vi.mock('@/lib/api/categories', () => ({ categoriesApi: { list: mocks.listCategories } }));
vi.mock('@/lib/api/reference', () => ({
  departmentsApi: { list: mocks.listDepartments },
  locationsApi: { list: mocks.listLocations },
}));

const statusCondition: Record<DisplayStatus, MachineLiveStatus['stored_condition']> = {
  AVAILABLE_NEEDS_SERVICE: 'NEEDS_SERVICE',
  AVAILABLE_OK: 'OPERATIONAL',
  IN_USE: 'OPERATIONAL',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
  RETIRED: 'RETIRED',
  UNDER_MAINTENANCE: 'UNDER_MAINTENANCE',
};

const machine = (status: DisplayStatus, index: number): MachineLiveStatus => ({
  as_of: '2026-10-30T06:00:00.000Z',
  asset_tag: `HM-00000${index + 1}`,
  category: { id: 'cat-a', name: 'Ventilator' },
  department: { code: 'ICU', id: 'dept-a', name: 'ICU' },
  display_status: status,
  id: `machine-${index}`,
  location: { id: 'loc-a', name: 'Bay A' },
  name: `${status} machine`,
  next_booking_at: index === 0 ? '2026-10-30T07:00:00.000Z' : null,
  open_session: ['IN_USE', 'OUT_OF_SERVICE', 'UNDER_MAINTENANCE', 'RETIRED'].includes(status)
    ? {
        expected_end_at: '2026-10-30T06:30:00.000Z',
        held_by_current_user: status === 'IN_USE',
        holder: { full_name: 'Masked Holder', id: status === 'IN_USE' ? 'actor' : 'holder' },
        id: `session-${index}`,
        overdue: false,
        started_at: '2026-10-30T05:00:00.000Z',
      }
    : null,
  service_due: status === 'AVAILABLE_NEEDS_SERVICE',
  stored_condition: statusCondition[status],
  usable: status === 'AVAILABLE_OK' || status === 'AVAILABLE_NEEDS_SERVICE',
});

const items = DISPLAY_STATUSES.map(machine);
const counts = Object.fromEntries(DISPLAY_STATUSES.map((status) => [status, 1]));

const renderBoard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusBoard initialState={defaultStatusBoardState()} />
    </QueryClientProvider>,
  );
};

describe('StatusBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'ADMIN';
    mocks.userId = 'actor';
    mocks.search = new URLSearchParams();
    mocks.board.mockResolvedValue({
      as_of: '2026-10-30T06:00:00.000Z',
      counts,
      items,
      page: 1,
      page_size: 24,
      total: 6,
    });
    mocks.listCategories.mockResolvedValue([{ id: 'cat-a', name: 'Ventilator' }]);
    mocks.listDepartments.mockResolvedValue([{ code: 'ICU', id: 'dept-a', name: 'ICU' }]);
    mocks.listLocations.mockResolvedValue({
      items: [{ department: { name: 'ICU' }, id: 'loc-a', name: 'Bay A' }],
      page: 1,
      pageSize: 200,
      total: 1,
    });
    mocks.checkIn.mockResolvedValue({ id: 'session', machineId: 'machine-3' });
    mocks.checkOut.mockResolvedValue({ id: 'session', machineId: 'machine-5' });
  });

  afterEach(() => vi.useRealTimers());

  it('renders all six shared statuses, complete counts and no identity email', async () => {
    renderBoard();
    expect(await screen.findByRole('heading', { name: 'Live status' })).toBeInTheDocument();
    for (const status of DISPLAY_STATUSES)
      expect(
        screen.getAllByText(
          status === 'AVAILABLE_NEEDS_SERVICE'
            ? 'Available — needs service'
            : status === 'AVAILABLE_OK'
              ? 'Available'
              : status === 'IN_USE'
                ? 'In use'
                : status === 'UNDER_MAINTENANCE'
                  ? 'Under maintenance'
                  : status === 'OUT_OF_SERVICE'
                    ? 'Out of service'
                    : 'Retired',
        ).length,
      ).toBeGreaterThan(0);
    expect(screen.getByText('Showing 1 to 6 of 6')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
    expect(mocks.board).toHaveBeenCalledTimes(1);
  });

  it('shows higher-priority conditions while preserving prominent open-session actions', async () => {
    renderBoard();
    expect(await screen.findByText(/OUT_OF_SERVICE machine/)).toBeInTheDocument();
    expect(screen.getAllByText(/Still checked out by Masked Holder/)).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Force end' }).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps chip, search, view and filter changes in validated URL state', async () => {
    const user = userEvent.setup();
    renderBoard();
    const inUseChip = (await screen.findAllByText('In use'))
      .map((element) => element.closest('button'))
      .find((element) => element !== null);
    expect(inUseChip).toBeTruthy();
    await user.click(inUseChip!);
    expect(mocks.replace).toHaveBeenCalledWith('/status?status=IN_USE', { scroll: false });
    await user.click(screen.getByRole('button', { name: 'Table view' }));
    expect(mocks.replace).toHaveBeenCalledWith('/status?view=table', { scroll: false });
    await user.type(screen.getByLabelText('Search status board'), 've');
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith('/status?q=ve', { scroll: false }),
    );
  });

  it('supports holder check-in and refreshes the board after success', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    await user.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(mocks.checkIn).toHaveBeenCalledWith('machine-3', { force: false }));
    expect(await screen.findByText('Machine checked in.')).toBeInTheDocument();
  });

  it('offers no mutations to VIEWER but keeps board visibility', async () => {
    mocks.role = 'VIEWER';
    renderBoard();
    expect(await screen.findByText('AVAILABLE_OK machine')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force end' })).not.toBeInTheDocument();
  });

  it('shows a stale warning while retaining the last successful data after polling fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T06:00:00.000Z'));
    renderBoard();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByText('AVAILABLE_OK machine')).toBeInTheDocument();
    vi.setSystemTime(new Date('2026-10-30T06:02:00.000Z'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('Status data is stale')).toBeInTheDocument();
  });
});
