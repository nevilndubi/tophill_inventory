# Supabase Auth setup

Task 2.1 configures Supabase for identity only. Neon remains the sole application database.
Supabase's database, generated REST API and Row Level Security must not contain or govern any
Tophill Inventory application data. Supabase Storage is reserved for Task 3.5 and Task 6.6.

## Project configuration

Apply these settings in **Authentication → Providers → Email** and **Authentication → URL
Configuration**:

| Setting | Required value |
|---|---|
| Email provider | Enabled |
| Allow new users to sign up | Disabled |
| Confirm email | Enabled |
| Minimum password length | 12 |
| Refresh-token rotation | Enabled |
| Refresh-token reuse interval | 10 seconds |
| Access-token lifetime | 3600 seconds (the Supabase default) |
| Site URL | `http://localhost:3000` |
| Redirect allow-list | `http://localhost:3000/**` only |

Do not add Vercel preview wildcards. Add the exact staging and production Site/redirect URLs only
after those domains exist, and re-run the authentication proof in each environment. Public and
anonymous sign-ups stay disabled; accounts are created by an administrator. Magic-link login is not
enabled for the initial product because email/password is the documented, tested flow.

The project uses modern `sb_publishable_...` and `sb_secret_...` keys, not the legacy `anon` and
`service_role` JWT keys. It uses an asymmetric ES256 signing key and verifies tokens through the
project JWKS endpoint, so no shared JWT secret is stored by the application. See Supabase's current
[API key](https://supabase.com/docs/guides/api/api-keys) and
[JWT signing key](https://supabase.com/docs/guides/auth/signing-keys) guidance.

## Environment variables

Copy the two tracked examples and replace placeholders only in ignored local environment files or
the deployment platform's secret store:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

- API: `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The API derives `SUPABASE_JWT_ISSUER` and
  `SUPABASE_JWKS_URL`; optional explicit values must match the project URL.
- Browser: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. These two values
  are intentionally public.
- Never put `SUPABASE_SECRET_KEY`, test passwords, access tokens or refresh tokens in any web
  variable, browser code, log, screenshot, issue, commit or chat message.

The API uses the secret key only with the Supabase Admin API to confirm the identity and verified
email involved in the one-off first-administrator bootstrap. It never reaches browser code. Bearer
tokens are verified independently through the public asymmetric JWKS; no shared JWT secret exists.

## Test user and safe proof

Supabase's built-in email sender is heavily rate-limited and may deliver only to project team
members. Until custom SMTP is configured with the planned Resend account in Phase 9, create the
dedicated non-staff test user in **Authentication → Users → Add user → Create new user**, set its
password directly, and mark the email confirmed. Do not use a real staff address.

Store only the test email and password in the ignored `apps/api/.env.task-2.1.local` file, restrict
it to its owner (`chmod 600`), and supply the project URL and publishable key through the shell. Then
run:

```bash
pnpm verify:supabase:auth
```

The verifier uses Supabase's documented password token endpoint. It never prints credentials or a
JWT. Its output is limited to the signing algorithm, presence of a key ID, issuer, audience, role,
expiry, JWKS match, and status/error codes proving that a wrong password and public sign-up are
rejected. Delete or rotate the test account when it is no longer needed.

Task 2.5 builds the real invitation flow after custom SMTP is available. Seed rows cannot be linked:
the database requires seed users to have no Supabase identity and real users to have one. They remain
inert examples until Task 2.5 creates real invited-user rows.

## First administrator bootstrap

1. Put the confirmed real administrator address in `BOOTSTRAP_SUPER_ADMIN_EMAIL` in an ignored,
   permission-restricted API environment file or deployment secret. Never use `@example.invalid`.
2. Ensure there is no active, non-seed `SUPER_ADMIN` in Neon.
3. Sign in through Supabase as that exact user and call authenticated `GET /api/v1/me` once.
4. The API verifies the ES256 access token, confirms the user and verified email through the Admin
   API, takes a database transaction lock, and creates the non-seed SUPER_ADMIN identity once.
5. Verify only the returned role and safe user ID. Never print the email, token, keys or password.
6. Remove `BOOTSTRAP_SUPER_ADMIN_EMAIL` after success. Even if it remains set, it has no effect once
   any active real SUPER_ADMIN exists.

The bootstrap creates no seed relationship and performs no email linking. Every other unknown valid
identity receives `USER_NOT_PROVISIONED` until Task 2.5 creates its real local row.

Task 2.2 proves this flow only on disposable Neon branches. With Task 2.4's browser login available,
perform the real one-time bootstrap against `dev` with the owner's address in the API's
own ignored `.env` (never the task credential file). At production rollout, repeat once against the
production database with the address supplied through the deployment secret store. Remove the
variable after each successful bootstrap and verify that `/me` resolves the same local user.

## Next.js web session flow

The web app follows Supabase's current App Router SSR pattern with `@supabase/ssr`:

- `src/proxy.ts` is the Next.js 16 convention (the old `middleware.ts` name is deprecated). It calls
  `auth.getClaims()` to validate/refresh the session and performs optimistic redirects only.
- Server Components use a fresh request-scoped Supabase client, call `getClaims()` before making any
  trust decision, and use `getSession()` only afterwards to retrieve the opaque bearer. The NestJS
  API independently verifies that bearer and supplies role, department and active state through
  `GET /api/v1/me`.
- The browser client signs in with email/password and maintains Supabase's cookie-backed session. It
  exposes no sign-up, magic-link or password-reset flow.
- Logout clears the Supabase session and the entire TanStack Query cache. Supabase auth-state events
  propagate sign-out to other open tabs.

Supabase SSR names the auth cookie `sb-<project-ref>-auth-token` and may split large values into
chunks. The browser client must read the refresh token to maintain the session, so Supabase's current
guidance explicitly does **not** make these cookies HttpOnly. The project uses `SameSite=Lax`, path
`/`, and `Secure` outside localhost. Compensating controls are the one-hour access-token lifetime,
refresh-token rotation, exact API-origin bearer checks, private/no-store refresh responses, and the
Content-Security-Policy scheduled for Task 10.2. Application code never stores a token in its own
React state or localStorage.

Only relative return paths beginning with a single `/` are accepted. Protocol-relative paths,
absolute URLs, backslashes and `javascript:` values fall back to `/`.

### Later environment redirect checklist

- [ ] Assign the exact staging web domain, then add its exact Site/redirect URLs and verify login,
      refresh and logout there.
- [ ] Assign the exact production web domain, then add its exact Site/redirect URLs and verify the
      same flow there.
- [ ] Keep Vercel preview-domain wildcards absent.
- [ ] Keep the local Site URL `http://localhost:3000` and local redirect entry
      `http://localhost:3000/**` until the environment-specific domains are real.

## Verification checklist

- [ ] Project is healthy and accessible through the dashboard or authenticated CLI.
- [ ] Email/password, confirmation, password length, refresh rotation and token lifetime match the
      table above.
- [ ] Public and anonymous sign-ups are disabled.
- [ ] Site URL and the single local redirect pattern are exact; no preview wildcard exists.
- [ ] A modern publishable key and modern secret key exist.
- [ ] JWKS advertises the ES256 key used by a successful test-user token.
- [ ] Wrong-password login returns `invalid_credentials`.
- [ ] Public sign-up returns `signup_disabled`.
- [ ] The test credential file is ignored and mode `600`.
- [ ] The secret key's name and value are absent from browser build assets.
- [ ] Supabase's `public` schema contains no application tables and Storage has no premature buckets.
- [ ] Exact staging and production URLs are added and verified when those domains are assigned.
