import {
  listMachinesQuerySchema,
  MACHINE_PAGE_SIZE_DEFAULT,
  type ListMachinesQuery,
} from '@app/shared';

export const DEFAULT_MACHINE_LIST_STATE: ListMachinesQuery = {
  direction: 'asc',
  page: 1,
  pageSize: MACHINE_PAGE_SIZE_DEFAULT,
  sort: 'asset_tag',
};

const KNOWN_PARAMETERS = new Set([
  'category_id',
  'condition',
  'department_id',
  'direction',
  'is_bookable',
  'location_id',
  'page',
  'pageSize',
  'search',
  'service_due',
  'sort',
]);

export const parseMachineListState = (
  source: URLSearchParams | Readonly<Record<string, string | string[] | undefined>>,
): ListMachinesQuery => {
  const entries =
    source instanceof URLSearchParams
      ? [...source.entries()]
      : Object.entries(source).flatMap(([key, value]) =>
          typeof value === 'string' ? [[key, value] as const] : [],
        );
  const candidate = Object.fromEntries(entries.filter(([key]) => KNOWN_PARAMETERS.has(key)));
  const parsed = listMachinesQuerySchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_MACHINE_LIST_STATE;
};

export const serializeMachineListState = (state: ListMachinesQuery): string => {
  const values = new URLSearchParams();
  if (state.search) values.set('search', state.search);
  if (state.department_id) values.set('department_id', state.department_id);
  if (state.category_id) values.set('category_id', state.category_id);
  if (state.location_id) values.set('location_id', state.location_id);
  if (state.condition) values.set('condition', state.condition);
  if (state.is_bookable !== undefined) values.set('is_bookable', String(state.is_bookable));
  if (state.service_due !== undefined) values.set('service_due', String(state.service_due));
  if (state.page !== 1) values.set('page', String(state.page));
  if (state.pageSize !== MACHINE_PAGE_SIZE_DEFAULT) values.set('pageSize', String(state.pageSize));
  if (state.sort !== 'asset_tag') values.set('sort', state.sort);
  if (state.direction !== 'asc') values.set('direction', state.direction);
  return values.toString();
};
