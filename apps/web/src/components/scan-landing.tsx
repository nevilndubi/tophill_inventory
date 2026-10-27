'use client';

import { useState, type FormEvent } from 'react';
import { QrCode, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { machineAssetTagSchema } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function ScanLanding() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = machineAssetTagSchema.safeParse(value);
    if (!parsed.success) {
      setError('Enter an asset tag such as HM-000001.');
      return;
    }
    setError(null);
    router.push(`/scan/${parsed.data}`);
  };

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <QrCode className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>
            <h1>Find a machine by asset tag</h1>
          </CardTitle>
          <CardDescription>
            Use this fallback when a printed QR code is damaged or cannot be scanned.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} noValidate className="space-y-4">
            <div>
              <label htmlFor="scan-asset-tag" className="text-sm font-medium">
                Asset tag
              </label>
              <Input
                id="scan-asset-tag"
                autoCapitalize="characters"
                autoComplete="off"
                className="mt-2 font-mono uppercase"
                value={value}
                onChange={(event) => setValue(event.target.value.toUpperCase())}
                aria-describedby={error ? 'scan-asset-tag-error' : 'scan-asset-tag-hint'}
                aria-invalid={Boolean(error)}
                placeholder="HM-000001"
              />
              <p id="scan-asset-tag-hint" className="mt-2 text-xs text-muted-foreground">
                Asset tags begin with HM- followed by at least six digits.
              </p>
              {error ? (
                <p id="scan-asset-tag-error" role="alert" className="mt-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <Button type="submit" className="min-h-11 w-full sm:w-auto">
              <Search aria-hidden="true" /> Find machine
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
