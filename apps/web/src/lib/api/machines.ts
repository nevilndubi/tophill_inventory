import type {
  CreateMachineInput,
  ListMachinesQuery,
  ManagedMachine,
  ManagedMachinePage,
  UpdateMachineInput,
} from '@app/shared';
import { browserApi } from './browser-client';

const queryString = (query: ListMachinesQuery): string => {
  const values = new URLSearchParams();
  if (query.category_id) values.set('category_id', query.category_id);
  if (query.condition) values.set('condition', query.condition);
  if (query.department_id) values.set('department_id', query.department_id);
  if (query.is_bookable !== undefined) values.set('is_bookable', String(query.is_bookable));
  if (query.location_id) values.set('location_id', query.location_id);
  values.set('page', String(query.page));
  values.set('pageSize', String(query.pageSize));
  if (query.search) values.set('search', query.search);
  if (query.service_due !== undefined) values.set('service_due', String(query.service_due));
  values.set('sort', query.sort);
  values.set('direction', query.direction);
  return values.toString();
};

const numericMeta = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const machinesApi = {
  async create(input: CreateMachineInput): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>('/machines', {
      body: JSON.stringify(input),
      method: 'POST',
    });
  },
  get(id: string): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/${id}`);
  },
  getByTag(assetTag: string): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/by-tag/${encodeURIComponent(assetTag)}`);
  },
  async list(query: ListMachinesQuery): Promise<ManagedMachinePage> {
    const result = await browserApi.requestWithMeta<readonly ManagedMachine[]>(
      `/machines?${queryString(query)}`,
    );
    return {
      items: result.data,
      page: numericMeta(result.meta.page, query.page),
      pageSize: numericMeta(result.meta.pageSize, query.pageSize),
      total: numericMeta(result.meta.total, result.data.length),
    };
  },
  update(id: string, input: UpdateMachineInput): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/${id}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    });
  },
};
