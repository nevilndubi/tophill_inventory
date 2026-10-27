import type { NextConfig } from 'next';
import { validateWebEnvironment } from './src/env/schema';

validateWebEnvironment({
  API_BASE_URL: process.env.API_BASE_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  SENTRY_DSN: process.env.SENTRY_DSN,
});

const storageOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL as string);

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        hostname: storageOrigin.hostname,
        pathname: '/storage/v1/object/sign/**',
        protocol: storageOrigin.protocol.replace(':', '') as 'http' | 'https',
      },
    ],
  },
};

export default nextConfig;
