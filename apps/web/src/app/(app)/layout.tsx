import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { AuthenticatedUserProvider } from '@/components/authenticated-user-provider';
import { requireCurrentAppUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const returnPath = (await headers()).get('x-tophill-return-path') ?? '/';
  const user = await requireCurrentAppUser(returnPath);

  return (
    <AuthenticatedUserProvider initialUser={user}>
      <AppShell>{children}</AppShell>
    </AuthenticatedUserProvider>
  );
}
