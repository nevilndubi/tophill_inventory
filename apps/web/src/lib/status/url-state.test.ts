import { describe, expect, it } from 'vitest';
import {
  defaultStatusBoardState,
  parseStatusBoardState,
  serializeStatusBoardState,
} from './url-state';

const id = '11111111-1111-4111-8111-111111111111';

describe('status board URL state', () => {
  it('round-trips repeatable statuses and every supported filter', () => {
    const source = new URLSearchParams(
      `department_id=${id}&status=IN_USE&status=RETIRED&service_due=true&q=vent&page=2&page_size=100&sort=status&order=desc&view=table`,
    );
    const parsed = parseStatusBoardState(source);
    expect(parsed).toMatchObject({
      department_id: id,
      order: 'desc',
      page: 2,
      page_size: 100,
      q: 'vent',
      service_due: true,
      sort: 'status',
      status: ['IN_USE', 'RETIRED'],
      view: 'table',
    });
    expect(parseStatusBoardState(new URLSearchParams(serializeStatusBoardState(parsed)))).toEqual(
      parsed,
    );
  });

  it.each([
    'unknown=1&view=javascript%3Aalert(1)&page=-1',
    'department_id=not-a-uuid&page_size=9999&sort=raw_sql&order=sideways',
    'status=MADE_UP&q=x',
    'page=1e99&location_id=%2F%2Fattacker.example',
  ])('falls back safely for hostile values: %s', (query) => {
    expect(parseStatusBoardState(new URLSearchParams(query))).toEqual(defaultStatusBoardState());
  });

  it('uses a table-specific default page size without accepting arbitrary sizes', () => {
    expect(parseStatusBoardState(new URLSearchParams('view=table')).page_size).toBe(50);
    expect(parseStatusBoardState(new URLSearchParams('view=table&page_size=25')).page_size).toBe(
      50,
    );
  });
});
