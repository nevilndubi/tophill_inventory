# Tophill Inventory

Hospital equipment tracking and booking system.

## Workspaces

- `apps/web` — Next.js App Router frontend
- `apps/api` — NestJS API
- `packages/shared` — shared TypeScript library

## Requirements

- Node.js 24.22.0
- pnpm 9.15.9

## Environment setup

Copy each application's example before starting the workspace:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

The examples contain safe local URLs and credential-shaped placeholders only. Variables marked as
required are validated when an app starts; variables for services introduced in later phases remain
optional but are validated when supplied. Replace both database placeholders with the matching Neon
`dev` branch URLs: `DATABASE_URL` uses the pooled (`-pooler`) host for API traffic and `DIRECT_URL`
uses the direct host for Prisma migrations. Keep real credentials in ignored environment files and
never commit them.

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm prisma:generate
pnpm prisma:migrate:dev
pnpm prisma:migrate:deploy
pnpm db:seed
pnpm db:seed:verify
pnpm db:index-review
pnpm verify:supabase:auth
```

TypeScript is strict across every workspace. ESLint and Prettier run repository-wide, and Husky
checks staged files plus conventional commit messages before a commit is accepted. The web app uses
Vitest for component and API-client tests; the API uses Jest for unit and e2e coverage.

The local web shell reads `NEXT_PUBLIC_API_URL` in the browser and calls the API's root `/health`
probe. Keep `WEB_ORIGIN` set to the exact web origin (the examples use `http://localhost:3000`) so
the API permits that browser request through CORS.

## Local Redis

Start the local Redis service before running the API:

```bash
docker compose up -d redis
docker compose ps redis
```

Development defaults to `redis://127.0.0.1:6379`. Production requires an explicitly configured
`rediss://` URL. Redis connects in the background: if it is unavailable, the API still boots and
`GET /health/ready` returns `degraded` promptly. Automated tests use an unreachable port or an
in-memory stand-in and never require Docker.

```bash
docker compose stop redis
docker compose down
```

## Prisma and Neon

Prisma 7.10.1 generates a CommonJS client into the API source tree before every root build,
typecheck, and test. Generation is offline; connected migration commands read `DIRECT_URL` from the
shell or `apps/api/.env`. The initial migration establishes Prisma's history, and the next migration
adds the core users, departments, and locations schema.

Use the Neon branches as follows:

- `main` is production. Only the deployment pipeline applies reviewed migrations here before new API
  traffic is switched over.
- `staging` backs the staging API slot. Apply the same committed migrations with
  `pnpm prisma:migrate:deploy` before staging verification.
- `dev` is the long-lived development branch. Create migrations here with
  `pnpm prisma:migrate:dev -- --name <migration-name>` and commit the generated SQL.
- CI database integration jobs create an ephemeral branch from `dev`, use its pooled URL for runtime
  and direct URL for migrations, apply committed migrations, run the explicit integration suite, and
  delete the branch when the job or pull request finishes. The default unit/e2e suite remains
  hermetic and does not contact Neon.

Run the real-database suite only against a disposable Neon branch:

```bash
INTEGRATION_DATABASE_BRANCH=ci/<branch-name> \
INTEGRATION_DATABASE_URL='<pooled ephemeral URL>' \
DATABASE_URL='<pooled dev URL>' \
DIRECT_URL='<direct dev URL>' \
pnpm test:integration
```

The guard rejects missing values, non-Neon URLs, `main`, `staging`, `dev`, and an integration URL
equal to either normal application/migration URL. The suite removes every record it creates; branch
automation must still delete the disposable branch after the run. Never put connection strings in
tracked files or command logs.

### Demo seed data

`pnpm db:seed` loads deterministic demonstration data only when all three safety confirmations are
present: `SEED_ALLOWED_BRANCH`, an exact `SEED_ALLOWED_HOST` match, and
`SEED_PROTECTED_HOSTS` containing the production `main` and `staging` hosts. The command rejects
`main`, `staging`, mismatched hosts, and every CI environment before connecting. It is safe to rerun:
fixed identifiers and upserts refresh relative demo dates without duplicating records. Seed users
use reserved `@example.invalid` addresses, have no Supabase identity, and cannot sign in; Task 2.2
does not link them. Task 2.5 creates real invited-user rows with Supabase identities.

Never print or echo a database URL or password. The Task 1.7 Neon helper invokes branch creation
with `--no-secrets`, captures connection strings only in child-process memory, and prints only safe
branch metadata and command results. `prisma migrate reset` is destructive and is development-only;
never run it against `main` or `staging`.

`pnpm db:seed:verify` checks the seeded counts and consistency. `pnpm db:index-review` additionally
proves asset-tag sequence continuity and runs the documented EXPLAIN review using temporary rows
inside a rolled-back transaction. Both commands require the same seed safety variables.

`GET /health/ready` checks both dependencies with short bounds. A database failure returns HTTP 503
and overall `down` because Postgres is the system of record. Redis failure alone remains HTTP 200 and
`degraded`.

## Supabase Auth

Supabase supplies identity (and later private file storage) while Neon remains the only application
database. The browser receives only the modern publishable key; the modern secret key is API-only.
The hosted Auth project is invite-only and uses email/password plus asymmetric ES256/JWKS token
verification. Follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) for the exact dashboard
settings, safe test-user procedure and credential-free verification command.

The API protects application routes globally. Root health probes and non-production Swagger are
public; all current and future controllers require a strict Supabase Bearer token unless explicitly
marked public. `GET /api/v1/me` returns the authenticated local user's safe profile. To bootstrap the
first real administrator, set `BOOTSTRAP_SUPER_ADMIN_EMAIL` only in an ignored local environment
file or deployment secret, sign in as that confirmed Supabase user, and call `/api/v1/me`. The value
is ignored once an active non-seed SUPER_ADMIN exists and must never be a seed or `.invalid` address.
The real `dev` bootstrap waits until Task 2.4 provides web login and uses the API's ignored `.env`;
production repeats it once using the deployment secret store.

## Continuous integration

GitHub Actions runs frozen installation, formatting, linting, typechecking, tests, and the full build
for pull requests targeting `main` and pushes to `main`. Tests provide their own fixed localhost
configuration and do not read developer `.env` files. The build step receives only non-secret
localhost URLs required by environment validation.

After the first workflow run creates the `Quality` status check, protect `main` in the repository
settings with these rules:

- Require a pull request with at least one approval and resolved conversations before merging.
- Require the `Quality` status check and require the branch to be up to date before merging.
- Block force pushes and branch deletion, and do not allow bypasses for routine changes.

The workflow cannot be executed completely outside GitHub Actions. Before enabling the required
status check, push a task branch, open a pull request into `main`, and confirm that its single
`Quality` job runs the install, format, lint, typecheck, test, and build steps successfully.
