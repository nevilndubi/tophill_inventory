import { Suspense } from 'react';
import { StatusBoard } from '@/components/status-board';
import { parseStatusBoardState } from '@/lib/status/url-state';

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const source = await searchParams;
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') values.append(key, value);
    else value?.forEach((item) => values.append(key, item));
  }
  const initialState = parseStatusBoardState(values);
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
      <StatusBoard initialState={initialState} />
    </Suspense>
  );
}
