export const DEFAULT_AUTHENTICATED_PATH = '/';

export function safeReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.toLowerCase().includes('javascript:')
  ) {
    return DEFAULT_AUTHENTICATED_PATH;
  }

  try {
    const parsed = new URL(value, 'http://app.local');
    if (parsed.origin !== 'http://app.local') {
      return DEFAULT_AUTHENTICATED_PATH;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_AUTHENTICATED_PATH;
  }
}

export function loginUrl(returnPath: string): string {
  const safePath = safeReturnPath(returnPath);
  return `/login?returnTo=${encodeURIComponent(safePath)}`;
}
