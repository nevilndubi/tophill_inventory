import type {
  CreateDepartmentInput,
  CreateLocationInput,
  EligibleManager,
  ListLocationsQuery,
  ManagedDepartmentReference,
  ManagedLocation,
  ManagedLocationPage,
  UpdateDepartmentInput,
  UpdateLocationInput,
} from '@app/shared';
import { browserApi } from './browser-client';

const queryString = (query: Partial<ListLocationsQuery>) => {
  const values = new URLSearchParams();
  if (query.departmentId) values.set('departmentId', query.departmentId);
  if (query.search) values.set('search', query.search);
  if (query.page) values.set('page', String(query.page));
  if (query.pageSize) values.set('pageSize', String(query.pageSize));
  const suffix = values.toString();
  return suffix ? `?${suffix}` : '';
};

export const departmentsApi = {
  create: (input: CreateDepartmentInput) =>
    browserApi.request<ManagedDepartmentReference>('/departments', {
      body: JSON.stringify(input),
      method: 'POST',
    }),
  delete: (id: string) =>
    browserApi.request<ManagedDepartmentReference>(`/departments/${id}`, { method: 'DELETE' }),
  eligibleManagers: (id: string) =>
    browserApi.request<readonly EligibleManager[]>(`/departments/${id}/eligible-managers`),
  get: (id: string) => browserApi.request<ManagedDepartmentReference>(`/departments/${id}`),
  list: () => browserApi.request<readonly ManagedDepartmentReference[]>('/departments'),
  update: (id: string, input: UpdateDepartmentInput) =>
    browserApi.request<ManagedDepartmentReference>(`/departments/${id}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    }),
};

export const locationsApi = {
  create: (input: CreateLocationInput) =>
    browserApi.request<ManagedLocation>('/locations', {
      body: JSON.stringify(input),
      method: 'POST',
    }),
  delete: (id: string) =>
    browserApi.request<ManagedLocation>(`/locations/${id}`, { method: 'DELETE' }),
  get: (id: string) => browserApi.request<ManagedLocation>(`/locations/${id}`),
  async list(query: Partial<ListLocationsQuery> = {}): Promise<ManagedLocationPage> {
    const result = await browserApi.requestWithMeta<readonly ManagedLocation[]>(
      `/locations${queryString(query)}`,
    );
    const numberOr = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return {
      items: result.data,
      page: numberOr(result.meta.page, query.page ?? 1),
      pageSize: numberOr(result.meta.pageSize, query.pageSize ?? 50),
      total: numberOr(result.meta.total, result.data.length),
    };
  },
  update: (id: string, input: UpdateLocationInput) =>
    browserApi.request<ManagedLocation>(`/locations/${id}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    }),
};
