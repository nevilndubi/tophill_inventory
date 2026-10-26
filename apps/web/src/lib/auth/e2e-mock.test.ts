import { afterEach, describe, expect, it } from 'vitest';
import { e2eMockUser, isE2EMockAuthEnabled } from './e2e-mock';

const originalMode = process.env.PLAYWRIGHT_MOCK_MODE;

describe('Playwright auth seam', () => {
  afterEach(() => {
    process.env.PLAYWRIGHT_MOCK_MODE = originalMode;
  });

  it('is disabled unless the explicit local test flag is set', () => {
    delete process.env.PLAYWRIGHT_MOCK_MODE;
    expect(isE2EMockAuthEnabled()).toBe(false);
    process.env.PLAYWRIGHT_MOCK_MODE = '1';
    expect(isE2EMockAuthEnabled()).toBe(true);
  });

  it('fails an unknown requested role back to the constrained ADMIN fixture', () => {
    expect(e2eMockUser('UNKNOWN').role).toBe('ADMIN');
    expect(e2eMockUser('BIOMED_TECH').role).toBe('BIOMED_TECH');
  });
});
