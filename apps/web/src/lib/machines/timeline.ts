import type { MachineLiveStatus } from '@app/shared';

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds} s`;
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
};

export const timelineStatusSignal = (status: MachineLiveStatus): string =>
  [status.stored_condition, status.open_session?.id ?? 'none', status.as_of.slice(0, 10)].join(':');
