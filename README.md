# Tophill Inventory

Hospital equipment tracking and booking system. This repository currently contains the Task 0.1 monorepo scaffold only.

## Workspaces

- `apps/web` — Next.js App Router frontend
- `apps/api` — NestJS API
- `packages/shared` — shared TypeScript library

## Requirements

- Node.js 24.22.0
- pnpm 9.15.9

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
checks staged files plus conventional commit messages before a commit is accepted. Test suites are
added by their dedicated later tasks.
