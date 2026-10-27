import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

process.env.API_BASE_URL = 'http://127.0.0.1:3001';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/tophill_test';
process.env.DIRECT_URL = 'postgresql://test:test@127.0.0.1:5432/tophill_test';
process.env.NEXT_PUBLIC_APP_ORIGIN = 'https://inventory.example.test';
process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_browser_safe';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';

afterEach(cleanup);

Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
  configurable: true,
  value: () => false,
});

Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});
