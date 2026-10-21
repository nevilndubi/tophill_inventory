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
19. **Never print, log, or echo a database connection string or password.** Neon CLI output that may contain credentials must be captured to a permission-restricted temporary file or in-memory value and discarded; when JSON output is needed, expose only non-secret branch identifiers or hosts. Redact database errors and command evidence so credentials never enter terminals, logs, CI output, the repository, or the handoff.

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
- [x] 1.7 Indexes, seed script (realistic demo data), migration review

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
| Overall progress | 14 / 71 tasks (19.7%) |
| Current phase | Phase 1 — Task 1.7 verified |
| Last updated | 2026-10-21 16:29 EAT |
| Branch | `phase-1/task-1.7-indexes-seed-review` |
| Last commit | `feat(db): add deterministic demo seed and index review` |
| Repo state | Task 1.7 implementation, complete seven-migration fresh-branch proof, repeat seed, index plans, 39-test Neon integration, `dev` migration/seed and zero drift verified locally; commit/PR/hosted CI pending |
| **Next task** | **2.1 Supabase Auth project setup and config** |

---

## 10. PENDING / BACKLOG

### Pending (planned, in the checklist)
Everything in §8 not yet ticked. Do not duplicate it here — only list *extra* items discovered during work.

- Add a service-ticket comments table in Task 6.2 so lifecycle discussion is introduced with the service API rather than prematurely in the Phase 1 schema.
- Add a booking `needs_attention` marker/reason migration in Task 6.5 when service outages are coupled to affected bookings.
- Enforce append-only `machine_status_history` and `audit_logs` privileges for a dedicated least-privilege application role in Task 10.1; the current owner role must retain migration privileges and can disable the audit trigger.
- In Tasks 3.5 and 6.6, validate each polymorphic attachment target in the same transaction before insert, and coordinate row/object deletion while writing the audit event.
- In Task 2.2, replace or link the six `@example.invalid` seed placeholders during real Supabase provisioning; until then their null Supabase identities and seed-data check keep them unable to sign in.

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
| D43 | 2026-10-21 | Never print, log or echo database connection strings/passwords; Neon automation must create branches with `--no-secrets`, capture connection output in memory or a restricted disposable file, redact errors and emit only safe branch metadata/hosts | The Task 1.6 CLI incident showed that normal command output can expose inherited-role credentials even when repository files remain clean | Rely on operator care; print then redact logs; pass URLs in command arguments |
| D44 | 2026-10-21 | Seed deterministic demonstration data with fixed hash-derived UUIDs, natural-key/id upserts, relative dates and explicit `HM-000001`–`HM-000060` tags; require branch+host confirmation, protected-host denial and a hard CI refusal | Reruns must refresh a coherent demo world without duplicates, touching production targets, or colliding with the database-owned asset-tag sequence | Truncate-and-reinsert; random IDs; fixture SQL; allow seed in CI |
| D45 | 2026-10-21 | Make Supabase identity nullable only for rows flagged `is_seed_data`, enforced by `users_seed_identity_consistency_check`; six `@example.invalid` placeholders have no identity and Task 2.2 replaces/links them | Task 1.7 requires one placeholder per role that cannot authenticate, while all real users must retain a Supabase identity | Fake Supabase UUIDs; routable emails; defer role examples until auth |
| D46 | 2026-10-21 | Keep the Task 1.1–1.6 index set unchanged after EXPLAIN review: the realistic 3,000-machine fixture used an intended existing index for all five primary query shapes | An initial all-in-one-department fixture caused an artificial sequential scan; distributing equipment realistically removed it, so adding an index would be speculative | Add a composite machine-list index based on the unrealistic fixture; force index use |

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

### Historical summary — Phase 0 — Foundation and tooling

