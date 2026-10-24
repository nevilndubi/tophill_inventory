export const supabaseCookieOptions = {
  httpOnly: false,
  path: '/',
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
};
