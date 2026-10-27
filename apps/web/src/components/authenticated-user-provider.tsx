'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AppUser } from '@/lib/auth/types';
import { createBrowserSupabaseClient } from '@/lib/supabase/browser';
import { clearLabelSelection } from '@/lib/machines/asset-labels';

type AuthenticatedUserContextValue = {
  signOut: () => Promise<void>;
  user: AppUser;
};

const AuthenticatedUserContext = createContext<AuthenticatedUserContextValue | null>(null);
const replaceLocation = (url: string) => window.location.replace(url);

export function AuthenticatedUserProvider({
  children,
  initialUser,
  navigateToLogin = replaceLocation,
}: {
  children: React.ReactNode;
  initialUser: AppUser;
  navigateToLogin?: (url: string) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const handlingSignOut = useRef(false);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const finishSignOut = useCallback(
    async (scope: 'global' | 'local' = 'global') => {
      if (handlingSignOut.current) return;
      handlingSignOut.current = true;
      queryClient.clear();
      clearLabelSelection();
      await supabase.auth.signOut({ scope });
      navigateToLogin('/login');
    },
    [navigateToLogin, queryClient, supabase],
  );

  useEffect(() => {
    const onInvalidSession = () => void finishSignOut('local');
    const onForbidden = (event: Event) => {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code;
      router.push(
        code === 'USER_INACTIVE' || code === 'USER_NOT_PROVISIONED' ? '/no-access' : '/forbidden',
      );
    };
    const onUnavailable = () => setAuthUnavailable(true);
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        queryClient.clear();
        clearLabelSelection();
        if (!handlingSignOut.current) {
          handlingSignOut.current = true;
          navigateToLogin('/login');
        }
      }
    });

    window.addEventListener('tophill:session-invalid', onInvalidSession);
    window.addEventListener('tophill:forbidden', onForbidden);
    window.addEventListener('tophill:auth-unavailable', onUnavailable);

    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener('tophill:session-invalid', onInvalidSession);
      window.removeEventListener('tophill:forbidden', onForbidden);
      window.removeEventListener('tophill:auth-unavailable', onUnavailable);
    };
  }, [finishSignOut, navigateToLogin, queryClient, router, supabase]);

  return (
    <AuthenticatedUserContext.Provider
      value={{ signOut: () => finishSignOut('global'), user: initialUser }}
    >
      {authUnavailable ? (
        <div
          className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-status-needs-service px-4 py-3 text-sm font-medium text-white shadow-lg"
          role="alert"
        >
          <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
          <span>Authentication is temporarily unavailable. Your session is still signed in.</span>
          <Button
            variant="ghost"
            className="h-8 border border-white/40 text-white hover:bg-white/10 hover:text-white"
            onClick={() => {
              setAuthUnavailable(false);
              router.refresh();
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
      {children}
    </AuthenticatedUserContext.Provider>
  );
}

export function useAuthenticatedUser(): AuthenticatedUserContextValue {
  const context = useContext(AuthenticatedUserContext);
  if (!context) {
    throw new Error('useAuthenticatedUser must be used inside AuthenticatedUserProvider');
  }
  return context;
}
