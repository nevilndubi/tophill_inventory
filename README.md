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

`GET /health/ready` checks both dependencies with short bounds. A database failure returns HTTP 503
and overall `down` because Postgres is the system of record. Redis failure alone remains HTTP 200 and
`degraded`.

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
