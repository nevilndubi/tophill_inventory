import type { NextConfig } from 'next';
import { validateWebEnvironment } from './src/env/schema';

validateWebEnvironment({
  API_BASE_URL: process.env.API_BASE_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SENTRY_DSN: process.env.SENTRY_DSN,
});

const nextConfig: NextConfig = {};

export default nextConfig;
