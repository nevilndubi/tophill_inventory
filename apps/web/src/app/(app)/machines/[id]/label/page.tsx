import { machineIdParamsSchema } from '@app/shared';
import Link from 'next/link';
import { SingleMachineLabel } from '@/components/single-machine-label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function MachineLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = machineIdParamsSchema.safeParse(await params);
  if (!parsed.success) {
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
  }
  return <SingleMachineLabel id={parsed.data.id} />;
}
