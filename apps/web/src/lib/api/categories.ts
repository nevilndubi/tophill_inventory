import type { CreateCategoryInput, ManagedCategory, UpdateCategoryInput } from '@app/shared';
import { browserApi } from './browser-client';

export const categoriesApi = {
  create: (input: CreateCategoryInput) =>
    browserApi.request<ManagedCategory>('/categories', {
      body: JSON.stringify(input),
      method: 'POST',
    }),
  delete: (categoryId: string) =>
    browserApi.request<ManagedCategory>(`/categories/${categoryId}`, { method: 'DELETE' }),
  get: (categoryId: string) => browserApi.request<ManagedCategory>(`/categories/${categoryId}`),
  list: () => browserApi.request<readonly ManagedCategory[]>('/categories'),
  update: (categoryId: string, input: UpdateCategoryInput) =>
    browserApi.request<ManagedCategory>(`/categories/${categoryId}`, {
      body: JSON.stringify(input),
      method: 'PATCH',
    }),
};
