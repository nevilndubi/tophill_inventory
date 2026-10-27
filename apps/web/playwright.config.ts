import { defineConfig, devices } from '@playwright/test';

const testEnvironment = [
  'PLAYWRIGHT_MOCK_MODE=1',
  'API_BASE_URL=http://127.0.0.1:3001',
  'NEXT_PUBLIC_APP_ORIGIN=http://localhost:3100',
  'NEXT_PUBLIC_API_URL=http://127.0.0.1:3001',
  'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test_browser_safe',
].join(' ');

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: '.artifacts/task-3.7/playwright-results',
  reporter: [['line']],
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `${testEnvironment} pnpm dev --hostname 127.0.0.1 --port 3100`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:3100/login',
  },
});
