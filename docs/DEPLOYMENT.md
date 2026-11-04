# Demo deployment runbook

This runbook describes the maintenance demo deployment. It does not replace Task 11.3's production
deployment design. Neon remains the application database, Supabase remains Auth and private Storage,
and Redis remains a cache rather than a source of truth.

## Targets

| Component | Target | Required configuration |
|---|---|---|
| Web | Vercel project `tophill-inventory` | `apps/web`, Node 24, production domain `https://tophill-inventory.nevilndubi.me` |
| API | Render web service `tophill-inventory-api` | Frankfurt, free plan, repository root, branch `main` |
| Database | Neon branch `staging` | pooled URL for the API, direct URL for migrations |
| Redis | Upstash database `tophill-inventory-demo` | free plan, TLS, `rediss://` URL |
| Auth/files | Existing Supabase project | Auth and private Storage only |

Local development is unchanged: web on port 3000, API on port 3001, Docker Redis and Neon `dev`.

## Release order

Deploy database changes before new API code receives traffic:

1. Select only the Neon `staging` branch and capture its direct and pooled connection strings without
   displaying them.
2. Run `pnpm prisma:migrate:deploy` with `DATABASE_URL` set to the pooled URL and `DIRECT_URL` to the
   direct URL.
3. Run `pnpm exec prisma migrate status --config prisma7.config.ts` and the repository drift check.
4. Run the guarded demo seed only after `SEED_ALLOWED_BRANCH=staging`,
   `SEED_ALLOW_STAGING_DEMO=true`, `SEED_STAGING_HOST` and both existing host guards have been
   verified against Neon branch metadata. Without that exact deployment-only opt-in, the seed
   continues to reject staging. It always rejects `main`.
5. Deploy the API and wait for `/health` and `/health/ready`.
6. Deploy the web application and verify authentication, CORS and the production domain.

Never run demo migrations or seed commands against Neon `main` or `dev`.

## API build and runtime

Render uses the repository root (no root-directory override).

```bash
corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter @app/shared build && pnpm --filter @app/api build
pnpm --filter @app/api start
```

The API binds to `0.0.0.0` and uses Render's `PORT` (normally 10000). Set these environment variable
names in Render without exposing their values:

- `NODE_VERSION=24.22.0`
- `NODE_ENV=production`
- `WEB_ORIGIN=https://tophill-inventory.nevilndubi.me`
- `READINESS_DB_TIMEOUT_MS=8000`
- `DATABASE_URL` (Neon staging pooled URL)
- `DIRECT_URL` (Neon staging direct URL)
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `REDIS_URL` (Upstash TLS URL)

Use `/health` as Render's health-check path. `/health/ready` additionally proves that Neon and Redis
are available. Free instances and scale-to-zero databases can be cold; retry readiness once before
declaring an outage.

## Web build and runtime

Vercel project settings:

- Root Directory: `apps/web`
- Include source files outside the Root Directory: enabled
- Framework: Next.js
- Node.js: 24.x
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm --filter @app/shared build && pnpm --filter @app/web build`

Production-only environment variable names:

- `NEXT_PUBLIC_APP_ORIGIN`
- `NEXT_PUBLIC_API_URL`
- `API_BASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

The Supabase secret key is API-only and must never be configured in Vercel.

## Supabase Auth

Keep public and anonymous sign-up disabled. Configure the Site URL as the production web origin and
the redirect allow-list as exactly the localhost and production patterns documented in
[`SUPABASE_SETUP.md`](SUPABASE_SETUP.md). Keep preview-domain wildcards absent. Use the production
`/auth/confirm` redirect in the invite template. If custom SMTP is not configured, the built-in
sender remains limited to project-team addresses and is acceptable only for this controlled demo.

Bootstrap the first production administrator once: create and confirm the Supabase identity
privately, temporarily set `BOOTSTRAP_SUPER_ADMIN_EMAIL` in Render, redeploy, sign in once, verify a
single active non-seed SUPER_ADMIN by count only, remove the variable and redeploy again.

## Redeployment

API:

```bash
render deploys create <render-service-id> --wait --confirm
```

Web:

```bash
vercel deploy --prod --yes
```

Database migrations must precede API deployment whenever a release includes a migration. Task 11.3
will move this ordering into CI. Until then, follow the guarded operator procedure above.

## Verification

- Web domain returns HTTP 200.
- An unauthenticated protected page redirects to `/login`.
- API `/health` is live and `/health/ready` reports database and Redis `up`.
- Production-origin CORS preflight allows `Authorization`, `Content-Type`, `Idempotency-Key` and
  `X-Request-Id`; a different origin receives no allow-origin header.
- Browser bundles contain neither the Supabase server-secret prefix nor the server-secret variable
  name.
- Localhost still starts through the README workflow against Neon `dev` and local Docker Redis.

## Free-tier operational limits

- Render free web services can cold-start after idle periods.
- Neon staging can scale to zero; readiness allows an 8-second database wake window.
- Upstash free Redis has a command quota; Redis failure degrades the API but does not replace Neon.
- Phase 9 BullMQ workers require a paid persistent Redis/service design before production use.
- Vercel Hobby use must remain within its applicable terms.
- Print permanent QR labels only after the final custom domain is verified.
