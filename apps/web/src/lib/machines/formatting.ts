export const formatDateOnly = (value: string | null): string => {
  if (value === null) return 'Not recorded';
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
};

export const formatNairobiDateTime = (value: string | null): string =>
  value === null
    ? 'Not recorded'
    : new Intl.DateTimeFormat('en-KE', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Africa/Nairobi',
      }).format(new Date(value));

export const isServiceOverdue = (value: string | null, now = new Date()): boolean =>
  value !== null && new Date(value).getTime() <= now.getTime();
