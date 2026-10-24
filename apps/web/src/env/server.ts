import 'server-only';
import { parseWebServerEnvironment } from './schema';

export const serverEnv = parseWebServerEnvironment({
  API_BASE_URL: process.env.API_BASE_URL,
  SENTRY_DSN: process.env.SENTRY_DSN,
});
