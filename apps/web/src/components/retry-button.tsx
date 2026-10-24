'use client';

import { Button } from '@/components/ui/button';

export function RetryButton({ returnTo }: { returnTo: string }) {
  return <Button onClick={() => window.location.replace(returnTo)}>Retry</Button>;
}
