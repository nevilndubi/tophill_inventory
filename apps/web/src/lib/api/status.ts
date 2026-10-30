import type {
  CheckInMachineInput,
  CheckOutMachineInput,
  MachineStatusBoard,
  MachineLiveStatus,
  StatusBoardQuery,
  UsageSessionDto,
} from '@app/shared';
import { browserApi } from './browser-client';

const queryString = (query: StatusBoardQuery): string => {
  const values = new URLSearchParams();
  if (query.category_id) values.set('category_id', query.category_id);
  if (query.department_id) values.set('department_id', query.department_id);
  if (query.location_id) values.set('location_id', query.location_id);
  query.status?.forEach((status) => values.append('status', status));
  if (query.service_due) values.set('service_due', 'true');
  if (query.q) values.set('q', query.q);
  values.set('page', String(query.page));
  values.set('page_size', String(query.page_size));
  values.set('sort', query.sort);
  values.set('order', query.order);
  return values.toString();
};

export const statusApi = {
  board: (query: StatusBoardQuery) =>
    browserApi.request<MachineStatusBoard>(`/status/board?${queryString(query)}`),
  machine: (machineId: string) =>
    browserApi.request<MachineLiveStatus>(`/machines/${machineId}/status`),
  checkIn: (machineId: string, input: CheckInMachineInput) =>
    browserApi.request<UsageSessionDto>(`/machines/${machineId}/check-in`, {
      body: JSON.stringify(input),
      method: 'POST',
    }),
  checkOut: (machineId: string, input: CheckOutMachineInput) =>
    browserApi.request<UsageSessionDto>(`/machines/${machineId}/check-out`, {
      body: JSON.stringify(input),
      method: 'POST',
    }),
};
