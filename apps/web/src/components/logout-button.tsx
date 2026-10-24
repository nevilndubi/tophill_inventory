'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthenticatedUser } from './authenticated-user-provider';

export function LogoutButton() {
  const { signOut } = useAuthenticatedUser();

  return (
    <Button variant="ghost" onClick={() => void signOut()} aria-label="Sign out">
      <LogOut className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">Sign out</span>
    </Button>
  );
}
