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

The examples contain safe local URLs and blank placeholders only. Variables marked as required are
validated when an app starts; variables for services introduced in later phases are optional for now
but are validated when supplied. Keep real credentials in ignored environment files and never commit
them.

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
```

TypeScript is strict across every workspace. ESLint and Prettier run repository-wide, and Husky
checks staged files plus conventional commit messages before a commit is accepted. The web app uses
Vitest for component and API-client tests; the API uses Jest for unit and e2e coverage.

The local web shell reads `NEXT_PUBLIC_API_URL` in the browser and calls the API's root `/health`
probe. Keep `WEB_ORIGIN` set to the exact web origin (the examples use `http://localhost:3000`) so
the API permits that browser request through CORS.
