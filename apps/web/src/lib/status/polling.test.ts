import { describe, expect, it } from 'vitest';
import { elapsedFromAsOf, hasClockSkew, statusPollDelay } from './polling';

describe('status board polling clock', () => {
  it('backs off, caps at five minutes and applies only bounded jitter', () => {
    expect(statusPollDelay(0, -0.1)).toBe(27_000);
    expect(statusPollDelay(1, 0)).toBe(60_000);
    expect(statusPollDelay(2, 0)).toBe(120_000);
    expect(statusPollDelay(9, 0.1)).toBe(300_000);
  });

  it('anchors elapsed time to the response clock plus local elapsed time', () => {
    expect(elapsedFromAsOf('2026-10-30T06:00:00.000Z', 1_000_000, 1_012_000)).toBe(12_000);
    expect(hasClockSkew('2026-10-30T06:00:00.000Z', Date.parse('2026-10-30T06:01:59.000Z'))).toBe(
      false,
    );
    expect(hasClockSkew('2026-10-30T06:00:00.000Z', Date.parse('2026-10-30T06:02:01.000Z'))).toBe(
      true,
    );
  });
});
