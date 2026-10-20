import { parseWebPublicEnvironment } from './schema';

export const publicEnv = parseWebPublicEnvironment({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
