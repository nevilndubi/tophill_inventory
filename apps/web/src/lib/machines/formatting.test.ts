import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatNairobiDateTime, isServiceOverdue } from './formatting';

describe('machine date formatting', () => {
  it('formats a DATE from its plain parts without a timezone shift', () => {
    expect(formatDateOnly('2026-01-01')).toContain('1 Jan 2026');
    expect(formatDateOnly('2026-12-31')).toContain('31 Dec 2026');
  });

  it('shows timestamps in Africa/Nairobi', () => {
    expect(formatNairobiDateTime('2026-01-01T21:30:00.000Z')).toContain('2 Jan 2026');
  });

  it('marks a due timestamp at or before now as overdue', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    expect(isServiceOverdue('2026-10-26T12:00:00.000Z', now)).toBe(true);
    expect(isServiceOverdue('2026-10-26T12:00:00.001Z', now)).toBe(false);
    expect(isServiceOverdue(null, now)).toBe(false);
  });
});
