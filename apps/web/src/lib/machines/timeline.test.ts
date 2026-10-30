import { describe, expect, it } from 'vitest';
import { formatDuration, timelineStatusSignal } from './timeline';

describe(formatDuration.name, () => {
  it.each([
    [59, '59 s'],
    [60, '1 min'],
    [3_599, '59 min'],
    [3_600, '1 h 00 min'],
    [90_000, '25 h 00 min'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe(timelineStatusSignal.name, () => {
  const status = {
    as_of: '2026-10-30T12:00:00.000Z',
    open_session: null,
    stored_condition: 'OPERATIONAL',
  } as Parameters<typeof timelineStatusSignal>[0];

  it('ignores ordinary same-day poll timestamps', () => {
    expect(timelineStatusSignal({ ...status, as_of: '2026-10-30T12:00:30.000Z' })).toBe(
      timelineStatusSignal(status),
    );
  });

  it('changes for condition, open-session and database-day boundaries', () => {
    const baseline = timelineStatusSignal(status);
    expect(timelineStatusSignal({ ...status, stored_condition: 'NEEDS_SERVICE' })).not.toBe(
      baseline,
    );
    expect(
      timelineStatusSignal({
        ...status,
        open_session: { id: '11111111-1111-4111-8111-111111111111' } as never,
      }),
    ).not.toBe(baseline);
    expect(timelineStatusSignal({ ...status, as_of: '2026-10-31T00:00:00.000Z' })).not.toBe(
      baseline,
    );
  });
});
