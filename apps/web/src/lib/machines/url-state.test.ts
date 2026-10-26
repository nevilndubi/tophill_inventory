import { describe, expect, it } from 'vitest';
import { MACHINE_SORT_FIELDS } from '@app/shared';
import {
  DEFAULT_MACHINE_LIST_STATE,
  parseMachineListState,
  serializeMachineListState,
} from './url-state';

describe('machine list URL state', () => {
  it('parses every supported filter, page and sort', () => {
    const state = parseMachineListState(
      new URLSearchParams({
        category_id: '11111111-1111-4111-8111-111111111111',
        condition: 'NEEDS_SERVICE',
        direction: 'desc',
        is_bookable: 'false',
        page: '3',
        pageSize: '50',
        search: 'ventilator',
        service_due: 'true',
        sort: 'next_service_due_at',
      }),
    );
    expect(state).toMatchObject({
      condition: 'NEEDS_SERVICE',
      direction: 'desc',
      is_bookable: false,
      page: 3,
      pageSize: 50,
      search: 'ventilator',
      service_due: true,
      sort: 'next_service_due_at',
    });
  });

  it.each([
    '?page=0',
    '?pageSize=1000',
    '?condition=HACKED',
    '?sort=DROP%20TABLE',
    '?search=x',
    '?is_bookable=perhaps',
    '?unknown=javascript%3Aalert(1)',
  ])('falls back safely for hostile or invalid input %s', (query) => {
    expect(parseMachineListState(new URLSearchParams(query))).toEqual(DEFAULT_MACHINE_LIST_STATE);
  });

  it('serializes only non-default validated state for shareable links', () => {
    expect(
      serializeMachineListState({
        ...DEFAULT_MACHINE_LIST_STATE,
        condition: 'RETIRED',
        direction: 'desc',
        page: 2,
      }),
    ).toBe('condition=RETIRED&page=2&direction=desc');
  });

  it.each(MACHINE_SORT_FIELDS)('accepts the documented %s sort with both directions', (sort) => {
    expect(parseMachineListState(new URLSearchParams({ direction: 'desc', sort }))).toMatchObject({
      direction: 'desc',
      sort,
    });
  });
});
