# PROJECT MODEL HANDOFF — Hospital Equipment Tracking & Booking System

> **READ THIS FILE FIRST, IN FULL, BEFORE DOING ANYTHING.**
> **UPDATE THIS FILE LAST, BEFORE YOU REPLY, AFTER EVERY PROMPT.**
> This file is the single source of truth for scope, rules and progress. The owner will not repeat the scope in prompts. If a prompt is short ("do 3.3"), everything you need is here, in `docs/ARCHITECTURE.md`, and in `docs/PHASE_GUIDE.md`.

Companion docs (read the relevant sections before starting a task):
- `docs/ARCHITECTURE.md` — system design, data model, state machines, caching, realtime, deployment
- `docs/PHASE_GUIDE.md` — every phase and task with goals, steps, acceptance criteria

---

## 1. What we are building (scope)

A web application for a hospital to **track its medical machines/equipment**. Nothing else.

The owner's original brief, verbatim intent: *"A hospital system for machines only, that shows whether each machine is in use or not; if it is not in use, whether it is fine or needs service; and an option to book any machine."*

### Core capabilities (IN SCOPE)
1. **Machine registry** — every machine has an asset tag, name, category, make/model, serial number, department, location (ward/room), purchase/warranty info, photos/documents.
2. **Live status** — for each machine, at a glance:
   - **Usage:** `IN_USE` or `AVAILABLE` (who has it, since when, expected until when)
   - **Condition (when not in use):** `OPERATIONAL` (fine) or `NEEDS_SERVICE` (also `UNDER_MAINTENANCE`, `OUT_OF_SERVICE`, `RETIRED`)
3. **Booking** — any authorized user can book any bookable machine for a time window. **Double-booking must be impossible**, enforced at the database level.
4. **Service/maintenance** — anyone can report a fault; technicians manage service tickets; preventive-maintenance schedules flag machines that are due.
5. **Dashboard & reports** — availability, utilization, downtime, overdue service, booking activity.
6. **Users & roles**, **audit trail**, **notifications**.

### OUT OF SCOPE (do NOT build, do NOT suggest building without owner approval)
- Patient records, EMR/EHR, appointments, billing, pharmacy, lab results, staff payroll/rota
- **No patient data (PHI) is stored anywhere in this system.** Booking purpose fields are free text — add a UI warning: "Do not enter patient names or identifiers."
- Consumables/stock inventory (gloves, drugs, etc.) — machines only
- Procurement/purchasing workflows, native mobile apps, IoT/sensor integration (possible future work, see Backlog)

If a request drifts out of scope, say so in your reply and log it in the Backlog instead of building it.

---

## 2. Domain model in brief

Two **independent** fields describe a machine. Never merge them into one enum.

| Field | Values | Meaning |
|---|---|---|
| Usage state (**derived**, not stored) | `IN_USE`, `AVAILABLE` | `IN_USE` iff the machine has an open usage session (checked out, not yet checked in) |
| `condition` (stored) | `OPERATIONAL`, `NEEDS_SERVICE`, `UNDER_MAINTENANCE`, `OUT_OF_SERVICE`, `RETIRED` | Physical/service health, changed only through the condition state machine |

**Display status** (what the UI shows) is computed from both:
`In use` · `Available — fine` · `Available — needs service` · `Under maintenance` · `Out of service` · `Retired`

**Bookability rule (default):** a machine is bookable only when `condition = OPERATIONAL`. `NEEDS_SERVICE` machines are not bookable unless an Admin sets the per-machine flag `allow_booking_when_needs_service = true`.

**Booking lifecycle:** `PENDING` (only if machine `requires_approval`) → `CONFIRMED` → `IN_PROGRESS` (checked in) → `COMPLETED`; or `CANCELLED` / `REJECTED` / `NO_SHOW`.

**Service ticket lifecycle:** `OPEN` → `ASSIGNED` → `IN_PROGRESS` → `RESOLVED` → `CLOSED` (or `CANCELLED`). Opening a high-severity ticket can move the machine's condition; resolving it returns it to `OPERATIONAL` through the state machine.

**Roles:** `SUPER_ADMIN`, `ADMIN`, `BIOMED_TECH`, `DEPT_MANAGER`, `STAFF`, `VIEWER`. Permission matrix lives in `docs/ARCHITECTURE.md` §7 — never hardcode role checks ad hoc; use the permission guard.

**Time:** store everything in UTC (`timestamptz`); display in `Africa/Nairobi`.

---

## 3. Tech stack (decided — do not change without owner approval)

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces: `apps/web`, `apps/api`, `packages/shared` |
| Frontend | Next.js (App Router, TypeScript strict), Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form + Zod |
| Backend | NestJS (TypeScript strict), REST + OpenAPI (`@nestjs/swagger`), Zod validation via shared schemas |
| Database | **Neon PostgreSQL** — the single system of record |
| ORM / migrations | Prisma (raw SQL migrations allowed and required for the booking exclusion constraint) |
| Cache / pub-sub / queues | **Redis** (ioredis; BullMQ for jobs) — cache is never the source of truth |
| Auth + file storage | **Supabase** — Auth (JWT) and Storage only. **Supabase's own Postgres is NOT used for app data.** |
| Source control / CI | GitHub + GitHub Actions |
| Web hosting | Vercel |
| API hosting | Persistent Node host (Azure App Service recommended; owner already uses Azure for staging). Not serverless — realtime (SSE) and BullMQ workers need a long-lived process |
| Email | Resend (Phase 9) |
| Monitoring | Sentry + structured logs (pino) |
| Tests | Jest (API), Vitest (web/shared), Playwright (e2e) |

