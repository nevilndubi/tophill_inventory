import { NextResponse, type NextRequest } from 'next/server';
import { loginUrl, safeReturnPath } from '@/lib/auth/return-path';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('returnTo'));
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut({ scope: 'local' });
  return NextResponse.redirect(new URL(loginUrl(returnTo), request.url));
}
