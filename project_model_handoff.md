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
- [x] 0.6 CI pipeline (GitHub Actions: lint, typecheck, test, build)
- [x] 0.7 Local dev services (docker-compose Redis) + Redis module skeleton & health check

### Phase 1 — Database & Schema
- [x] 1.1 Prisma + Neon setup (pooled runtime URL, direct migration URL, branch strategy)
- [x] 1.2 Core tables: users, departments, locations
- [x] 1.3 Machine tables: categories, machines, machine_status_history
- [x] 1.4 Usage & booking tables incl. `EXCLUDE` constraint (raw SQL migration)
- [x] 1.5 Service tables: service_tickets, service_records, maintenance_schedules
- [x] 1.6 Support tables: audit_logs, notifications, attachments, app_settings
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
| Overall progress | 13 / 71 tasks (18.3%) |
| Current phase | Phase 1 — Task 1.6 verified |
| Last updated | 2026-10-21 15:46 EAT |
| Branch | `main` (Task 1.6 delivered via `phase-1/task-1.6-support-tables`) |
| Last commit | `feat(db): add support tables and safeguards` |
| Repo state | Task 1.6 merged by PR #14; support schema, reviewed migration, Neon `dev`, zero-drift, disposable-branch integration and hosted CI verified |
| **Next task** | **1.7 Indexes, seed script and migration review** |

---

## 10. PENDING / BACKLOG

### Pending (planned, in the checklist)
Everything in §8 not yet ticked. Do not duplicate it here — only list *extra* items discovered during work.

