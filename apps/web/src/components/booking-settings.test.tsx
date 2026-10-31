import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingSettingsManagement } from './booking-settings';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('@/lib/api/booking', () => ({
  bookingApi: { settings: mocks.settings, updateSettings: mocks.updateSettings },
}));

const settings = {
  adhocGuardMinutes: 30,
  defaultBufferMinutes: 0,
  maxAdvanceDays: 60,
  maxDurationMinutes: 240,
  minDurationMinutes: 15,
  minLeadMinutes: 15,
  noShowGraceMinutes: 15,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const renderSettings = () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingSettingsManagement />
    </QueryClientProvider>,
  );
};

describe('BookingSettingsManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue(settings);
    mocks.updateSettings.mockImplementation(async (input) => ({
      ...settings,
      ...input,
      updatedAt: '2026-02-01T00:00:00.000Z',
    }));
  });

  it('updates global rules with the current version and displays the saved values', async () => {
    const user = userEvent.setup();
    renderSettings();
    const minimum = await screen.findByRole('spinbutton', {
      name: 'Minimum booking duration (minutes)',
    });
    await user.clear(minimum);
    await user.type(minimum, '20');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        adhocGuardMinutes: 30,
        defaultBufferMinutes: 0,
        expectedUpdatedAt: settings.updatedAt,
        maxAdvanceDays: 60,
        maxDurationMinutes: 240,
        minDurationMinutes: 20,
        minLeadMinutes: 15,
        noShowGraceMinutes: 15,
      }),
    );
    expect(
      screen.getByRole('spinbutton', { name: 'Minimum booking duration (minutes)' }),
    ).toHaveValue(20);
  });

  it('confirms resetting form values to defaults without saving automatically', async () => {
    const user = userEvent.setup();
    renderSettings();
    const maximum = await screen.findByRole('spinbutton', {
      name: 'Maximum booking duration (minutes)',
    });
    fireEvent.change(maximum, { target: { value: '180' } });
    await user.click(screen.getByRole('button', { name: 'Reset fields to defaults' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Save settings to apply them/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset fields' }));
    expect(maximum).toHaveValue(240);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('blocks invalid limits and shows an accessible field error', async () => {
    const user = userEvent.setup();
    renderSettings();
    const minimum = await screen.findByRole('spinbutton', {
      name: 'Minimum booking duration (minutes)',
    });
    await user.clear(minimum);
    await user.type(minimum, '121');
    expect(await screen.findByText('Enter a whole number from 5 to 120.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
