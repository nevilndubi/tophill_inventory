import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedLocationPage } from '@app/shared';
import { locationsApi } from './reference';

const request = vi.hoisted(() => vi.fn());

vi.mock('./browser-client', () => ({
  browserApi: { request },
}));

const locationPage: ManagedLocationPage = {
  items: [
    {
      building: 'Main',
      department: {
        code: 'ICU',
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Intensive Care',
      },
      floor: '1',
      id: '33333333-3333-4333-8333-333333333333',
      is_deletable: true,
      machine_count: 0,
      name: 'Bay A',
      room: '101',
    },
  ],
  page: 2,
  pageSize: 25,
  total: 26,
};

describe('locationsApi', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(locationPage);
  });

  it('returns the paginated location payload without nesting its items', async () => {
    await expect(
      locationsApi.list({ departmentId: 'department-1', page: 2, pageSize: 25, search: 'Bay' }),
    ).resolves.toEqual(locationPage);

    expect(request).toHaveBeenCalledWith(
      '/locations?departmentId=department-1&search=Bay&page=2&pageSize=25',
    );
  });
});
