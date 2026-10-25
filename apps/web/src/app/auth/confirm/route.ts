import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnPath } from '@/lib/auth/return-path';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type');
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('returnTo'));

  if (!tokenHash || type !== 'invite') {
    return NextResponse.redirect(new URL('/auth/invite-invalid', request.url));
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type satisfies EmailOtpType,
  });

  if (error) {
    return NextResponse.redirect(new URL('/auth/invite-invalid', request.url));
  }

  const destination = new URL('/auth/set-password', request.url);
  destination.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(destination);
}
