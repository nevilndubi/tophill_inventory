import 'server-only';
import { serverEnv } from '@/env/server';
import { createApiClient } from './client';

export const serverApi = createApiClient({
  origin: serverEnv.API_BASE_URL,
});
