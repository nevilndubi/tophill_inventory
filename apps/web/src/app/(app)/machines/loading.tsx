import { Skeleton } from '@/components/ui/skeleton';

export default function MachinesLoading() {
  return (
    <div className="space-y-4" aria-label="Loading machines">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
