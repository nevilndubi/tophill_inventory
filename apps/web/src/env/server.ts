import 'server-only';
import { parseWebServerEnvironment } from './schema';

export const serverEnv = parseWebServerEnvironment({
  API_BASE_URL: process.env.API_BASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SENTRY_DSN: process.env.SENTRY_DSN,
});