- Add a service-ticket comments table in Task 6.2 so lifecycle discussion is introduced with the service API rather than prematurely in the Phase 1 schema.
- Add a booking `needs_attention` marker/reason migration in Task 6.5 when service outages are coupled to affected bookings.
- Enforce append-only `machine_status_history` and `audit_logs` privileges for a dedicated least-privilege application role in Task 10.1; the current owner role must retain migration privileges and can disable the audit trigger.
- In Tasks 3.5 and 6.6, validate each polymorphic attachment target in the same transaction before insert, and coordinate row/object deletion while writing the audit event.

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
| D17 | 2026-10-20 | Make `pnpm test` self-contained: Jest and Vitest override required variables with fixed localhost test values, and the root test command builds `@app/shared` before running suites | Fresh clones and CI must not depend on developer `.env` files or ignored build output; only the CI build step needs explicit validation URLs | Set job-wide CI environment values; load `.env.example` in tests; map `@app/shared` directly to source; rely on an existing `dist` directory |
| D18 | 2026-10-20 | The engineering agent owns the routine Git lifecycle: sync `main`, create task branches, make conventional commits, push, open and update pull requests, monitor required checks, merge with a merge commit when green, and resync local `main` | Keeps implementation and its verification/merge lifecycle together while preserving reviewable branches and CI evidence | Continue requiring manual owner pushes/merges; push task changes directly to `main` |
| D19 | 2026-10-20 | Redis uses a local `redis://127.0.0.1:6379` development default, while production requires an explicit `rediss://` URL and enables TLS; connection starts in the background with the offline queue disabled, 1-second operation bounds and reconnect delay capped at 2 seconds | Local setup stays zero-secret and convenient, production transport cannot silently downgrade, and Redis can neither block API boot nor hang readiness | Require Redis in every environment; allow plaintext production Redis; await connection during API startup |
| D20 | 2026-10-20 | Redis tests remain service-independent: connected behavior uses an in-memory stand-in, while unavailable behavior uses an owned real ioredis client pointed at an unreachable local port with retries disabled | `pnpm test` and CI remain deterministic without Docker while still exercising ioredis failure behavior and ensuring network handles are closed | Add a Redis CI service container; rely on a developer's Docker service; mock both success and failure paths |
| D21 | 2026-10-21 | Pin stable Prisma 7.10.1; generate the `prisma-client` output as CommonJS in the API source tree and use `@prisma/adapter-pg`; `prisma7.config.ts` reads `DIRECT_URL` while runtime reads pooled `DATABASE_URL` | Current official Prisma 7 documentation requires a driver adapter and explicit output, supports CommonJS for this Nest build, and Prisma 8 was still a release candidate; separating CLI/runtime URLs preserves the required Neon connection roles | Install the Prisma 8 release candidate; use deprecated `prisma-client-js`; use the pooled URL for migrations; convert the API to ESM |
| D22 | 2026-10-21 | Database connection starts in the background and health queries are bounded to one second; database failure makes readiness HTTP 503/`down`, while Redis-only failure remains HTTP 200/`degraded` | Neon is the system of record, but an outage must not prevent liveness or make readiness hang; Redis remains optional infrastructure | Block API boot on Postgres; report database failure as degraded; leave readiness HTTP status always 200 |
| D23 | 2026-10-21 | Keep default Jest/Vitest/CI checks database-free with safe localhost URLs and mocked Prisma health; generate Prisma Client automatically before root build, typecheck and test | Fresh clones remain deterministic without developer credentials or external services, while live migrations and database readiness are verified through an explicit Neon path | Run every test against Neon; commit generated Prisma Client; require manual generation after checkout |
| D24 | 2026-10-21 | Core model IDs are PostgreSQL-generated UUIDs using `gen_random_uuid()`; every timestamp uses `timestamptz(3)`, and Prisma `@updatedAt` owns automatic application-write timestamps | Database-generated IDs work consistently for Prisma and direct SQL writers, while one explicit UTC precision avoids timestamp drift | Prisma-generated UUIDs; UUID v7; database update triggers for all timestamps |
| D25 | 2026-10-21 | Normalize user email to lowercase in a database trigger and enforce uniqueness with an index on `lower(email)`; membership/location foreign keys restrict department deletion and manager deletion sets the manager reference to null | The database guarantees case-insensitive identity and predictable non-cascading deletion regardless of write path | Application-only normalization; `citext`; cascading deletes; nullable membership on department deletion |
| D26 | 2026-10-21 | Real core-model tests run only through `pnpm test:integration` against a dedicated `ci/`, `test/`, or `ephemeral/` Neon branch; the guard rejects long-lived/equal URLs and tests delete only their own generated records | Default CI remains hermetic and the explicit suite cannot accidentally target `main`, `staging`, `dev`, or the configured application/migration database | Put Neon in the default Jest suite; rely on naming convention without a guard; run against long-lived `dev` |
| D27 | 2026-10-21 | Require both machine manufacturer and serial number, trim and lowercase them in a database trigger, and keep their case-insensitive pair unique across all rows including soft-deleted machines | A physical serial identity must be unambiguous and must preserve historical continuity; required values avoid PostgreSQL's distinct-null uniqueness behavior | Allow nullable identity with `NULLS NOT DISTINCT`; use a partial unique index so deleted serials can be re-registered; normalize only in application code |
| D28 | 2026-10-21 | Generate `HM-000001`-style asset tags from a PostgreSQL sequence/function and reserve each tag permanently | Database generation is race-safe for every writer and preserves immutable hospital identifiers after retirement or soft deletion | Generate in Task 3.3 application code; reuse tags after deletion; UUID-only labels |
| D29 | 2026-10-21 | Keep machine ownership and current location as independent `RESTRICT` foreign keys, allowing a machine to sit in another department's location | Shared hospital equipment can be owned centrally while deployed elsewhere | Composite foreign key forcing location department to equal owner; omit ownership |
| D30 | 2026-10-21 | Create status-history `ticket_id` as a nullable UUID without an FK until Task 1.5, and defer role-level UPDATE/DELETE revocation to Task 10.1 while exposing history as insert-only in application code | The referenced ticket table and a least-privilege application database role do not exist yet; placeholder tables or revoking the migration owner's privileges would be premature | Create a placeholder ticket table; omit the column; revoke the owner role now |
| D31 | 2026-10-21 | Use `pg_trgm` GIN indexes for machine name, asset tag and serial search, represented with Prisma raw operator classes as well as reviewed migration SQL | Substring `ILIKE` lookup needs indexed search, and declaring the raw operator classes prevents false Prisma drift reports | B-tree indexes; full-text vectors; raw SQL indexes omitted from the Prisma schema |
| D32 | 2026-10-21 | Store each booking's `blocked_until` as an API-computed snapshot of `ends_at` plus the machine's effective buffer; store `ends_at` itself when no buffer applies, and constrain overlap over `tstzrange(starts_at, blocked_until, '[)')` | Existing bookings must not change when machine policy changes. PostgreSQL marks `timestamptz + interval` as `STABLE`, while generated-column expressions must be immutable; the live catalog and a rejected generated-column probe confirmed a generated calculation is invalid | Compute the buffer inside the exclusion expression; use a generated column; constrain only through `ends_at` |
| D33 | 2026-10-21 | Treat bookings and usage sessions as non-deletable records of fact with `ON DELETE RESTRICT` relations; enforce one open session and one session per booking with named partial unique indexes, and enforce active-booking overlap with the named raw-SQL exclusion constraint | Historical records cannot disappear through parent deletion, and stable database names let later APIs map `23505`/`23P01` violations deterministically under concurrency | Cascading/set-null deletion; application-only checks; unnamed database constraints |
| D34 | 2026-10-21 | Keep unsupported partial unique and exclusion semantics in reviewed migration SQL while Prisma models expose the closest safe relation shape (`Booking.usageSessions` remains a list) | Prisma cannot express these partial/exclusion constraints in its schema, but PostgreSQL remains authoritative and the live drift/integration checks prove the actual contract | Pretend the partial unique is a normal `@unique`; omit the database constraint; add application APIs early |
| D35 | 2026-10-21 | Treat tickets, service records and maintenance schedules as records of fact with `ON DELETE RESTRICT`; allow several service records per ticket and store nullable costs as PostgreSQL/Prisma `Int` minor units with default `KES` | History must survive parent deactivation/deletion attempts, repeat visits and parts need separate ordered records, and the 2,147,483,647-minor-unit ceiling (about KSh 21.47 million) is sufficient for one service record | Cascading/set-null relations; one record per ticket; decimal major-unit money; bigint minor units |
| D36 | 2026-10-21 | Enforce ticket timestamp/assignment consistency and bounded text in named database checks; cap description at 4,000 characters, but deliberately do not enforce one open fault ticket per machine | Database writers cannot create internally inconsistent or unbounded rows, while fault, preventive, calibration and inspection work may legitimately coexist; Task 6.1 will handle duplicate-report UX | API-only consistency; unbounded descriptions; a partial unique open-fault index |
| D37 | 2026-10-21 | Retain inactive maintenance schedules but allow only one active schedule per machine through `maintenance_schedules_one_active_per_machine`; index active `next_due_at` separately | Schedule history remains available while Task 9.2's due-service sweep gets a selective, deterministic query path | One schedule row per machine; delete/overwrite old schedules; application-only active uniqueness |
| D38 | 2026-10-21 | Keep audit actions and notification/preference types as checked lowercase text, with the evolving allowed identifiers and Zod enums in `@app/shared`; use a PostgreSQL enum only for the closed `MACHINE | TICKET` attachment target set | Phase 5–10 event identifiers will grow, so application-owned lists remain easy to extend without repeated enum migrations while the database still rejects malformed identifiers | PostgreSQL enums for every type; unconstrained text; duplicate API/web lists |
| D39 | 2026-10-21 | Store nullable audit actors, text entity IDs, native `inet` client addresses and bounded JSON-object snapshots; make audit rows immediately append-only through a SQLSTATE `55000` UPDATE/DELETE trigger, while deferring least-privilege role grants to Task 10.1 | System jobs have no user, settings use string keys, native IP validation is useful, and the trigger cheaply prevents application bugs now without revoking migration-owner capabilities | Require an actor; UUID-only entities; plain text IPs; documentation-only immutability; revoke owner privileges now |
| D40 | 2026-10-21 | Use `(user_id, type)` as the notification-preference primary key with both channels enabled by default; keep critical-alert overrides in the Task 9.4 dispatcher | The natural key directly prevents duplicate preferences, defaults are safe and unsurprising, and criticality is evolving business policy rather than row-shape integrity | Surrogate preference ID plus unique index; database check preventing both channels from being disabled |
| D41 | 2026-10-21 | Keep attachments polymorphic with no `entity_id` FK, a permanent unique storage path, a migration-owned 10 MiB/MIME allow-list, and hard row/object deletion audited separately | PostgreSQL cannot make one FK reference two tables; UUID target IDs plus service validation preserve correctness, and attachment history belongs in the immutable audit log rather than a new soft-delete field | Separate machine/ticket attachment tables; invalid cross-table FK; soft-delete metadata; application-only upload limits |
| D42 | 2026-10-21 | Seed app settings as plain JSON numbers with stable namespaced keys and `ON CONFLICT DO NOTHING`: 240-minute maximum booking, 15-minute lead, 15-minute no-show grace and 30-minute ad-hoc guard | Conservative defaults make the later booking policy usable, preserve administrator customization on repeat deployment, and leave value-shape/business validation to Task 5.1 | Seed script upsert; overwrite on deploy; typed settings columns; JSON objects for scalar values |

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

