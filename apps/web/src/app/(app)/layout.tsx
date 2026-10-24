import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { AuthenticatedUserProvider } from '@/components/authenticated-user-provider';
import { requireCurrentAppUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const user = await requireCurrentAppUser('/');

  return (
    <AuthenticatedUserProvider initialUser={user}>
      <AppShell>{children}</AppShell>
    </AuthenticatedUserProvider>
  );
}