Open decisions are tracked in §11 (Decision Log). If you believe a stack choice is wrong, do not silently deviate — record your concern in the Decision Log and continue with the decided stack unless it is a hard blocker (see §7).

---

## 4. Repository layout (target)

```
/
├─ apps/
│  ├─ web/                  # Next.js
│  └─ api/                  # NestJS
│     └─ src/modules/       # auth, users, departments, locations, categories,
│                           # machines, usage, bookings, service, dashboard,
│                           # notifications, audit, files, cache, realtime, health
├─ packages/
│  └─ shared/               # zod schemas, enums, DTO types, constants (used by web + api)
├─ prisma/                  # schema.prisma, migrations/, seed.ts
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ PHASE_GUIDE.md
├─ .github/workflows/
├─ docker-compose.yml       # local Redis (+ optional local Postgres)
├─ project_model_handoff.md # THIS FILE (keep at repo root)
└─ README.md
```

---

## 5. Engineering rules (non-negotiable)

1. **Build in vertical slices, one task at a time.** One prompt = one task ID from the checklist (or part of one). Never start the next task in the same prompt unless explicitly told to. Never scaffold "everything".
2. **Plan before code.** At the start of each task, write a 3–8 line plan (files to touch, schema changes, tests) in your reply, then execute.
3. **Dependency order is strict.** Do not start a task whose prerequisites in `docs/PHASE_GUIDE.md` are unchecked. If asked to, say what's missing and do the prerequisite instead.
4. **Schema changes only via Prisma migrations.** Never edit the database by hand. Never edit an already-applied migration; add a new one. Migrations must be reviewed for destructive operations.
5. **Business rules live in the API**, never only in the UI. The UI mirrors rules for UX; the API and database enforce them.
6. **Double-booking prevention is a database constraint** (Postgres `EXCLUDE USING gist` on `machine_id` + `tstzrange`), plus friendly error mapping in the API. Application-level checks alone are not acceptable.
7. **Validation:** every request body/query is validated with a shared Zod schema from `packages/shared`. Never trust client input. Never return Prisma models directly — map to response DTOs.
8. **Auth on everything** by default (global guard); public routes must be explicitly marked `@Public()`. Authorization via permission decorators, not inline role comparisons.
9. **Redis is a cache, not a database.** Every cached read must work (slower) if Redis is down; Redis failures must degrade gracefully, never take down the API. Every cache key has a TTL and a documented invalidation path.
10. **Audit every mutation** of machines, conditions, bookings, tickets, users and roles (from Phase 10 onward the interceptor does this; before that, leave `// AUDIT:` TODO markers where needed).
11. **No secrets in the repo.** All config via validated env (`.env.example` kept current). Never log tokens, keys or full JWTs.
12. **No patient data.** If a field could plausibly hold patient identifiers, add a warning and do not index/log it.
13. **TypeScript strict, no `any`** without a `// reason:` comment. No `@ts-ignore`. ESLint and Prettier must pass.
14. **Tests ship with the feature.** Each task adds unit tests for logic and an e2e/integration test for the endpoint or flow; booking and state-machine code needs thorough tests including concurrency.
15. **Small, conventional commits** (`feat(api): ...`, `fix(web): ...`, `chore: ...`, `docs: ...`) on a branch named `phase-N/task-N.N-short-name`. Open/describe a PR if git access allows; otherwise commit to the branch and say so.
16. **Accessibility & responsiveness:** every screen works on a hospital-ward tablet (≥768px) and phone (≥360px); semantic HTML, keyboard reachable, colour never the only status signal (use icon + text + colour).
17. **Do not refactor unrelated code** or "improve" things outside the current task. Note them in Pending/Backlog instead.
18. **Do not leave the repo broken.** At the end of every prompt: install, lint, typecheck, tests and build must pass for what you touched. If something can't pass, say exactly what and why in the log.

---

## 6. Mandatory workflow for EVERY prompt

### 6.1 Before you start
1. Read this whole file, then the relevant parts of `docs/ARCHITECTURE.md` and the task's section in `docs/PHASE_GUIDE.md`.
2. Run `git status` / `git log -5 --oneline` and compare against §9 (Current Status) and §12 (Session Log). If the repo and this file disagree, **trust the repo**, fix the file, and note the discrepancy in the log.
3. Identify the task ID(s) the owner asked for. If the prompt is vague ("continue"), do the first unchecked task in §8 (Checklist) whose prerequisites are met.
4. State your short plan.

### 6.2 While working
- Follow §5. Make decisions inside the documented architecture. Prefer the simplest thing that meets the acceptance criteria.
- Run the checks (lint, typecheck, tests, build) before declaring done. Report real results; never claim a check passed if you did not run it.