### [2026-10-20 16:48 EAT] — Task(s): 0.6 — CI pipeline implementation
- **Prompt summary:** Add GitHub Actions quality gates, Dependabot, a pull-request template and branch-protection guidance; make tests clean-clone safe without `.env`; validate the workflow locally and prove lint failures stop CI without starting Task 0.7.
- **What I did:** Added the `Quality` workflow for pull requests and `main`, pinned Node/pnpm with pnpm caching and frozen installs, added weekly npm/Actions Dependabot updates, added the repository PR checklist and branch-protection instructions, and made the Jest/Vitest test environments deterministic. Updated the root test command to build the shared package before running suites.
- **How:** Test-owned safe localhost values and shared-package prebuilds make `pnpm test` independent of developer files and ignored output (D17). CI exposes localhost URLs only to the build step. The starting audit found clean merged `main` at `0b25176` while §9 still named the completed Task 0.5 branch; this entry corrects that historical status by trusting Git.
- **Files touched:** `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md`, Jest/Vitest setup, root package scripts, README, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** none
- **Verification:** `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, plain `pnpm test` with `WEB_ORIGIN`, `API_BASE_URL` and `NEXT_PUBLIC_API_URL` explicitly unset, and build with safe localhost URLs all passed; 21 tests passed (11 web, 10 API). `actionlint` v1.7.12 (official release checksum verified) reported zero errors for the workflow. A temporary unused explicit `any` made the same `pnpm lint` command used by CI exit 1 with two ESLint errors; the fixture was removed. In the first staged-tree export, tests exposed reliance on ignored `@app/shared` build output; after adding the shared prebuild, a second clean export containing no `.env` files installed with `--frozen-lockfile` and passed all tests. GitHub Actions itself cannot be run locally.
- **Result:** Task 0.6 marked partial: implementation and local acceptance evidence are complete, but the phase guide requires a real pull-request run to be green before the task can be ticked complete.
- **Progress after this session:** 5 / 71 (7.0%)
- **Left undone / follow-ups:** Push this branch, open a pull request into `main`, and confirm the single `Quality` job completes all six operational steps: install, format, lint, typecheck, test and build. Then require that check in branch protection and mark 0.6 complete. Task 0.7 was not started.
- **Next task:** 0.6 verification — first GitHub-hosted `Quality` run
- **Branch / commit:** `phase-0/task-0.6-ci-pipeline` / `ci: add repository quality workflow`

### [2026-10-20 19:43 EAT] — Task(s): 0.6 — Hosted CI verification and version-control handoff
- **Prompt summary:** Confirm the reported green pull-request checks, complete Task 0.6, and transfer routine version-control operations from the owner to the engineering agent.
- **What I did:** Independently verified PR #1 and its hosted check, synced the locally stale `main` to the remote merge, marked Task 0.6 complete, and documented the ongoing Git/PR ownership policy.
- **How:** GitHub reports PR #1 (`phase-0/task-0.6-ci-pipeline` into `main`) as merged at `8b3c907`, with `CI / Quality` concluded `SUCCESS`. Going forward the agent will use task branches, conventional commits, pull requests and green required checks before merge (D18). Force-pushes, history rewrites, destructive branch deletion and other exceptional operations still require explicit owner approval.
- **Files touched:** this handoff only
- **Migrations:** none
- **Verification:** `gh pr view 1 --json state,baseRefName,headRefName,url,statusCheckRollup` reported `MERGED` and `CI / Quality: SUCCESS`; `git fetch origin` showed `origin/main` at merge commit `8b3c907`; `git merge --ff-only origin/main` synchronized local `main`. The hosted workflow is the required real-environment proof and covered frozen installation, format check, lint, typecheck, test and build. `gh api repos/nevilndubi/tophill_inventory/branches/main/protection` returned `HTTP 404`, confirming protection is not configured. No application code changed in this follow-up.
- **Result:** Task 0.6 ticked complete after its GitHub-hosted acceptance criterion passed.
- **Progress after this session:** 6 / 71 (8.5%)
- **Left undone / follow-ups:** GitHub branch protection for `main` is not configured and remains an explicit repository-administration follow-up. Task 0.7 was not started.
- **Next task:** 0.7 Local dev services and Redis skeleton
- **Branch / commit:** `phase-0/task-0.6-ci-verification` / `docs: complete Task 0.6 CI verification`

### [2026-10-20 20:02 EAT] — Task(s): 0.7 — Local Redis and resilient API connection
- **Prompt summary:** Add Docker Compose Redis, a TLS-capable ioredis NestJS module, bounded non-blocking connection behavior, degraded readiness, hermetic tests and full live start/stop proof without adding caching or later features.
- **What I did:** Added the local Redis service, ioredis provider/module/service, environment validation and production TLS rule, lifecycle logging, graceful close, Redis-aware readiness, API unit/e2e/env tests, setup documentation and architecture details.
- **How:** Redis startup is lazy and never awaited; the offline queue is disabled, connection/command/readiness operations are bounded to 1 second, and exponential reconnect delay caps at 2 seconds (D19). Readiness returns HTTP 200 with `status: degraded` and `checks.redis: down` when unavailable. Hermetic tests use an in-memory connected stand-in plus an explicitly closed ioredis client on unreachable port 63999 (D20). The starting audit found clean synchronized `main` at `26c9798`; §9 correctly identified Task 0.7 as next.
- **Files touched:** root `docker-compose.yml`, README, API manifest/lockfile/env example and schema, `apps/api/src/redis/*`, health module/service/controller and tests, e2e/test setup, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** none
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed with the tracked pnpm warning. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the build with safe localhost URLs passed; 32 tests passed (21 API, 11 web). Unit tests prove timeout, connected/unavailable behavior and shutdown; e2e proves HTTP 200 `ok/up` and prompt `degraded/down` envelopes without Docker. `docker compose config --quiet` passed and the Redis container became healthy. The compiled API logged Redis `connected`/`ready`; `/health/ready` returned `ok/up` in 29 ms. After Redis exited, it returned `degraded/down` in 2.6 ms and `/health` remained `ok` in 1.7 ms. Redis restart recovered automatically, and API SIGINT logged a graceful Redis close. A cold API boot with Redis absent reached listening state without waiting and returned degraded readiness in 16 ms. Production startup without `REDIS_URL` exited 1 with the required `rediss://` validation error. Docker resources were removed after verification.
- **Result:** Task 0.7 ticked complete; all Phase 0 tasks are now complete.
- **Progress after this session:** 7 / 71 (9.9%)
- **Left undone / follow-ups:** No caching, pub/sub, BullMQ, rate limiting, Prisma or authentication was added. On this workstation, Docker rejected direct `docker compose stop`/`docker stop` signals with `permission denied`; `redis-cli shutdown nosave` stopped the service cleanly and `docker compose down` then removed all resources. Existing tooling warnings and missing `main` branch protection remain tracked.
- **Next task:** 1.1 Prisma + Neon setup
- **Branch / commit:** `phase-0/task-0.7-local-redis` / `feat(api): add resilient Redis foundation`

### [2026-10-21 13:13 EAT] — Task(s): 1.1 — Prisma and Neon foundation
- **Prompt summary:** Add the supported current Prisma/Neon setup, global Nest lifecycle integration, an empty migration, bounded database readiness, hermetic tests, branch documentation, live Neon proof and the complete Git/PR lifecycle without starting the domain schema.
- **What I did:** Added Prisma 7.10.1 configuration/schema/empty migration/no-op seed, a global `PrismaModule` and `PrismaService`, required pooled/direct database environment variables, automatic client generation, database-aware readiness and unit/e2e coverage. Renamed the Neon default branch to `main`, created `dev` and `staging`, and documented long-lived plus ephemeral CI branch use.
- **How:** Prisma Client uses `@prisma/adapter-pg` and pooled `DATABASE_URL`; Prisma CLI uses direct `DIRECT_URL` (D21). Connection startup is non-blocking, the query/pool bounds are one second, and database failure returns HTTP 503 `down` without affecting liveness (D22). Tests override Prisma and use localhost placeholders; generation runs before build/typecheck/test (D23). The starting audit found clean synchronized `main` at `ccb3e7d`, matching §9 with Task 1.1 next.
- **Files touched:** root Prisma config/schema/migration/seed, root scripts/config/lockfile, API Prisma module/service/tests, health controller/service/tests, environment examples/schema/test setup, CI build environment, README, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021131500_initial` (empty foundation migration), applied successfully to the Neon `dev` branch; Prisma migration status reported up to date
- **Verification:** Official Prisma 7 and Neon guidance was checked before installation. `pnpm install` and `pnpm install --frozen-lockfile` passed. `pnpm prisma:generate` generated Prisma Client 7.10.1; removing the ignored generated directory and running `pnpm typecheck` recreated it automatically and passed. The full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, plain `pnpm test`, and localhost-env `pnpm build` sequence passed; 40 tests passed (29 API, 11 web). `pnpm db:seed` ran the intentional no-op seed. Against live Neon `dev` plus Docker Redis, compiled `/health/ready` returned HTTP 200 in 0.981s with database/Redis `up`; with an unreachable database it returned HTTP 503 in 0.013s with database `down`, while `/health` stayed 200. Git ignore/tracking and credential scans found no real connection values; `git diff --check` passed. Local `actionlint` was unavailable; the hosted workflow result remains the final workflow proof.
- **Result:** Task 1.1 ticked complete after the migration, live readiness, resilience and repository checks passed.
- **Progress after this session:** 8 / 71 (11.3%)
- **Left undone / follow-ups:** Task 1.2 owns the first domain tables and enums. No domain models, real seed records, auth, repositories or application features were added. Existing tooling warnings, Docker direct-stop behavior and missing `main` branch protection remain tracked.
- **Next task:** 1.2 Core tables: users, departments, locations
- **Branch / commit:** `phase-1/task-1.1-prisma-neon` / `feat(api): add Prisma and Neon foundation`

### [2026-10-21 13:37 EAT] — Task(s): 1.2 — Core users, departments and locations
- **Prompt summary:** Add the first domain schema and reviewed migration, prove its constraints and relations against Neon `dev` and a fresh disposable branch, preserve hermetic defaults, and complete the Git/PR lifecycle without starting machine tables.
- **What I did:** Added the `Role` enum and mapped `User`, `Department`, and `Location` Prisma models; added the first domain migration, lowercase-email trigger/index, explicit integration command/configuration, safety guard and live constraint/relation tests. Updated architecture, setup examples and commands.
- **How:** IDs are database-generated UUIDs and all timestamps use `timestamptz(3)` with Prisma-managed `updated_at` (D24). Database email normalization plus a functional unique index makes email identity case-insensitive; named relations use `RESTRICT` for membership/locations and `SET NULL` for managers (D25). Live tests require a disposable Neon target distinct from all long-lived URLs and clean up their run-scoped rows (D26). The starting audit found clean synchronized `main` at `b6b30fa`, matching §9 with Task 1.2 next.
- **Files touched:** `prisma/schema.prisma`, `prisma/migrations/20261021140000_core_tables/migration.sql`, root/API package scripts, API integration Jest config/guard/tests, API env example, README, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021140000_core_tables`; reviewed with no destructive SQL, three `gen_random_uuid()` defaults, seven `TIMESTAMPTZ(3)` fields, explicit `RESTRICT`/`SET NULL` actions, and applied after `20261021131500_initial`
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed with the tracked pnpm warning. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, hermetic `pnpm test`, and the safe-localhost `pnpm build` passed; the default suite ran 48 tests (37 API, 11 web) without Neon. On a fresh six-hour Neon branch created from `main`, `prisma migrate deploy` applied `initial` then `core_tables`, migration status was current, and `pnpm test:integration` passed all five live tests covering reads, `updated_at`, every unique constraint, lowercase/case-insensitive email, named relations and required delete behavior. Post-test counts were zero and the branch was deleted. The reviewed domain migration then applied to `dev`, whose migration table reports both migrations complete. A negative integration invocation exited 1 before connecting because its URL equalled `DATABASE_URL`. The first disposable attempt exposed migration-directory ordering and the default five-second Jest timeout; that branch was deleted, the timestamp/explicit timeout were corrected, and the full fresh proof was rerun successfully.
- **Result:** Task 1.2 ticked complete.
- **Progress after this session:** 9 / 71 (12.7%)
- **Left undone / follow-ups:** Machine/category/history tables remain exclusively in Task 1.3. No auth, provisioning, CRUD endpoints or seed data was added. Existing tooling/Docker/branch-protection issues remain; the integration-only PostgreSQL SSL warning is now tracked.
- **Next task:** 1.3 Machine tables
- **Branch / commit:** `phase-1/task-1.2-core-tables` / `feat(db): add core user department and location tables`

### [2026-10-21 14:07 EAT] — Task(s): 1.3 — Machine registry tables
- **Prompt summary:** Add the documented category, machine and status-history schema; enforce identity, lifecycle, booking/service and deletion invariants; prove the migration, search indexes and concurrency against Neon `dev` and a fresh disposable branch; preserve hermetic defaults and complete the Git/PR lifecycle.
- **What I did:** Added both machine enums and the mapped `MachineCategory`, `Machine` and `MachineStatusHistory` Prisma models; created the additive machine migration with sequence-backed asset tags, identity normalization, CHECK constraints, explicit non-cascading relations, status-history index, `pg_trgm` extension and three GIN indexes; extended the guarded live integration suite and documented the resulting data rules.
- **How:** Manufacturer and serial are required, database-normalized and permanently unique as a pair (D27); database sequence tags are immutable and race-safe (D28); department ownership and cross-department placement stay independent (D29); ticket linkage and database-role append-only enforcement are staged for their owning tasks (D30); Prisma raw operator-class declarations keep the reviewed trigram SQL drift-free (D31). Usage remains derived with no `is_in_use` column (D2). The starting audit found clean synchronized `main` at merge `832929c`, matching §9 with Task 1.3 next.
- **Files touched:** `prisma/schema.prisma`, `prisma/migrations/20261021150000_machine_tables/migration.sql`, `apps/api/test/integration/machine-models.integration-spec.ts`, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021150000_machine_tables`; reviewed with no destructive SQL or `is_in_use`, three database UUID defaults, eight `TIMESTAMPTZ(3)` columns, five `ON DELETE RESTRICT` foreign keys, zero ticket foreign keys, required CHECK constraints, sequence/function/trigger identity handling, and three trigram GIN indexes
- **Verification:** `pnpm install` and `pnpm install --frozen-lockfile` passed with the tracked pnpm warning. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, hermetic `pnpm test`, and safe-localhost `pnpm build` passed; the default suite ran 48 tests (37 API, 11 web) without Neon. On a fresh six-hour Neon branch from `main`, `prisma migrate deploy` applied all three migrations in order and `prisma migrate diff` printed `No difference detected.` The guarded `pnpm test:integration` passed 13/13 tests covering every model/enum, all required constraints and relations, null/normalization/soft-delete uniqueness rules, 40 parallel tag inserts, three GIN indexes over 3,000 rows, and cleanup; post-test task rows were zero and the branch was deleted. A separate `EXPLAIN (ANALYZE, BUFFERS)` over 3,000 transaction-scoped rows, with sequential scans disabled to demonstrate index eligibility at this small fixture size, used `Bitmap Index Scan on machines_name_trgm_idx` and rolled back. The migration applied to Neon `dev`; status was current and its drift check also printed `No difference detected.` Initial integration attempts correctly revealed SQLSTATE `23001` for `RESTRICT` and the small-table planner's sequential-scan preference; only test expectations/EXPLAIN setup changed, then the final fresh proof passed.
- **Result:** Task 1.3 ticked complete.
- **Progress after this session:** 10 / 71 (14.1%)
- **Left undone / follow-ups:** Task 1.4 owns usage sessions/bookings and the exclusion constraint. Task 1.5 must add the status-history ticket FK. Task 10.1 must create/use a least-privilege application database role and revoke status-history UPDATE/DELETE. No APIs, seed data, auth, usage, bookings or service tables were added. Existing tooling/Docker/branch-protection/SSL warnings remain tracked.
- **Next task:** 1.4 Usage & booking tables with overlap constraint
- **Branch / commit:** `phase-1/task-1.3-machine-tables` / `feat(db): add machine registry tables`

### [2026-10-21 14:10 EAT] — Task(s): 1.3 — Hosted verification and delivery
- **Prompt summary:** Complete the Task 1.3 Git lifecycle after implementation and live-database verification.
- **What I did:** Pushed the task branch, opened PR #8, monitored the hosted quality workflow, merged with a merge commit only after it passed, and synchronized local `main`; then corrected §9 to the delivered branch state.
- **How:** Followed the repository Git ownership policy in D18; application/schema scope did not change.
- **Files touched:** this handoff only in the follow-up; Task 1.3 implementation files were delivered by PR #8
- **Migrations:** none in this follow-up; `20261021150000_machine_tables` was already verified and delivered
- **Verification:** GitHub `CI / Quality` completed successfully in 1m00s for PR #8; the PR merged as `5447612`; `git pull --ff-only origin main` synchronized local `main` and the worktree was clean.
- **Result:** Task 1.3 remains complete and is now delivered on `main`.
- **Progress after this session:** 10 / 71 (14.1%)
- **Left undone / follow-ups:** No change from the Task 1.3 implementation entry.
- **Next task:** 1.4 Usage & booking tables with overlap constraint
- **Branch / commit:** `phase-1/task-1.3-handoff-finalize` / `docs: finalize Task 1.3 delivery`

### [2026-10-21 14:49 EAT] — Task(s): 1.4 — Usage and booking tables
- **Prompt summary:** Add usage-session and booking models with database-enforced time, buffer, uniqueness, overlap, concurrency and deletion invariants; prove the additive migration on Neon `dev` and a fresh disposable branch while keeping normal tests hermetic; complete the Git/PR lifecycle without adding APIs or later tables.
- **What I did:** Added `BookingStatus`, `Booking` and `UsageSession` Prisma models and relations; created the additive migration with `btree_gist`, named CHECK constraints, stable indexes, partial unique indexes and `bookings_no_overlap`; added a guarded live integration suite covering data shape, all enum values, relations, time/purpose checks, half-open buffered windows, inactive statuses, update paths, non-cascading deletes and parallel conflicts; documented the exact database contract.
- **How:** `blocked_until` is a creation-time policy snapshot and the exclusion range is half-open (D32). All parent relations restrict deletion and stable partial/exclusion constraint names are the concurrency authority (D33). Unsupported Prisma constructs remain in reviewed raw SQL and the generated relation stays conservatively plural (D34). The starting audit found clean synchronized `main` at merge `6bd6ede`, matching §9 with Task 1.4 next.
- **Files touched:** `prisma/schema.prisma`, `prisma/migrations/20261021160000_usage_booking_tables/migration.sql`, `apps/api/test/integration/usage-booking-models.integration-spec.ts`, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021160000_usage_booking_tables`; reviewed as additive SQL with one enum, two tables, two database UUID defaults, eight `TIMESTAMPTZ(3)` fields, six `ON DELETE RESTRICT` foreign keys, six named CHECK constraints, three booking query indexes, one usage query index, two named partial unique indexes, `btree_gist`, and the named active-booking exclusion constraint
- **Verification:** The live Neon catalog reported `timestamptz_pl_interval` volatility as `STABLE`, and a transaction-scoped generated-column probe was rejected with `generation expression is not immutable`. On fresh six-hour branch `ci/task-1.4-usage-booking-20261021`, all four migrations applied in order and `prisma migrate diff` printed `No difference detected.` Guarded `pnpm test:integration` passed 23/23 across three suites; separate connections produced exactly 1 success plus 19 `23P01` `bookings_no_overlap` failures and exactly 1 success plus 19 `23505` `usage_sessions_one_open_per_machine` failures. Tests also proved exact-boundary acceptance, one-millisecond overlap rejection, active-status scope, both conflict-producing UPDATE paths, checks/indexes/relations and delete restrictions. Cleanup left zero Task 1.4 rows, then the disposable branch was deleted. The migration applied to Neon `dev`; its four-migration status was current and drift was also empty. `pnpm install`, frozen install, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, hermetic `pnpm test` (48 tests: 37 API and 11 web), safe-localhost `pnpm build`, and `git diff --check` passed. An initial live run exposed an invalid zero-buffer fixture because Task 1.3 requires positive values; the fixture was corrected to the documented null/no-override value and the complete fresh proof passed.
- **Result:** Task 1.4 ticked complete.
- **Progress after this session:** 11 / 71 (15.5%)
- **Left undone / follow-ups:** Booking/usage APIs, state transitions, seed data and Task 1.5 service tables remain out of scope. The API in Task 5.3 must calculate `blocked_until` on every booking creation/update. Existing tooling, Docker, branch-protection and PostgreSQL SSL warnings remain tracked.
- **Next task:** 1.5 Service tables: tickets, records and maintenance schedules
- **Branch / commit:** `phase-1/task-1.4-usage-booking-tables` / `feat(db): add usage and booking constraints`

### [2026-10-21 14:52 EAT] — Task(s): 1.4 — Hosted verification and delivery
- **Prompt summary:** Complete the Task 1.4 Git lifecycle after implementation and live-database verification.
- **What I did:** Pushed the task branch, opened PR #10, monitored the hosted quality workflow, merged with a merge commit only after it passed, and synchronized local `main`; then corrected §9 to the delivered branch state.
- **How:** Followed the repository Git ownership policy in D18; application/schema scope did not change.
- **Files touched:** this handoff only in the follow-up; Task 1.4 implementation files were delivered by PR #10
- **Migrations:** none in this follow-up; `20261021160000_usage_booking_tables` was already verified and delivered
- **Verification:** GitHub `CI / Quality` completed successfully in 1m05s for PR #10; the PR merged as `4343d1a`; `git pull --ff-only origin main` synchronized local `main` and the worktree was clean.
- **Result:** Task 1.4 remains complete and is now delivered on `main`.
- **Progress after this session:** 11 / 71 (15.5%)
- **Left undone / follow-ups:** No change from the Task 1.4 implementation entry.
- **Next task:** 1.5 Service tables: tickets, records and maintenance schedules
- **Branch / commit:** `phase-1/task-1.4-handoff-finalize` / `docs: finalize Task 1.4 delivery`

### [2026-10-21 15:16 EAT] — Task(s): 1.5 — Service tables
- **Prompt summary:** Add constraint-rich service tickets, service records and maintenance schedules; connect status history to tickets; prove the complete migration chain and model contract on Neon `dev` and a disposable branch; preserve hermetic defaults and complete the Git/PR lifecycle without adding APIs or support tables.
- **What I did:** Added all three service enums and mapped Prisma models, relations and defaults; created an additive migration with named lifecycle/text/money/currency/cadence checks, stable technician/history/due-sweep indexes, one-active-schedule partial uniqueness and seven restrictive foreign keys; added the deferred status-history ticket relation; extended live integration coverage and documented the resulting contract.
- **How:** Service data is non-cascading factual history, tickets accept multiple ordered records, and integer minor-unit cost is sufficient for one service event (D35). Named checks enforce row consistency and a 4,000-character description ceiling without forbidding coexisting fault/preventive work (D36). Inactive schedules retain history while a named partial unique index permits one active policy per machine (D37). The starting audit found clean synchronized `main` at merge `dc04435`, matching §9 with Task 1.5 next.
- **Files touched:** `prisma/schema.prisma`, `prisma/migrations/20261021170000_service_tables/migration.sql`, API service integration tests plus the Task 1.3 history test, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021170000_service_tables`; reviewed as additive SQL with three enums, three tables, three database UUID defaults, fifteen `TIMESTAMPTZ(3)` fields, fourteen named CHECK constraints, eight stable indexes (including two partial maintenance indexes), and seven `ON DELETE RESTRICT` foreign keys
- **Verification:** Before adding the history-ticket FK, live Neon `dev` reported zero non-null `machine_status_history.ticket_id` values. On fresh six-hour branch `ci/task-1.5-service-tables-20261021`, all five migrations applied in order, migration status was current, and `prisma migrate diff` printed `No difference detected.` The new service suite passed 8/8; the final guarded `pnpm test:integration` passed 31/31 across four suites and proved all enums/defaults/relations, every named check, multi-record tickets, the integer cost boundary, coexisting faults, one active schedule, stable indexes, update timestamps and restrictive deletion including a history-referenced ticket. The first full run correctly exposed Task 1.3's former random unconstrained ticket UUID fixture; it was changed to create a real ticket and assert that the FK now exists, after which the full rerun passed. Cleanup left zero service/test rows and the branch was deleted. The reviewed migration then applied to `dev`; all five migrations were current and drift was empty. Both `pnpm install` modes, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, hermetic `pnpm test` (48 tests: 37 API and 11 web), safe-localhost `pnpm build`, and `git diff --check` passed.
- **Result:** Task 1.5 ticked complete.
- **Progress after this session:** 12 / 71 (16.9%)
- **Left undone / follow-ups:** Ticket comments remain Task 6.2; booking `needs_attention` remains Task 6.5; Task 10.1 still owns least-privilege append-only enforcement. No service APIs, condition coupling, support tables, seed data, auth, notifications or jobs were added. Existing tooling, Docker, branch-protection, Prisma raw-constraint and PostgreSQL SSL warnings remain tracked.
- **Next task:** 1.6 Support tables: audit logs, notifications, attachments and app settings
- **Branch / commit:** `phase-1/task-1.5-service-tables` / `feat(db): add service and maintenance tables`

### [2026-10-21 15:19 EAT] — Task(s): 1.5 — Hosted verification and delivery
- **Prompt summary:** Complete the Task 1.5 Git lifecycle after implementation and live-database verification.
- **What I did:** Pushed the task branch, opened PR #12, monitored the hosted quality workflow, merged with a merge commit only after it passed, and synchronized local `main`; then corrected §9 to the delivered branch state.
- **How:** Followed the repository Git ownership policy in D18; application/schema scope did not change.
- **Files touched:** this handoff only in the follow-up; Task 1.5 implementation files were delivered by PR #12
- **Migrations:** none in this follow-up; `20261021170000_service_tables` was already verified and delivered
- **Verification:** GitHub `CI / Quality` completed successfully in 1m04s for PR #12; the PR merged as `2c7ebb0`; `git pull --ff-only origin main` synchronized local `main` and the worktree was clean.
- **Result:** Task 1.5 remains complete and is now delivered on `main`.
- **Progress after this session:** 12 / 71 (16.9%)
- **Left undone / follow-ups:** No change from the Task 1.5 implementation entry.
- **Next task:** 1.6 Support tables: audit logs, notifications, attachments and app settings
- **Branch / commit:** `phase-1/task-1.5-handoff-finalize` / `docs: finalize Task 1.5 delivery`

### [2026-10-21 15:42 EAT] — Task(s): 1.6 — Support tables
- **Prompt summary:** Add constraint-rich audit, notification, preference, attachment and settings tables; enforce append-only audit history and upload/settings invariants; prove the complete migration chain and idempotent defaults on Neon `dev` and a disposable branch; preserve hermetic defaults and complete the Git/PR lifecycle without starting seed data or application services.
- **What I did:** Added the closed attachment enum and all five mapped Prisma models/relations; added shared Zod-owned audit/notification identifier lists; created an additive migration with named format/text/JSON/size/time/MIME checks, stable query indexes, restrictive user foreign keys, an append-only audit trigger and four idempotent settings defaults; added guarded live integration coverage and documented the resulting contract.
- **How:** Open-ended event identifiers remain checked text while `@app/shared` owns allowed Zod enums (D38). Audit rows support system actors and string-key entities, store IPs as `inet`, cap object snapshots at 64 KiB and reject UPDATE/DELETE through a trigger (D39). Preferences use their natural composite key (D40); polymorphic attachments rely on service validation and hard deletion plus audit history (D41); settings use non-overwriting scalar defaults (D42). The starting audit found clean synchronized `main` at merge `cb1f0c2`, matching §9 with Task 1.6 next.
- **Files touched:** `prisma/schema.prisma`, `prisma/migrations/20261021180000_support_tables/migration.sql`, `apps/api/test/integration/support-models.integration-spec.ts`, `packages/shared` event schemas/manifest, lockfile, `docs/ARCHITECTURE.md`, this handoff
- **Migrations:** `20261021180000_support_tables`; reviewed as additive SQL with one enum, five tables, three database UUID defaults, eleven `TIMESTAMPTZ(3)` fields, twenty-one named CHECK constraints, seven stable secondary/unique indexes, four `ON DELETE RESTRICT` foreign keys, one append-only trigger/function, and four `ON CONFLICT DO NOTHING` settings rows
- **Verification:** On fresh six-hour branch `ci/task-1.6-support-tables-20261021`, all six migrations applied in order, migration status was current, and `prisma migrate diff` printed `No difference detected.` The support suite passed 8/8; the final guarded `pnpm test:integration` passed 39/39 across five suites and proved every support model/enum, JSONB round-tripping, nullable/system audit actors, trigger rejection with `55000`, constraints, indexes, composite uniqueness/defaults, restrictive deletion, attachment polymorphism/no invalid target FK, timestamp precision, and non-overwriting settings replay. Non-audit fixtures cleaned to zero; audit rows/actors remained by design and disappeared with deletion of the disposable branch. The reviewed migration then applied to Neon `dev`; all six migrations were current and drift was empty. `pnpm install`, frozen install, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, hermetic `pnpm test` (48 tests: 37 API and 11 web), safe-localhost `pnpm build`, and `git diff --check` passed. The first targeted command placed a Jest option after an extra `--` and found no tests; the corrected first run exposed only the expected PostgreSQL `RESTRICT` SQLSTATE (`23001` rather than generic `23503`), after which the targeted and complete fresh proofs passed.
- **Result:** Task 1.6 ticked complete.
- **Progress after this session:** 13 / 71 (18.3%)
- **Left undone / follow-ups:** Task 1.7 owns seed data and final index/migration review; Tasks 3.5/6.6 own Supabase object lifecycle and polymorphic target validation; Task 5.1 owns setting value semantics; Task 9.4 owns critical preference policy; Task 10.1 owns the least-privilege application role. No seed data, auth, storage integration, delivery, audit interceptor, endpoints or jobs were added. The Neon CLI credential-output incident and existing tooling/Docker/branch-protection/Prisma/SSL warnings remain tracked.
- **Next task:** 1.7 Indexes, seed script and migration review
- **Branch / commit:** `phase-1/task-1.6-support-tables` / `feat(db): add support tables and safeguards`

### [2026-10-21 15:46 EAT] — Task(s): 1.6 — Hosted verification and delivery
- **Prompt summary:** Complete the Task 1.6 Git lifecycle after implementation and live-database verification.
- **What I did:** Pushed the task branch, opened PR #14, monitored the hosted quality workflow, merged with a merge commit only after it passed, and synchronized local `main`; then corrected §9 to the delivered branch state.
- **How:** Followed the repository Git ownership policy in D18; application/schema scope did not change.
- **Files touched:** this handoff only in the follow-up; Task 1.6 implementation files were delivered by PR #14
- **Migrations:** none in this follow-up; `20261021180000_support_tables` was already verified and delivered
- **Verification:** GitHub `CI / Quality` completed successfully in 1m27s for PR #14; the PR merged as `fced378`; `git pull --ff-only origin main` synchronized local `main` and the worktree was clean before this append-only status correction.
- **Result:** Task 1.6 remains complete and is now delivered on `main`.
- **Progress after this session:** 13 / 71 (18.3%)
- **Left undone / follow-ups:** No change from the Task 1.6 implementation entry, including the Neon password-rotation follow-up.
- **Next task:** 1.7 Indexes, seed script and migration review
- **Branch / commit:** `phase-1/task-1.6-handoff-finalize` / `docs: finalize Task 1.6 delivery`

---

## 13. KNOWN ISSUES / TECH DEBT

- Neon CLI 8.8.0 printed a full inherited-role connection URI while creating the Task 1.6 disposable branch even with table output. The value was not copied into repository files and the disposable branch was deleted, but the shared Neon role password should be rotated in the Neon console and all legitimate deployment/developer environment copies refreshed. Rotation was not performed automatically because it would invalidate `main`, `staging`, and `dev` clients.
- Prisma cannot represent PostgreSQL partial unique indexes or exclusion constraints in its schema. The reviewed Task 1.4/1.5 migrations and live integration tests are authoritative; `Booking.usageSessions` is typed as a list despite database cardinality, and the one-active-maintenance-schedule rule exists only in raw SQL. Later services must continue mapping named database violations rather than relying on Prisma relation cardinality alone.
- `machine_status_history` is append-only by schema/API design, but the current Neon owner role can still issue direct UPDATE/DELETE statements. Task 10.1 must introduce/use a least-privilege application role and revoke those privileges; migration ownership must remain separate.
- On this workstation, Docker created and ran the Task 0.7 Redis container but the daemon rejected direct `docker compose stop` and `docker stop` signals with `permission denied`. An in-container `redis-cli shutdown nosave` stopped Redis cleanly and `docker compose down` removed the stopped container/network; investigate Docker Desktop/daemon signal permissions if the direct-stop failure recurs.
- GitHub reports that `main` has no branch-protection rule. The CI workflow is green and the README documents the intended required `Quality` check, but GitHub does not yet enforce it; configure the rule explicitly after confirming the desired collaborator/merge policy.
- `pnpm install` under Node 24.22.0 emits a non-fatal `DEP0169` warning from pnpm 9.15.9's use of the legacy `url.parse()` API. Installation and all verification commands still pass; reassess the pnpm pin in a dedicated tooling task rather than changing the approved Task 0.1 baseline.
- pnpm reports peer-range warnings because transitive `eslint-plugin-import`, `eslint-plugin-react`, and `eslint-plugin-jsx-a11y` metadata does not yet list ESLint 10. Next.js 16.4.2 officially supports ESLint 10, and the repo lint passes; monitor upstream metadata updates.
- Next.js 16.4.2 development startup can print `Ready` immediately before `next.config.ts` environment validation reports an error. The process still exits with code 1 and lists all invalid variables; this is an output-order quirk, not a bypass of validation.
- Jest 30 runs the NestJS 12 ESM packages with Node's `--experimental-vm-modules`, so Node 24 prints a non-fatal experimental-feature warning during tests. All unit/e2e tests pass; reassess when Jest's ESM runtime no longer requires the flag.
- The Task 0.4 test dependency tree currently reports deprecated transitive `glob@10.5.0`. It is not a direct dependency and does not affect the passing test suite; monitor upstream Jest tooling releases.
- Live Neon integration currently emits a `pg-connection-string` warning that `sslmode=require` is treated as `verify-full` today but will adopt weaker libpq semantics in its next major version. Current TLS verification remains strict; before upgrading to `pg` 9 / `pg-connection-string` 3, change managed connection URLs to explicit `sslmode=verify-full` or deliberately opt into libpq compatibility.
- **Resolved in Task 0.6:** plain `pnpm test` previously required a developer-provided `WEB_ORIGIN` and could also pass locally only because ignored `@app/shared` output already existed. Test setup now owns safe required URLs, and the root test command builds shared first; a clean staged-tree export passes with no `.env` files.

---

## 14. ENVIRONMENT & SETUP

*(Keep current. Never put real secrets here — names and purpose only.)*

| Variable | Used by | Required now | Purpose |
|---|---|---|---|
| `NODE_ENV` | api | No (defaults to `development`) | Selects environment-specific validation; production enforces TLS Redis |
| `PORT` | api | No (defaults to `3001`) | API listening port |
| `WEB_ORIGIN` | api | Yes | Web origin; used for the CORS allow-list in Task 0.4 |
| `DATABASE_URL` | api | Yes | Neon **pooled** connection string (runtime and readiness) |
| `DIRECT_URL` | api / prisma | Yes | Neon **direct** connection string (migrations and CLI operations) |
| `INTEGRATION_DATABASE_URL` | api integration tests | Explicit suite only | Pooled URL for a dedicated disposable Neon branch; must differ from normal database URLs |
| `INTEGRATION_DATABASE_BRANCH` | api integration tests | Explicit suite only | Dedicated branch name beginning `ci/`, `test/`, or `ephemeral/`; long-lived branches are rejected |
| `REDIS_URL` | api | Development default; required in production | Redis connection; production must use `rediss://` |
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
- Start local Redis: `docker compose up -d redis`
- Check local Redis: `docker compose ps redis`
- Stop local Redis: `docker compose stop redis`
- Remove local Redis resources: `docker compose down`
- Build shared, web and API: `pnpm build`
- Lint workspaces: `pnpm lint`
- Fix auto-fixable lint issues: `pnpm lint:fix`
- Format supported files: `pnpm format`
- Check formatting: `pnpm format:check`
- Typecheck workspaces: `pnpm typecheck`
- Test workspaces: `pnpm test`
- Run guarded live database integration tests (disposable branch only): `pnpm test:integration`
- Generate Prisma Client: `pnpm prisma:generate`
- Create/apply a development migration: `pnpm prisma:migrate:dev --name <migration-name>`
- Apply committed migrations: `pnpm prisma:migrate:deploy`
- Check database/schema drift: `DIRECT_URL=<dedicated-direct-url> pnpm exec prisma migrate diff --config prisma7.config.ts --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
- Run the seed command: `pnpm db:seed`
- Run API unit tests: `pnpm --filter @app/api test:unit`
- Run API e2e tests: `pnpm --filter @app/api test:e2e`
- Run web unit/component tests: `pnpm --filter @app/web test`
- Validate GitHub Actions workflows: `actionlint .github/workflows/ci.yml` (actionlint must be installed separately)

**API operational endpoints:**
- Liveness: `GET /health`
- Readiness: `GET /health/ready`
- OpenAPI UI: `GET /api/docs`
- OpenAPI JSON: `GET /api/docs-json`
- Application API prefix: `/api/v1`

**Neon branches:** `main` (production), `staging`, `dev`; explicit database integration jobs create dedicated ephemeral branches, apply reviewed migrations, and remove the branches after the run. `INTEGRATION_DATABASE_BRANCH` and `INTEGRATION_DATABASE_URL` are guarded so the suite cannot use a long-lived or normally configured database. Default unit/e2e tests use localhost placeholders and never connect to Neon.

**Services running locally:** Redis via `docker compose up -d redis` on `127.0.0.1:6379` (stopped after verification).

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
