import { Suspense } from 'react';
import { machineIdParamsSchema } from '@app/shared';
import Link from 'next/link';
import { MachineDetail } from '@/components/machine-detail';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function MachinePage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = machineIdParamsSchema.safeParse(await params);
  if (!parsed.success)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Machine not found</CardTitle>
          <CardDescription>The machine address is not valid.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/machines">Back to machines</Link>
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
      <MachineDetail id={parsed.data.id} />
    </Suspense>
  );
}
