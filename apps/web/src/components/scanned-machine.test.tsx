import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { ScannedMachine } from './scanned-machine';

const mocks = vi.hoisted(() => ({ getByTag: vi.fn() }));
vi.mock('@/lib/api/machines', () => ({ machinesApi: { getByTag: mocks.getByTag } }));

const machine = {
  assetTag: 'HM-000123',
  condition: 'OPERATIONAL',
  department: { code: 'ICU', id: '22222222-2222-4222-8222-222222222222', name: 'ICU' },
  id: '00000000-0000-4000-8000-000000000123',
  location: { id: '44444444-4444-4444-8444-444444444444', name: 'Bay A' },
  name: 'Ward ventilator',
};

const renderLookup = (tag: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScannedMachine rawAssetTag={tag} />
    </QueryClientProvider>,
  );
};

describe('ScannedMachine', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows status, placement and deliberately disabled future actions above the fold', async () => {
    mocks.getByTag.mockResolvedValue(machine);
    renderLookup('hm-000123');
    expect(await screen.findByRole('heading', { name: 'Ward ventilator' })).toBeInTheDocument();
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.getByText('Bay A')).toBeInTheDocument();
    for (const label of ['Check out', 'Check in', 'Book', 'Report a fault']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeDisabled();
    }
    expect(mocks.getByTag).toHaveBeenCalledWith('HM-000123');
  });

  it('uses identical not-found text, state and timing class for hidden, malformed and unknown tags', async () => {
    const presentations: string[] = [];
    for (const tag of ['HM-999999', 'bad-tag', 'HM-000124']) {
      mocks.getByTag.mockRejectedValue(
        new ApiClientError(
          { code: 'MACHINE_NOT_FOUND', details: {}, message: 'Machine not found' },
          404,
        ),
      );
      const { container } = renderLookup(tag);
      expect(await screen.findByText('Machine not found')).toBeInTheDocument();
      const result = container.querySelector('[data-scan-result]');
      expect(result).toHaveAttribute('data-scan-result', 'not-found');
      expect(result).toHaveAttribute('data-scan-timing-class', 'bounded-lookup');
      presentations.push(result?.textContent ?? '');
      cleanup();
    }
    expect(new Set(presentations).size).toBe(1);
  });
});
