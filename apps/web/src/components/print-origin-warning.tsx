import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { needsPrintOriginWarning } from '@/lib/machines/asset-labels';

export function PrintOriginWarning({ origin }: { origin: string }) {
  if (!needsPrintOriginWarning(origin)) return null;
  return (
    <Alert variant="destructive" className="print-origin-warning" role="alert">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Development address — do not print real labels</AlertTitle>
      <AlertDescription>
        These labels point to {origin} and will not work for staff. Do not print real labels until
        the production domain is configured.
      </AlertDescription>
    </Alert>
  );
}
