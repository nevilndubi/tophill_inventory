import { Suspense } from 'react';
import { MachinesList } from '@/components/machines-list';
import { parseMachineListState } from '@/lib/machines/url-state';

export default async function MachinesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialState = parseMachineListState(await searchParams);
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
      <MachinesList initialState={initialState} />
    </Suspense>
  );
}