Across Tasks 0.1–0.7, the repository progressed from its planning documents to a pinned pnpm monorepo with Next.js, NestJS and shared TypeScript; strict ESLint/Prettier/Husky/commitlint; validated server/public environment boundaries; the versioned API bootstrap and stable root health probes; responsive Tailwind/shadcn web shell and typed client; hermetic GitHub Actions; and resilient local Redis integration. Each task was verified with the applicable clean install, format, lint, typecheck, test, build, negative-hook/env/CORS/browser/CI evidence, committed conventionally, and delivered through the recorded Git workflow. All seven Phase 0 checklist items, D6–D20, and the still-open tooling, Docker and branch-protection issues elsewhere in this handoff remain unchanged.

### Historical summary — Task 1.1 — Prisma and Neon foundation

Task 1.1 pinned Prisma 7.10.1 with the PostgreSQL driver adapter, pooled runtime and direct migration URLs, generated CommonJS client, global Nest lifecycle integration, bounded readiness behavior, an empty initial migration, automatic client generation, hermetic mocks and documented Neon branch workflow. The migration and live readiness were verified on Neon dev, default checks passed without a database, and the task was delivered conventionally; D21–D23 and all remaining Prisma/SSL issues remain authoritative.

### Historical summary — Task 1.2 — Core users, departments and locations

Task 1.2 added mapped Role/User/Department/Location models and the additive core migration with database UUIDs, timestamptz precision, lowercased case-insensitive email uniqueness, named manager/member relations and explicit RESTRICT/SET NULL behavior. A fresh disposable Neon branch applied the chain and passed guarded integration coverage for reads, constraints, timestamps and deletion semantics before dev migration and delivery; D24–D26 remain authoritative.

### Historical summary — Task 1.3 — Machine registry tables

Task 1.3 added category, machine and status-history enums/models plus the reviewed machine migration: normalized permanent identity, race-safe HM asset-tag sequence, lifecycle/booking/service checks, independent ownership/location relations, restrictive history, pg_trgm and stable indexes. Fresh-branch and dev migration/drift checks, 13 live integration tests, parallel tag generation and 3,000-row trigram EXPLAIN evidence passed before hosted delivery; deferred ticket FK and least-privilege append-only work remained assigned to Tasks 1.5/10.1. D27–D31 remain authoritative.

### Historical summary — Task 1.4 — Usage and booking tables

Task 1.4 added bookings and usage sessions with half-open buffered ranges, named time/text checks, factual RESTRICT relations, one-open-session/one-session-per-booking partial uniqueness and the btree_gist bookings_no_overlap exclusion constraint. Fresh-chain/dev drift verification and the guarded live suite proved boundary, status, update and 20-way concurrency behavior (23P01/23505) before hosted delivery; D32–D34 remain authoritative.

### Historical summary — Task 1.5 — Service tables

Task 1.5 added all service enums and ticket/record/schedule models, the deferred status-history ticket FK, named lifecycle/text/money/cadence checks, stable board/history/due indexes, one-active-schedule uniqueness and restrictive relations. Preflight data validation, fresh-chain/dev zero-drift verification and 31 guarded integration tests covered every required invariant before hosted delivery; comments, booking-attention and least-privilege work remained deferred to their documented tasks. D35–D37 remain authoritative.

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

