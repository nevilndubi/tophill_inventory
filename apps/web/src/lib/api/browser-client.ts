import { publicEnv } from '@/env/public';
import { createApiClient } from './client';

const getBrowserAccessToken = async (): Promise<string | null> => {
  // Authentication is introduced in Phase 3. The client contract is ready for its token provider.
  return null;
};

export const browserApi = createApiClient({
  origin: publicEnv.NEXT_PUBLIC_API_URL,
  getAccessToken: getBrowserAccessToken,
});
