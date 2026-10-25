import type {
  InviteUserInput,
  ManagedDepartment,
  ManagedUser,
  ManagedUserPage,
  UpdateUserInput,
} from '@app/shared';
import { browserApi } from './browser-client';

export type UserFilters = {
  active?: boolean;
  departmentId?: string;
  page: number;
  pageSize: number;
  role?: string;
  search?: string;
};

const queryString = (filters: UserFilters): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query.toString();
};

export const usersApi = {
  departments: () => browserApi.request<readonly ManagedDepartment[]>('/users/departments'),
  invite: (input: InviteUserInput) =>
    browserApi.request<ManagedUser>('/users', { body: JSON.stringify(input), method: 'POST' }),
  list: (filters: UserFilters) =>
    browserApi.request<ManagedUserPage>(`/users?${queryString(filters)}`),
  setActive: (userId: string, active: boolean) =>
    browserApi.request<ManagedUser>(`/users/${userId}/${active ? 'reactivate' : 'deactivate'}`, {
      method: 'POST',
    }),
  update: (userId: string, input: UpdateUserInput) =>
    browserApi.request<ManagedUser>(`/users/${userId}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    }),
};
