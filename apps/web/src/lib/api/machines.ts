import type {
  CreateMachineInput,
  ListMachinesQuery,
  ManagedMachine,
  ManagedMachinePage,
  UpdateMachineInput,
  MachineImportMode,
  MachineImportReport,
  MachineConditionHistoryPage,
  MachineConditionTransitionInput,
  MachineConditionTransitionResult,
  MachineTimelinePage,
} from '@app/shared';
import { authenticatedBrowserFetch, browserApi } from './browser-client';
import { ApiClientError } from './client';

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
  if (query.registry !== 'active') values.set('registry', query.registry);
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
  get(id: string, includeDeleted = false): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(
      `/machines/${id}${includeDeleted ? '?include_deleted=true' : ''}`,
    );
  },
  getByTag(assetTag: string): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/by-tag/${encodeURIComponent(assetTag)}`);
  },
  async history(
    id: string,
    page: number,
    includeDeleted = false,
  ): Promise<MachineConditionHistoryPage> {
    const values = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (includeDeleted) values.set('include_deleted', 'true');
    const result = await browserApi.requestWithMeta<MachineConditionHistoryPage['items']>(
      `/machines/${id}/history?${values}`,
    );
    return {
      items: result.data,
      page: numericMeta(result.meta.page, page),
      pageSize: numericMeta(result.meta.pageSize, 50),
      total: numericMeta(result.meta.total, result.data.length),
    };
  },
  timeline(
    id: string,
    options: { includeDeleted?: boolean; page: number; pageSize: number; until?: string },
  ): Promise<MachineTimelinePage> {
    const values = new URLSearchParams({
      page: String(options.page),
      page_size: String(options.pageSize),
    });
    if (options.includeDeleted) values.set('include_deleted', 'true');
    if (options.until) values.set('until', options.until);
    return browserApi.request<MachineTimelinePage>(`/machines/${id}/timeline?${values}`);
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
  importCsv(
    file: File,
    mode: MachineImportMode,
    previewHash?: string,
  ): Promise<MachineImportReport> {
    return browserApi.request<MachineImportReport>(`/machines/import?mode=${mode}`, {
      body: file,
      headers: {
        'content-type': 'text/csv',
        ...(previewHash === undefined ? {} : { 'x-import-file-sha256': previewHash }),
      },
      method: 'POST',
    });
  },
  async template(kind: 'example' | 'template'): Promise<Blob> {
    const response = await authenticatedBrowserFetch(`/machines/import/template?kind=${kind}`);
    if (!response.ok) {
      throw new ApiClientError(
        {
          code: 'TEMPLATE_DOWNLOAD_FAILED',
          details: {},
          message: 'The CSV template could not be downloaded.',
        },
        response.status,
      );
    }
    return response.blob();
  },
  update(id: string, input: UpdateMachineInput): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/${id}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    });
  },
  remove(id: string, reason: string): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/${id}`, {
      body: JSON.stringify({ reason }),
      method: 'DELETE',
    });
  },
  restore(id: string, reason?: string): Promise<ManagedMachine> {
    return browserApi.request<ManagedMachine>(`/machines/${id}/restore`, {
      body: JSON.stringify(reason === undefined || reason.trim() === '' ? {} : { reason }),
      method: 'POST',
    });
  },
  transition(
    id: string,
    input: MachineConditionTransitionInput,
  ): Promise<MachineConditionTransitionResult> {
    return browserApi.request<MachineConditionTransitionResult>(`/machines/${id}/condition`, {
      body: JSON.stringify(input),
      method: 'POST',
    });
  },
};
