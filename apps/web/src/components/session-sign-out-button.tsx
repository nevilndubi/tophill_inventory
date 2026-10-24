'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';

export function SessionSignOutButton() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const signOut = async () => {
    setPending(true);
    queryClient.clear();
    await createBrowserSupabaseClient().auth.signOut();
    window.location.replace('/login');
  };

  return (
    <Button disabled={pending} onClick={() => void signOut()}>
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