### [2026-10-21 16:29 EAT] — Task(s): 1.7 — Deterministic seed and migration/index review
- **Prompt summary:** Secure Neon credential handling, review the complete migration/index chain, add a guarded idempotent hospital demo seed, prove repeatability and representative query plans on a fresh disposable branch, seed `dev`, compact historical session entries, and complete the Git lifecycle without starting authentication.
- **What I did:** Added handoff rule 19 before implementation; added a credential-capturing `--no-secrets` Neon helper/orchestrator; added six non-authenticating seed-user support fields/checks; implemented deterministic departments, locations, categories, 60 machines, users, bookings, sessions, status history, tickets, records and schedules; advanced the asset sequence safely; added seed guards/tests/catalog/consistency/EXPLAIN verification; documented seed/reset/index behavior and compacted Phase 0/Tasks 1.1–1.5 into one paragraph each while retaining the last three full entries.
- **How:** Fixed hash-derived IDs plus upserts refresh relative dates without duplication; explicit branch and matching-host confirmation, mandatory protected hosts and a CI refusal prevent unsafe targets (D44). Seed users are flagged, use `@example.invalid`, have no Supabase identity and are constrained against sign-in (D45). Neon commands keep credentials captured and redact errors (D43). The corrected realistic 3,000-machine fixture used existing indexes for all five query shapes, so no speculative index was added (D46).
- **Files touched:** handoff, README, API env example and seed-safety test; Prisma schema, `20261021190000_seed_user_support`, seed/safety/catalog/Neon verification scripts; root package/lockfile; architecture
- **Migrations:** `20261021190000_seed_user_support`; reviewed as a safe relaxation of `supabase_user_id`, one non-null boolean default, and named identity-consistency check; the complete seven-migration chain applied from empty on a disposable child of `main`, then the new migration applied to `dev`
- **Verification:** Credential-safe CLI access saw three branches without displaying a connection value. A protected-host seed attempt exited 1 before connection with `Refusing to seed a protected main or staging database host`. On fresh branch `ci/task-1.7-seed-202610211321`, all seven migrations applied in order; seed and immediate reseed each reported 5 departments, 20 locations, 8 categories, 60 machines and 6 placeholders; verification found 12 bookings, 14 sessions and 15 tickets, exact condition mix and every required scenario/invariant; the next generated tag was 61. All 32 documented indexes existed (catalog check added after this run); seed and 3,000-machine EXPLAINs showed the intended machine, session, exclusion, My Bookings and technician indexes with no large primary-table sequential scan. Guarded `pnpm test:integration` passed 39/39 and drift printed `No difference detected.` The branch was deleted. Neon `dev` applied migration/seed, passed the same counts, reported seven migrations current and zero drift. Both install modes, format check, lint, typecheck, hermetic tests (53 total: 42 API, 11 web), build and `git diff --check` passed. The first disposable review used an unrealistic single-department load fixture and correctly failed on a machine sequential scan; the branch was deleted, distribution was corrected without adding an index, and the full fresh proof passed.
- **Result:** Task 1.7 ticked complete locally; commit, PR, hosted CI, merge and final main synchronization remain in this turn.
- **Progress after this session:** 14 / 71 (19.7%)
- **Left undone / follow-ups:** Task 2.1 owns Supabase Auth setup. Task 2.2 must replace/link the seed placeholders. Existing tooling, Docker, branch-protection, Prisma raw-constraint, least-privilege and PostgreSQL SSL issues remain tracked; the exposed inherited-role password issue is resolved.
- **Next task:** 2.1 Supabase Auth project setup and config
- **Branch / commit:** `phase-1/task-1.7-indexes-seed-review` / `feat(db): add deterministic demo seed and index review`

---

## 13. KNOWN ISSUES / TECH DEBT

- **Resolved in Task 1.7:** the owner rotated the inherited Neon role password and refreshed legitimate development configuration. Rule 19 and the safe Neon helper now use `--no-secrets`, capture connection output without displaying it, redact database URLs from failures, and emit only safe metadata; both Task 1.7 disposable runs deleted their branches.
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
| `SEED_ALLOWED_BRANCH` | Prisma seed | Explicit seed only | Must be `dev` or a disposable `ci/`, `test/`, `ephemeral/`, or `demo/` branch; `main`/`staging` are rejected |
| `SEED_ALLOWED_HOST` | Prisma seed | Explicit seed only | Exact host confirmation that must match the target `DATABASE_URL` host |
| `SEED_PROTECTED_HOSTS` | Prisma seed | Explicit seed only | Comma-separated production `main` and `staging` hosts that the seed must reject |
| `NEON_PROJECT_ID` | Task 1.7 verification helper | Explicit live verification only | Non-secret Neon project identifier; connection output remains captured |
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
- Verify deterministic seed counts/relations: `pnpm db:seed:verify`
- Review seed sequence and five EXPLAIN query shapes: `pnpm db:index-review`
- Run the credential-safe Task 1.7 disposable/dev proof: `NEON_PROJECT_ID=<project-id> pnpm verify:neon:task-1.7`
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