### 6.3 Before you reply (REQUIRED — the task is not done until this is done)
Update **this file**:
1. **§8 Checklist:** tick `[x]` only tasks whose acceptance criteria are fully met and verified. Use `[~]` for partially done (and say what's left in the log). Never tick speculatively.
2. **§9 Current Status:** update phase/task, overall percent (= ticked tasks ÷ total tasks), last updated timestamp, branch, last commit, and the exact **Next task** to do.
3. **§12 Session Log:** append a new entry at the **bottom** using the template there. Entries are append-only — never edit or delete past entries (correct mistakes with a new entry).
4. **§10 Pending / Backlog:** add anything discovered but not done; remove items you completed.
5. **§11 Decision Log:** record any non-obvious decision (what, why, alternatives).
6. **§13 Known Issues:** add/resolve bugs, flaky tests, tech debt.
7. **§14 Environment & Setup:** update if env vars, scripts, services or commands changed.
8. If you changed architecture or the data model, update `docs/ARCHITECTURE.md` in the same commit.

Then reply with: what you did, what you verified (with commands), what changed in this file, and the **next recommended prompt**.

---

## 7. When to stop and ask the owner (escalation — keep this list narrow)

Work autonomously. Do **not** ask for permission for routine choices (naming, file layout, library usage within the stack, UI details). Stop and ask only when:

1. A **destructive or irreversible action** is required against a shared/production database or branch (drop table/column with data, reset, force-push to `main`).
2. You need a **secret, account, or external access** you do not have (Supabase keys, Neon connection strings, Vercel/Azure access, Redis URL).
3. The request would **change scope** (§1), the **stack** (§3), or the **core domain model** (§2) in a way not already documented.
4. A requirement is **genuinely ambiguous and the wrong guess is expensive** (e.g., would require a schema rewrite). Offer your best-guess default and the alternative so the owner can answer in one line.
5. The same failure persists after **3 distinct fix attempts** — report what you tried and what you suspect.

Otherwise: decide, proceed, and log the decision.

---

## 8. PHASE CHECKLIST (progress against the plan)

Legend: `[ ]` not started · `[~]` partial · `[x]` done and verified. Full detail per task is in `docs/PHASE_GUIDE.md`.

### Phase 0 — Foundation & Tooling
- [x] 0.1 Monorepo scaffold (pnpm, apps/web, apps/api, packages/shared)
- [x] 0.2 Code quality tooling (TS strict, ESLint, Prettier, Husky, lint-staged, commitlint)
- [x] 0.3 Env management & validation, `.env.example`
- [x] 0.4 API bootstrap (config, health, Swagger, validation pipe, error filter, logger, request-id)
- [x] 0.5 Web bootstrap (App Router, Tailwind, shadcn/ui, layout shell, typed API client)
- [ ] 0.6 CI pipeline (GitHub Actions: lint, typecheck, test, build)
- [ ] 0.7 Local dev services (docker-compose Redis) + Redis module skeleton & health check

### Phase 1 — Database & Schema
- [ ] 1.1 Prisma + Neon setup (pooled runtime URL, direct migration URL, branch strategy)
- [ ] 1.2 Core tables: users, departments, locations
- [ ] 1.3 Machine tables: categories, machines, machine_status_history
- [ ] 1.4 Usage & booking tables incl. `EXCLUDE` constraint (raw SQL migration)
- [ ] 1.5 Service tables: service_tickets, service_records, maintenance_schedules
- [ ] 1.6 Support tables: audit_logs, notifications, attachments, app_settings
- [ ] 1.7 Indexes, seed script (realistic demo data), migration review

### Phase 2 — Authentication & Authorization
- [ ] 2.1 Supabase Auth project setup & config
- [ ] 2.2 API JWT guard (JWKS verification) + local user provisioning/sync
- [ ] 2.3 RBAC: roles, permissions map, `@RequirePermission()` guard
- [ ] 2.4 Web auth: login/logout, session handling, route protection
- [ ] 2.5 User management (invite, assign role/department, deactivate)
- [ ] 2.6 Auth/RBAC test suite

### Phase 3 — Machine Registry
- [ ] 3.1 Categories CRUD (API + UI)
- [ ] 3.2 Departments & locations CRUD (API + UI)
- [ ] 3.3 Machines CRUD API (pagination, filter, search, sort)
- [ ] 3.4 Machines UI (list, detail, create/edit)
- [ ] 3.5 Attachments (photos/manuals) via Supabase Storage signed URLs
- [ ] 3.6 Asset tag / QR label generation & scan-lookup page
- [ ] 3.7 Bulk CSV import with validation report
- [ ] 3.8 Retire / soft-delete & restore

### Phase 4 — Status: Usage & Condition
- [ ] 4.1 Condition state machine + status history
- [ ] 4.2 Usage sessions: check-out / check-in API
- [ ] 4.3 Live status service (derived display status)
- [ ] 4.4 Status board UI (grid/list, filters, colour+icon+text)
- [ ] 4.5 Machine detail: status panel & timeline

### Phase 5 — Booking Engine
- [ ] 5.1 Booking rules/config (max duration, lead time, buffer, approval flag)
- [ ] 5.2 Availability query API
- [ ] 5.3 Create booking (DB-enforced no-overlap, error mapping)
- [ ] 5.4 Modify / cancel / approve / reject
- [ ] 5.5 Booking ↔ check-in link, no-show handling, ad-hoc checkout conflict rule
- [ ] 5.6 Booking UI (calendar per machine, my bookings, approvals queue)
- [ ] 5.7 Concurrency & edge-case test suite

### Phase 6 — Service & Maintenance
- [ ] 6.1 Fault reporting (any authenticated user)
- [ ] 6.2 Service ticket lifecycle + condition coupling
- [ ] 6.3 Preventive maintenance schedules & due calculation
- [ ] 6.4 Service history & downtime calculation
- [ ] 6.5 Impact handling: affected bookings when a machine goes down
- [ ] 6.6 Service UI (report fault, ticket board, schedules)

### Phase 7 — Redis Caching & Realtime
- [ ] 7.1 Cache service (cache-aside helper, key naming, TTL, graceful degradation)
- [ ] 7.2 Cache status board, machine detail, lookups + invalidation
- [ ] 7.3 Redis-backed rate limiting
- [ ] 7.4 Pub/sub + SSE stream; live updates in web
- [ ] 7.5 Booking contention helper (short Redis lock; DB remains authority)
- [ ] 7.6 Cache metrics, TTL tuning, failure-mode tests

### Phase 8 — Dashboard & Reports
- [ ] 8.1 KPI queries (availability %, utilization, downtime, overdue service)
- [ ] 8.2 Dashboard UI
- [ ] 8.3 Reports + CSV/PDF export
- [ ] 8.4 Department-scoped views

### Phase 9 — Notifications & Background Jobs
- [ ] 9.1 BullMQ setup & worker process
- [ ] 9.2 Scheduled jobs (booking reminders, no-show expiry, overdue checkout, service-due alerts)
- [ ] 9.3 Email (Resend) + in-app notifications
- [ ] 9.4 Notification preferences

### Phase 10 — Audit & Hardening
- [ ] 10.1 Audit interceptor + audit log UI
- [ ] 10.2 Security hardening (helmet, CORS, rate limits, headers, dependency audit)
- [ ] 10.3 RBAC & data-exposure review (no PHI)
- [ ] 10.4 Backup/restore plan (Neon PITR) documented & tested
- [ ] 10.5 Accessibility & responsive pass

### Phase 11 — QA, Deployment & Handover
- [ ] 11.1 Playwright e2e for critical journeys
- [ ] 11.2 Load/perf test (status board, booking)
- [ ] 11.3 Production deployment (Vercel web, API host, Redis, env, migrations in CI)
- [ ] 11.4 Observability (Sentry, logs, uptime checks)
- [ ] 11.5 Documentation (README, runbook, user guide)
- [ ] 11.6 UAT with hospital staff & handover

**Total tasks: 71**

---

## 9. CURRENT STATUS (update every prompt)

| Item | Value |
|---|---|
| Overall progress | 5 / 71 tasks (7.0%) |
| Current phase | Phase 0 — Task 0.5 complete |
| Last updated | 2026-10-20 16:38 EAT |
| Branch | `phase-0/task-0.5-web-bootstrap` |
| Last commit | `feat(web): bootstrap responsive app shell` |
| Repo state | Responsive web shell, status tokens, TanStack Query, typed API client, browser CORS proof and component tests verified |
| **Next task** | **0.6 CI pipeline** |

---

## 10. PENDING / BACKLOG

### Pending (planned, in the checklist)
Everything in §8 not yet ticked. Do not duplicate it here — only list *extra* items discovered during work.

### Backlog (future ideas — OUT of current scope, do not build without approval)
- QR scan from phone camera (PWA) for instant check-in/out
- IoT/sensor integration for automatic "in use" detection
- Spare-parts and consumables tracking
- Vendor/service-contract management and cost tracking
- Calibration certificates & compliance reporting
- Multi-hospital / multi-tenant support
- Native mobile app

---

## 11. DECISION LOG

| # | Date | Decision | Why | Alternatives considered |
|---|---|---|---|---|
| D1 | 2026-10-20 | Neon is the only application database; Supabase used for Auth + Storage only | Two Postgres instances would split data and double ops burden | Supabase DB only; Neon only with custom JWT auth |
| D2 | 2026-10-20 | Usage state is derived from open usage sessions, not stored | Avoids drift between a flag and reality | Stored `is_in_use` boolean |
| D3 | 2026-10-20 | No-overlap booking via Postgres `EXCLUDE USING gist` | Only reliable guard against race conditions | App-level check; Redis lock alone |
| D4 | 2026-10-20 | API on persistent Node host, web on Vercel | SSE + BullMQ workers need long-lived processes | API on Vercel serverless |
| D5 | 2026-10-20 | Prisma as ORM, with raw SQL migrations where needed | Type-safe, good migration workflow | Drizzle, TypeORM |
| D6 | 2026-10-20 | Pin Node 24.22.0 and pnpm 9.15.9 for the initial workspace | Matches the approved scaffold plan and verified local toolchain | Floating versions; a different Node/pnpm release |
| D7 | 2026-10-20 | Build `@app/shared` as both ESM and CJS with tsup | Next.js can consume ESM while the NestJS CommonJS build can load the same workspace package | Source-only TS paths; ESM-only output |
| D8 | 2026-10-20 | Use one root ESLint 10 flat config, with Next.js rules scoped to the web app and TypeScript rules shared across all workspaces | Keeps policy centralized while preventing frontend-only rules from leaking into API/shared code | Per-workspace configs; legacy eslintrc files |
| D9 | 2026-10-20 | Run ESLint and Prettier through lint-staged at pre-commit, and conventional commitlint at commit-msg | Gives fast staged-file feedback while full repo checks remain available as root commands | Full repo checks on every commit; CI-only enforcement |
| D10 | 2026-10-20 | Require only `WEB_ORIGIN`, `API_BASE_URL` and `NEXT_PUBLIC_API_URL` now; normalize blank future-service settings to absent and validate them when supplied | The foundation can boot without credentials for services introduced in later phases while still rejecting malformed configuration | Require every eventual production variable immediately; leave future values unvalidated |
| D11 | 2026-10-20 | Split web configuration into server and public schemas; guard server values with `server-only` and expose only statically named `NEXT_PUBLIC_API_URL` to client code | Prevents accidental client imports and follows Next.js build-time public-variable rules | One shared web env object; expose additional values with `NEXT_PUBLIC_` prefixes now |
| D12 | 2026-10-20 | Aggregate all Zod environment issues into one application-labelled startup error | Developers can correct every missing or invalid setting in one pass | Fail on the first invalid variable |
| D13 | 2026-10-20 | Keep `GET /health` and `GET /health/ready` unversioned at the root while all application routes use `/api/v1`; keep OpenAPI at `/api/docs` | Infrastructure probes and API documentation must remain stable when the application API version changes | Put health below `/api/v1`; expose duplicate root and versioned health routes |
| D14 | 2026-10-20 | Return HTTP 200 readiness with database and Redis marked `not_configured` until their scheduled tasks add real checks | Task 0.4 needs a usable probe without pretending unimplemented dependencies are healthy or prematurely adding integrations | Omit dependency state; report the API as degraded before dependencies exist |
| D15 | 2026-10-20 | Run Jest through its ESM transform and Node VM-modules mode for the NestJS 12 test suite | NestJS 12 packages are ESM, while the API production compiler remains CommonJS-compatible under the pinned Node runtime | Downgrade NestJS; add a second transpiler; change the production module format in this task |
| D16 | 2026-10-20 | Configure the typed web API client with an origin and expose separate root and versioned request paths; `/health` uses the root while application requests prepend `/api/v1` | Infrastructure probes are intentionally unversioned (D13), and separating URL construction prevents accidental `/api/v1/health` calls while keeping one validated origin for browser/server clients | Store two complete base URLs; special-case health outside the client; duplicate the health endpoint below `/api/v1` |

*(Append new rows; do not rewrite old ones. If a decision is reversed, add a new row referencing the old one.)*

---

## 12. SESSION LOG (append-only — newest at the bottom)

### Entry template (copy for every prompt)
```
### [YYYY-MM-DD HH:mm EAT] — Task(s): <IDs> — <short title>
- **Prompt summary:** what the owner asked
- **What I did:** concrete changes (modules, endpoints, screens, migrations)
- **How:** key technical approach/decisions (link Decision Log #s)
- **Files touched:** key paths
- **Migrations:** names, or "none"
- **Verification:** commands run and results (lint / typecheck / tests / build / manual)
- **Result:** tasks ticked, tasks partial
- **Progress after this session:** X / 71 (Y%)
- **Left undone / follow-ups:** …
- **Next task:** <ID + title>
- **Branch / commit:** …
```

### Log

### [2026-10-20 — EAT] — Task(s): planning — Handoff, architecture and phase guide created
- **Prompt summary:** Owner requested a phase-by-phase build plan, architecture (with Redis), and this handoff file for a hospital machine-tracking and booking system.
- **What I did:** Authored `project_model_handoff.md`, `docs/ARCHITECTURE.md`, `docs/PHASE_GUIDE.md`.
- **How:** Scope derived from owner's brief (machines only; in-use vs available; fine vs needs service; booking).
- **Files touched:** the three documents above (no code yet).
- **Migrations:** none
- **Verification:** n/a (documentation only)
- **Result:** no checklist items ticked
- **Progress after this session:** 0 / 71 (0%)
- **Left undone / follow-ups:** Owner to provide Neon, Supabase and Redis credentials when Phase 0.3 / 1.1 / 2.1 are reached.
- **Next task:** 0.1 Monorepo scaffold
- **Branch / commit:** — / —

*(Add new entries below this line.)*

### [2026-10-20 13:16 EAT] — Task(s): 0.1 — Monorepo scaffold
- **Prompt summary:** Create the pnpm monorepo foundation with Next.js, NestJS and a shared TypeScript package; verify it from a clean state, update this handoff and commit it.
- **What I did:** Created the root workspace and scripts, a minimal Next.js App Router app, a minimal NestJS app, and a dual-format shared package. Both apps import and use `APP_NAME` from `@app/shared`. Moved the architecture and phase guide into `docs/`.
- **How:** Pinned Node/pnpm, used explicit workspace dependencies, built shared code with tsup before each app, and kept linting, tests, Tailwind, Prisma, Redis, auth and later bootstrap work out of scope (D6, D7).
- **Files touched:** root workspace/config/README files; `apps/web`; `apps/api`; `packages/shared`; `docs/ARCHITECTURE.md`; `docs/PHASE_GUIDE.md`; this handoff
- **Migrations:** none
- **Verification:** In a clean staged-tree export: `pnpm install --frozen-lockfile` passed; `pnpm build` passed for shared/web/API; `pnpm typecheck` passed for all three workspaces; `pnpm lint` exited 0 with no lint scripts configured yet; `pnpm test` exited 0 with no test suites configured yet. Direct CJS (API) and ESM (web) imports both returned `Tophill Inventory`; `git diff --check` passed.
- **Result:** Task 0.1 ticked complete.
- **Progress after this session:** 1 / 71 (1.4%)
- **Left undone / follow-ups:** Code-quality tooling and real lint scripts belong to Task 0.2. No test suites exist yet. pnpm emits Node's `DEP0169` warning during install (tracked in Known Issues).
- **Next task:** 0.2 Code quality tooling
- **Branch / commit:** `phase-0/task-0.1-monorepo-scaffold` / `chore: scaffold pnpm monorepo (web, api, shared)`

### [2026-10-20 14:52 EAT] — Task(s): 0.2 — Code quality tooling
- **Prompt summary:** Add strict repository-wide TypeScript and code-quality tooling, prove lint and commit-message hooks reject bad commits, verify all checks, update this handoff and commit the task.
- **What I did:** Enabled `noUncheckedIndexedAccess`; added shared ESLint and Prettier configuration, EditorConfig, Husky, lint-staged and commitlint; replaced the placeholder lint command; added format/fix commands; formatted the existing scaffold.
- **How:** Used a root ESLint 10 flat config with framework-specific scoping and staged-file hooks (D8, D9). The starting audit found the clean repo on `main` at `8ad611a` while §9 still named the completed Task 0.1 branch; this status was corrected here by trusting the repo.
- **Files touched:** root quality-tool configs and hooks; root TypeScript/package/lock/README files; existing TypeScript scaffold files formatted by Prettier; this handoff
- **Migrations:** none
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed; `pnpm format`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed; `pnpm test` exited 0 with no suites configured. Effective configs for web/API/shared all showed `strict: true` and `noUncheckedIndexedAccess: true`. A staged file with unused explicit `any` made the pre-commit hook fail with two ESLint errors and code 1. After removing it, `git commit -m "bad commit message"` passed pre-commit but commitlint rejected it with `subject-empty` and `type-empty`; neither proof created a commit.
- **Result:** Task 0.2 ticked complete.
- **Progress after this session:** 2 / 71 (2.8%)
- **Left undone / follow-ups:** No test suites exist yet. ESLint 10 peer-range warnings from transitive Next.js plugins are tracked in Known Issues; linting itself passes.
- **Next task:** 0.3 Env management & validation
- **Branch / commit:** `phase-0/task-0.2-code-quality` / `chore: add code quality tooling`

### [2026-10-20 15:10 EAT] — Task(s): 0.3 — Environment management and validation
- **Prompt summary:** Add per-app Zod environment validation, complete safe examples, prove fail-fast startup and keep server secrets out of the web client bundle; verify, document and commit only Task 0.3.
- **What I did:** Added typed API and web environment modules, required current local URLs, kept later-service values optional, connected validation to both application startup paths, added complete per-app examples, and documented local environment setup.
- **How:** Aggregated Zod issues into labelled errors (D12), normalized blank optional placeholders to absent (D10), and split web server/public configuration with `server-only` plus a single statically referenced public variable (D11). The starting audit found clean merged `main` at `c5beb97` while §9 still named the completed Task 0.2 branch; this entry corrects that historical status by trusting Git.
- **Files touched:** API/web package manifests, lockfile, API bootstrap and env module, Next config and web env modules, both `.env.example` files, README, this handoff
- **Migrations:** none
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed. Missing API `WEB_ORIGIN` exited 1 with `[api] Invalid environment variables`; missing web `API_BASE_URL` and `NEXT_PUBLIC_API_URL` exited 1 and listed both. An API run with invalid port/origin/database URL listed all three issues. A temporary Client Component importing the server env module made `next build` exit 1 with `'server-only' cannot be imported from a Client Component`; the fixture was removed. A sentinel server value was absent from `.next/static`. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (no suites), and `pnpm build` passed with valid local values. Both production apps booted; web returned 200 and API listened on its configured port. Git checks confirmed `.env` variants are ignored and only examples are intended for tracking. A first typecheck after removing the proof fixture encountered its stale generated `.next` route type; the generated cache was moved aside and the full clean-cache sequence passed.
- **Result:** Task 0.3 ticked complete.
- **Progress after this session:** 3 / 71 (4.2%)
- **Left undone / follow-ups:** No test framework or later-service integrations were added. Existing pnpm and ESLint peer warnings remain. Next.js may print `Ready` immediately before reporting a configuration validation failure, but exits nonzero with the complete error.
- **Next task:** 0.4 API bootstrap
- **Branch / commit:** `phase-0/task-0.3-env-validation` / `chore: add validated environment configuration`

### [2026-10-20 16:10 EAT] — Task(s): 0.4 — API bootstrap
- **Prompt summary:** Build the NestJS API foundation with validated config, Zod validation, standard envelopes/errors, request IDs, pino, Swagger, root health probes, graceful shutdown and unit/e2e coverage; keep every application route versioned.
- **What I did:** Added the global ConfigModule, Zod DTO pipe, exception filter, response interceptor/helper, request-ID middleware, structured HTTP logging, Swagger setup, health module, version-prefix configuration, CORS from validated config, graceful shutdown hooks, and Jest/Supertest unit and e2e infrastructure.
- **How:** Root health probes are explicit prefix exclusions while application controllers remain below `/api/v1` (D13). Readiness exposes future database/Redis checks as `not_configured` (D14). Tests use Jest's ESM mode for NestJS 12 (D15). The e2e validation controller exists only in test code. The starting audit found clean merged `main` at `f1d84a6` while §9 still named the completed Task 0.3 branch; this entry corrects that historical status by trusting Git.
- **Files touched:** API manifest/config/bootstrap/common infrastructure, health module, Swagger/logger configuration, unit/e2e tests, lockfile, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** none
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed. `pnpm --filter @app/api test:unit` passed 4 tests; `pnpm --filter @app/api test:e2e` passed 6 tests; root `pnpm test` passed all 10 tests in 3 suites. E2e coverage proves both root health endpoints, the absence of versioned health, request-ID generation/propagation, standard Zod 400 errors, successful response envelopes and Swagger HTML/JSON. `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm build` passed. A compiled-process smoke test returned 200 from `/health`, `/health/ready` and `/api/docs`, returned the standard 404 envelope from `/api/v1/health`, emitted structured request logs and exited 0 on SIGINT. The first compiled smoke run exposed an invalid transient `PinoLogger` lookup in `main.ts`; switching the startup message to the singleton pino Nest logger resolved it before final verification.
- **Result:** Task 0.4 ticked complete.
- **Progress after this session:** 4 / 71 (5.6%)
- **Left undone / follow-ups:** Database and Redis readiness checks remain intentionally `not_configured` until Tasks 1.1 and 0.7. Auth, Prisma, Redis integration and web bootstrap were not started. Existing pnpm/ESLint warnings remain; Jest emits the tracked VM-modules warning.
- **Next task:** 0.5 Web bootstrap
- **Branch / commit:** `phase-0/task-0.4-api-bootstrap` / `feat(api): bootstrap API foundation`

### [2026-10-20 16:38 EAT] — Task(s): 0.5 — Web bootstrap
- **Prompt summary:** Add the Tailwind/shadcn App Router shell, status theme, TanStack Query, typed API client, global boundaries and tests; prove responsive rendering and a real browser CORS call to root `/health`; do not begin application features.
- **What I did:** Added Tailwind CSS 4 and shadcn/ui primitives; built the responsive topbar/sidebar/mobile drawer; defined all six machine-status tokens with icon, text and colour; added the Query provider, loading/error boundaries, root placeholder and live health card; created browser/server typed API clients with future auth injection and standard error normalization; added Vitest component/client coverage and saved production screenshots in a gitignored artifact folder.
- **How:** Root and versioned URL construction are explicit in one API client (D16). The browser client reads only validated `NEXT_PUBLIC_API_URL`; the unused server client is guarded by `server-only` and reads `API_BASE_URL`. Future navigation is disabled until its scheduled tasks. The starting audit found clean merged `main` at `5a0699d` while §9 still named the completed Task 0.4 branch; this entry corrects that historical status by trusting Git.
- **Files touched:** web manifest/config/styles/App Router boundaries, shell/query/status/UI components, typed API clients and tests; lockfile, README, `.gitignore`, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** none
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed (with the tracked pnpm warning). `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` passed. The first plain `pnpm test` correctly failed because no ignored local environment supplied required API `WEB_ORIGIN`; all 11 web tests passed in that run. With the documented localhost variables supplied, root `pnpm test` passed 21 tests across 6 suites/files (11 web, 10 API), and `pnpm build` passed for shared/web/API. An in-app browser connection was unavailable, so the approved Playwright fallback ran against live production web and API processes: at 360, 768 and 1280px, `/health` returned 200, the page rendered `Connected`, console warnings/errors were empty and horizontal overflow was false. The 360px drawer opened/closed; layouts used 1/2/3 status columns and hidden/80px/256px navigation respectively. A direct Origin request returned `Access-Control-Allow-Origin: http://127.0.0.1:3000`. Clean production screenshots are saved under ignored `apps/web/.artifacts/task-0.5/`.
- **Result:** Task 0.5 ticked complete.
- **Progress after this session:** 5 / 71 (7.0%)
- **Left undone / follow-ups:** Authentication, protected routes, real application pages/data, Prisma, Redis and machine features remain in their scheduled tasks. No new known issue was introduced; existing pnpm/ESLint/Jest warnings remain.
- **Next task:** 0.6 CI pipeline
- **Branch / commit:** `phase-0/task-0.5-web-bootstrap` / `feat(web): bootstrap responsive app shell`

---

## 13. KNOWN ISSUES / TECH DEBT

- `pnpm install` under Node 24.22.0 emits a non-fatal `DEP0169` warning from pnpm 9.15.9's use of the legacy `url.parse()` API. Installation and all verification commands still pass; reassess the pnpm pin in a dedicated tooling task rather than changing the approved Task 0.1 baseline.
- pnpm reports peer-range warnings because transitive `eslint-plugin-import`, `eslint-plugin-react`, and `eslint-plugin-jsx-a11y` metadata does not yet list ESLint 10. Next.js 16.4.2 officially supports ESLint 10, and the repo lint passes; monitor upstream metadata updates.
- Next.js 16.4.2 development startup can print `Ready` immediately before `next.config.ts` environment validation reports an error. The process still exits with code 1 and lists all invalid variables; this is an output-order quirk, not a bypass of validation.
- Jest 30 runs the NestJS 12 ESM packages with Node's `--experimental-vm-modules`, so Node 24 prints a non-fatal experimental-feature warning during tests. All unit/e2e tests pass; reassess when Jest's ESM runtime no longer requires the flag.
- The Task 0.4 test dependency tree currently reports deprecated transitive `glob@10.5.0`. It is not a direct dependency and does not affect the passing test suite; monitor upstream Jest tooling releases.

---

## 14. ENVIRONMENT & SETUP

*(Keep current. Never put real secrets here — names and purpose only.)*

| Variable | Used by | Required now | Purpose |
|---|---|---|---|
| `PORT` | api | No (defaults to `3001`) | API listening port |
| `WEB_ORIGIN` | api | Yes | Web origin; used for the CORS allow-list in Task 0.4 |
| `DATABASE_URL` | api | No (Phase 1.1) | Neon **pooled** connection string (runtime) |
| `DIRECT_URL` | api / prisma | No (Phase 1.1) | Neon **direct** connection string (migrations) |
| `REDIS_URL` | api | No (Phase 0.7) | Redis connection (`rediss://` in prod) |
| `SUPABASE_URL` | api, web server | No (Phase 2) | Supabase project URL |
| `SUPABASE_ANON_KEY` | web server | No (Phase 2) | Future Supabase client key; not exposed to client code in Task 0.3 |
| `SUPABASE_SERVICE_ROLE_KEY` | api only | No (Phase 2) | Server-side admin/storage key — never expose to web |
| `SUPABASE_JWT_ISSUER` | api | No (Phase 2) | JWT issuer used during token verification |
| `SUPABASE_JWKS_URL` | api | No (Phase 2) | JWKS endpoint used during token verification |
| `API_BASE_URL` | web server | Yes | Server-side API location |
| `NEXT_PUBLIC_API_URL` | web public | Yes | Browser-visible API location; the only public web environment variable |
| `RESEND_API_KEY` | api | No (Phase 9) | Email provider key |
| `SENTRY_DSN` | api, web server | No (Phase 11) | Error tracking destination |

**Commands:**
- Install: `pnpm install`
- Create local API environment: `cp apps/api/.env.example apps/api/.env`
- Create local web environment: `cp apps/web/.env.example apps/web/.env.local`
- Run all workspaces in development: `pnpm dev`
- Build shared, web and API: `pnpm build`
- Lint workspaces: `pnpm lint`
- Fix auto-fixable lint issues: `pnpm lint:fix`
- Format supported files: `pnpm format`
- Check formatting: `pnpm format:check`
- Typecheck workspaces: `pnpm typecheck`
- Test workspaces: `pnpm test`
- Run API unit tests: `pnpm --filter @app/api test:unit`
- Run API e2e tests: `pnpm --filter @app/api test:e2e`
- Run web unit/component tests: `pnpm --filter @app/web test`

**API operational endpoints:**
- Liveness: `GET /health`
- Readiness: `GET /health/ready`
- OpenAPI UI: `GET /api/docs`
- OpenAPI JSON: `GET /api/docs-json`
- Application API prefix: `/api/v1`

**Neon branches:** `main` (production), `staging`, `dev`; CI uses ephemeral branches.

**Services running locally:** none yet. Local Redis is added in Task 0.7.

---

## 15. DEFINITION OF DONE (per task)

A task may be ticked `[x]` only if **all** are true:
- [ ] Acceptance criteria in `docs/PHASE_GUIDE.md` for that task are met
- [ ] Business rules enforced in the API (and DB where specified), mirrored in the UI
- [ ] Input validated with shared Zod schemas; errors return the standard error shape
- [ ] Permissions applied and tested (allowed role passes, disallowed role gets 403)
- [ ] Unit + integration/e2e tests added and passing
- [ ] Lint, typecheck and build pass
- [ ] Migrations (if any) are additive/safe and applied cleanly on a fresh database
- [ ] Docs updated (this file, and `docs/ARCHITECTURE.md` if design changed)
- [ ] Committed on the task branch with a conventional commit message
