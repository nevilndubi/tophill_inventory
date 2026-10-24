import 'server-only';
import { serverEnv } from '@/env/server';
import { createApiClient } from './client';

export const createServerApi = (accessToken: string) =>
  createApiClient({
    origin: serverEnv.API_BASE_URL,
    getAccessToken: async () => accessToken,
  });

export const serverHealthApi = createApiClient({ origin: serverEnv.API_BASE_URL });
