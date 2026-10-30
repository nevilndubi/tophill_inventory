export const STATUS_POLL_BASE_MS = 30_000;
export const STATUS_STALE_AFTER_MS = 90_000;
export const STATUS_CLOCK_SKEW_MS = 120_000;
export const STATUS_POLL_MAX_MS = 300_000;

export const statusPollDelay = (failureCount: number, jitter = 0): number => {
  const base = Math.min(STATUS_POLL_BASE_MS * 2 ** Math.max(0, failureCount), STATUS_POLL_MAX_MS);
  const boundedJitter = Math.max(-0.1, Math.min(0.1, jitter));
  return Math.min(Math.round(base * (1 + boundedJitter)), STATUS_POLL_MAX_MS);
};

export const elapsedFromAsOf = (_asOf: string, receivedAt: number, now: number): number =>
  Math.max(0, now - receivedAt);

export const hasClockSkew = (asOf: string, receivedAt: number): boolean =>
  Math.abs(receivedAt - Date.parse(asOf)) > STATUS_CLOCK_SKEW_MS;
