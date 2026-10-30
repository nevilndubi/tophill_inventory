import {
  DISPLAY_STATUSES,
  STATUS_BOARD_SORT_FIELDS,
  type DisplayStatus,
  type StatusBoardSortField,
} from '@app/shared';

export const STATUS_BOARD_VIEWS = ['grid', 'table'] as const;
export const STATUS_BOARD_PAGE_SIZES = [24, 50, 100, 200] as const;

export type StatusBoardView = (typeof STATUS_BOARD_VIEWS)[number];

export type StatusBoardUrlState = {
  category_id?: string;
  department_id?: string;
  location_id?: string;
  order: 'asc' | 'desc';
  page: number;
  page_size: (typeof STATUS_BOARD_PAGE_SIZES)[number];
  q?: string;
  service_due?: true;
  sort: StatusBoardSortField;
  status?: readonly DisplayStatus[];
  view: StatusBoardView;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const statusSet = new Set<string>(DISPLAY_STATUSES);
const sortSet = new Set<string>(STATUS_BOARD_SORT_FIELDS);
const pageSizeSet = new Set<number>(STATUS_BOARD_PAGE_SIZES);

export const defaultStatusBoardState = (view: StatusBoardView = 'grid'): StatusBoardUrlState => ({
  order: 'asc',
  page: 1,
  page_size: view === 'grid' ? 24 : 50,
  sort: 'asset_tag',
  view,
});

const positiveInteger = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const parseStatusBoardState = (source: URLSearchParams): StatusBoardUrlState => {
  const view: StatusBoardView = source.get('view') === 'table' ? 'table' : 'grid';
  const fallback = defaultStatusBoardState(view);
  const requestedPageSize = positiveInteger(source.get('page_size'));
  const q = source.get('q')?.trim();
  const statuses = [...new Set(source.getAll('status'))].filter((value): value is DisplayStatus =>
    statusSet.has(value),
  );
  const readId = (key: string) => {
    const value = source.get(key);
    return value !== null && UUID.test(value) ? value : undefined;
  };
  const sortValue = source.get('sort');

  return {
    ...fallback,
    ...(readId('category_id') ? { category_id: readId('category_id') } : {}),
    ...(readId('department_id') ? { department_id: readId('department_id') } : {}),
    ...(readId('location_id') ? { location_id: readId('location_id') } : {}),
    order: source.get('order') === 'desc' ? 'desc' : 'asc',
    page: positiveInteger(source.get('page')) ?? 1,
    page_size:
      requestedPageSize !== undefined && pageSizeSet.has(requestedPageSize)
        ? (requestedPageSize as StatusBoardUrlState['page_size'])
        : fallback.page_size,
    ...(q !== undefined && q.length >= 2 && q.length <= 100 ? { q } : {}),
    ...(source.get('service_due') === 'true' ? { service_due: true as const } : {}),
    sort:
      sortValue !== null && sortSet.has(sortValue)
        ? (sortValue as StatusBoardSortField)
        : fallback.sort,
    ...(statuses.length > 0 ? { status: statuses } : {}),
  };
};

export const serializeStatusBoardState = (state: StatusBoardUrlState): string => {
  const values = new URLSearchParams();
  if (state.department_id) values.set('department_id', state.department_id);
  if (state.category_id) values.set('category_id', state.category_id);
  if (state.location_id) values.set('location_id', state.location_id);
  state.status?.forEach((status) => values.append('status', status));
  if (state.service_due) values.set('service_due', 'true');
  if (state.q) values.set('q', state.q);
  if (state.page !== 1) values.set('page', String(state.page));
  const defaultSize = state.view === 'grid' ? 24 : 50;
  if (state.page_size !== defaultSize) values.set('page_size', String(state.page_size));
  if (state.sort !== 'asset_tag') values.set('sort', state.sort);
  if (state.order !== 'asc') values.set('order', state.order);
  if (state.view !== 'grid') values.set('view', state.view);
  return values.toString();
};

export const toStatusApiQuery = (state: StatusBoardUrlState) => ({
  ...(state.category_id ? { category_id: state.category_id } : {}),
  ...(state.department_id ? { department_id: state.department_id } : {}),
  ...(state.location_id ? { location_id: state.location_id } : {}),
  order: state.order,
  page: state.page,
  page_size: state.page_size,
  ...(state.q ? { q: state.q } : {}),
  ...(state.service_due ? { service_due: true as const } : {}),
  sort: state.sort,
  ...(state.status ? { status: [...state.status] } : {}),
});
