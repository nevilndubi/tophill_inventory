import { config as loadEnvironment } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnvironment({ path: 'apps/api/.env', quiet: true });

const generationOnlyUrl = 'postgresql://test:test@127.0.0.1:5432/tophill_test';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma Client generation is offline. Connected CLI commands must receive DIRECT_URL.
    url: process.env.DIRECT_URL ?? generationOnlyUrl,
  },
});
