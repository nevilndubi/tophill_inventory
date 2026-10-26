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
20. **Never print, log, or echo Supabase keys, passwords, access/refresh tokens, or full JWTs.** Capture CLI/API values in memory, emit only non-secret configuration metadata and token claims, and keep proof credentials in ignored permission-restricted files.

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
- [x] 2.1 Supabase Auth project setup & config
- [x] 2.2 API JWT guard (JWKS verification) + local user provisioning/sync
- [x] 2.3 RBAC: roles, permissions map, `@RequirePermission()` guard
- [x] 2.4 Web auth: login/logout, session handling, route protection
- [x] 2.5 User management (invite, assign role/department, deactivate)
- [x] 2.6 Auth/RBAC test suite

### Phase 3 — Machine Registry
- [x] 3.1 Categories CRUD (API + UI)
- [x] 3.2 Departments & locations CRUD (API + UI)
- [x] 3.3 Machines CRUD API (pagination, filter, search, sort)
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
- [ ] 7.2 Cache status board, machine detail, lookups + invalidation; replace the Task 2.6 skipped role/active-state cache sentinel with a passing next-request invalidation test
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
| Overall progress | 23 / 71 tasks (32.4%) |
| Current phase | Phase 3 — dependency maintenance complete after Task 3.3 |
| Last updated | 2026-10-26 22:03 EAT |
| Branch | `main` |
| Last commit | `aac861e Merge pull request #44 from nevilndubi/maintenance/dependency-sweep` |
| Repo state | The dependency sweep and future Dependabot policy are merged; local `main` is synchronized with `origin/main`, the task count is unchanged, and Task 3.4 remains next |
| **Next task** | **3.4 Machines list and detail UI** |

---

## 10. PENDING / BACKLOG

### Pending (planned, in the checklist)
Everything in §8 not yet ticked. Do not duplicate it here — only list *extra* items discovered during work.

- Add a service-ticket comments table in Task 6.2 so lifecycle discussion is introduced with the service API rather than prematurely in the Phase 1 schema.
- Add a booking `needs_attention` marker/reason migration in Task 6.5 when service outages are coupled to affected bookings.
- Enforce append-only `machine_status_history` and `audit_logs` privileges for a dedicated least-privilege application role in Task 10.1; the current owner role must retain migration privileges and can disable the audit trigger.
- In Tasks 3.5 and 6.6, validate each polymorphic attachment target in the same transaction before insert, and coordinate row/object deletion while writing the audit event.
- **Before inviting real staff:** configure custom SMTP with the Phase 9 Resend account, paste the exact invite template from `docs/SUPABASE_SETUP.md`, retain exact environment redirect allow-lists, and complete one non-staff delivery/acceptance test. Task 2.5 implemented and mock-tested delivery, but live email delivery remains intentionally unverified because the built-in sender is organisation-member-only/rate-limited.
- **Orphaned Auth identity reconciliation:** `AUTH_IDENTITY_EXISTS` is deliberately not auto-linked. Run the read-only `pnpm users:reconcile-auth` command (IDs/counts only), investigate ownership, and perform any approved manual repair without logging addresses. Automated reconciliation/linking requires a separately approved task.
- Task 2.4 now supplies web login; bootstrap the owner's real first SUPER_ADMIN once against `dev` using `BOOTSTRAP_SUPER_ADMIN_EMAIL` in the API's own ignored `.env`, not the task credential file; repeat once for production using its deployment secret store, then remove the setting in each environment.
- When staging and production domains exist, add their exact Supabase Site/redirect URLs and verify each environment; do not add wildcard Vercel preview redirects.
- **Hospital shared-device security:** decide the idle/inactivity sign-out policy before production hardening (candidate owner: Task 10.2). Task 2.4 deliberately implements explicit and cross-tab logout only.
- **Task 7.3 — login rate limiting:** add the application-owned Redis control when the rate-limiting task lands; Supabase's hosted Auth limits are the only login throttle until then.
- **Task 7.3 — invitation rate limiting:** add an application-owned Redis limit for `POST /api/v1/users`; until then, the endpoint is permission-gated, uses a 16 KiB JSON body limit and inherits Supabase's service limits.
- **Task 3.8 — restore retired machine:** proposed new `machine:restore` permission, initially `GLOBAL` for SUPER_ADMIN and ADMIN only; do not alias restore to edit/retire until the owner approves the state-transition policy.
- **Task 5.4 — cancel own booking:** proposed ownership rule layered on `booking:create` with `isOwner = true`; administrative or department cancellation remains a separate decision for that service.
- **Task 4.2 — check in a session you hold:** proposed ownership rule layered on `usage:check-in-out` with `isOwner = true`; force-ending another user's session remains governed by `usage:force-end`.
- **Task 5.4 — edit own booking:** proposed ownership rule layered on `booking:create` with `isOwner = true`, subject to booking-state and overlap checks.
- **Task 9.3 — read own notifications:** proposed new `notification:read-own` permission for every authenticated application role, enforced with ownership rather than a global notification-read grant.
- **Task 3.5 — upload attachments:** proposed new `attachment:upload` permission for SUPER_ADMIN, ADMIN, BIOMED_TECH, DEPT_MANAGER and STAFF, with entity access checked by the service; VIEWER remains read-only pending approval.
- **Task 7.2 — cached user context:** invalidate `user:{supabaseId}` immediately whenever a user's role, department or active state changes so Task 2.3's next-request effect is preserved after caching is introduced. Replace the Task 2.6 conditionally skipped cache-invalidation sentinel with a real passing test; the sentinel deliberately fails once 7.2 is ticked.
- **Task 7.2 — reference-data caching:** place cache-aside behind the category service's read method and invalidate every category list/detail key after each successful create, update or delete; Task 3.1 deliberately adds no cache.
- **Task 7.2 — department/location reference caching:** add cache-aside at the Task 3.2 service read boundaries and invalidate `ref:departments:v1` and `ref:locations:v1` after every successful relevant write, including manager changes caused through user administration.
- **Tasks 4.2 and 5.3 — close the machine/delete race:** checkout and booking creation must lock the machine row and reject a soft-deleted machine before inserting a session or booking; Task 3.3 deletion locks the same row before checking current sessions/bookings.
- **Tasks 6.2 and 6.3 — service-field ownership:** service-record completion takes ownership of `last_serviced_at`; maintenance scheduling owns schedule rows and due-date progression. Task 3.3 only supports onboarding/editing existing service facts and computes `next_service_due_at` from the two source fields.
- **Task 7.2 — machine caching:** put cache-aside behind the Task 3.3 service read boundaries; invalidate `machine:{id}:v1`, every future machine-list/status-board key set, and any future asset-tag lookup key after successful create/update/delete. Condition and usage changes must also invalidate the detail/status keys already documented in Architecture §6.
- **Task 3.8 — machine restore:** add the approved restore workflow/UI and decide whether restored registry records need additional booking/session safeguards; Task 3.3 intentionally has no restore endpoint.
- **Node type major:** revisit the ignored `@types/node` semver-major update only when the pinned runtime moves from Node 24; keep runtime and declaration majors aligned and verify the complete workspace during that runtime upgrade.
- **TypeScript 6:** revisit the ignored TypeScript semver-major update in a dedicated toolchain task after Next.js, NestJS, Prisma, ts-jest, tsup and ESLint support is verified together and the hosted Quality pipeline passes.

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
| D47 | 2026-10-24 | Use modern Supabase publishable/secret keys and asymmetric ES256 signing with JWKS discovery; derive issuer and JWKS URLs from `SUPABASE_URL` and store no shared JWT secret | Current Supabase guidance gives independently rotatable keys and asymmetric verification avoids distributing a signing secret; the live token's `kid` matched the hosted JWKS | Legacy `anon`/`service_role` JWT keys; HS256 shared secret; manually unrelated issuer/JWKS values |
| D48 | 2026-10-24 | Use invite-only confirmed email/password Auth with public and anonymous sign-up disabled; omit magic-link UI, keep the API secret server-only and expose only the publishable key/URL to the browser | This is the documented initial flow, prevents uncontrolled accounts, and keeps privileged credentials outside Next.js assets; real invitations wait for custom SMTP and Task 2.5 | Public registration; magic-link-first login; browser service key; send real invitations through the built-in test sender |
| D49 | 2026-10-24 | Resolve authenticated users only by an existing non-seed `supabase_user_id`, plus a one-time transactional first-SUPER_ADMIN bootstrap; never link by email or auto-provision ordinary users | `users_seed_identity_consistency_check` requires seed rows to have a null identity and every non-seed row to have a non-null identity, so there is no valid unlinked real row to match by email without weakening the schema. Task 2.5 creates invited identities instead | Loosen the check; link seed placeholders; trust a JWT email claim; auto-provision a default role |
| D50 | 2026-10-24 | Protect all application controllers with a global guard that accepts only strict Bearer ES256 Supabase tokens, requires the hosted issuer, authenticated audience/role and UUID subject, caches remote JWKS keys, and maps JWKS/provider outages to HTTP 503 `AUTH_UNAVAILABLE` | Algorithm allow-listing prevents confusion attacks, database lookup keeps application authorization local, explicit public metadata prevents accidental route exposure, and an upstream outage must not force clients to log out | HS256/shared secret; controller-by-controller guards; trust JWT application roles; return 401 for provider outages |
| D51 | 2026-10-24 | Keep Task 2.2 bootstrap proof disposable; perform the real first-admin bootstrap on `dev` only after Task 2.4 web login, using the API's ignored `.env`, and repeat once in production through the deployment secret store | The real owner identity should not be placed in task credentials or chat, the operational flow needs a user-facing login, and environment-specific bootstrap values belong in each server's secret boundary | Bootstrap a test identity into `dev` now; store the real address in the task proof file; create the first admin manually in SQL |
| D52 | 2026-10-24 | Encode RBAC as an exhaustive browser-safe role × permission × scope matrix with `GLOBAL`, `OWN_DEPARTMENT` and `NONE`; run a fail-closed global permission guard after authentication, use explicit `@AuthenticatedOnly()` for `/me`, and derive role, active state and department only from the Neon user context | The Architecture §7 matrix contains both global and department-scoped grants plus BIOMED edit-only behavior; explicit entries avoid undocumented inheritance, shared helpers keep web/API decisions aligned, and database-backed context makes role changes effective on the next request | Trust JWT application claims; boolean-only permissions; implicit ADMIN/SUPER_ADMIN inheritance; controller-by-controller guards; path-special-case `/me` |
| D53 | 2026-10-24 | Keep Task 2.5 user-administration invariants as shared pure functions: SUPER_ADMIN may assign any role, ADMIN may assign only non-SUPER_ADMIN roles, other roles assign none, self-deactivation is denied and the final active SUPER_ADMIN is protected | The same deterministic policy can be exercised now and reused by later API/UI code without prematurely adding user-management endpoints | Defer all policy definition to Task 2.5; encode the restrictions only in UI controls; add implicit role inheritance |
| D54 | 2026-10-24 | Implement web sessions with `@supabase/ssr` request-scoped server clients, a browser singleton and Next.js 16 `proxy.ts`; use `getClaims()` for every server trust decision and use `getSession()` only after validation to retrieve the opaque bearer | This is the current supported Supabase/Next.js App Router convention, refreshes cookies correctly with private cache headers and keeps Proxy optimistic while the API remains authoritative | Deprecated `middleware.ts`; trust `getSession()` server-side; custom JWT cookies; use Proxy as authorization authority |
| D55 | 2026-10-24 | Accept Supabase's browser-readable SSR auth cookies with `SameSite=Lax`, production `Secure` and no false HttpOnly claim; compensate with one-hour access tokens, refresh rotation, exact-origin bearer attachment, full query-cache clearing/cross-tab logout and Task 10.2 CSP | Supabase documents that its browser client needs the refresh token; pretending the cookie is HttpOnly would break supported refresh behavior and misstate the security model | Force HttpOnly and lose browser refresh; store tokens in localStorage/React state; omit the tradeoff |
| D56 | 2026-10-24 | Map web auth failures explicitly: retry one 401 then sign out, retain the session for permission 403s and auth/network 503s, route unprovisioned/inactive users to a dedicated no-access screen, and render navigation from one shared-permission config with unbuilt entries disabled | Invalid identity, missing local access, insufficient permission and upstream outage require different recovery; shared permissions prevent UI drift and disabled placeholders avoid 404s without starting later features | Treat every failure as logout; infer access from JWT; duplicate role strings; link unfinished pages |
| D57 | 2026-10-25 | Invite in this order: authorize/validate, reject a lowercase Neon duplicate, reject a pre-existing Supabase identity, create Auth identity, then create the Neon user and audit row transactionally; compensate a failed Neon write by deleting only the newly created identity | There is no distributed transaction across Supabase and Neon, so strict ownership of the created identity plus database uniqueness makes retries deterministic and avoids deleting pre-existing identities | Insert Neon first; auto-link existing Auth identities; leave orphan identities after database failure; use eventual background provisioning |
| D58 | 2026-10-25 | Keep deactivation Neon-only and make role/department/active changes immediately effective on the next request; lock active real SUPER_ADMIN rows before last-admin checks and commit each mutation with its minimal audit event | Neon already authorizes every request, avoiding a second Supabase failure boundary; row locks prevent concurrent removal of all administrators and same-transaction audit preserves mutation history | Ban/sign out Supabase users; cache user context now; application-only last-admin counts; audit after commit |
| D59 | 2026-10-25 | Accept invitations through server-side `verifyOtp(token_hash, invite)` and an authenticated 12-character set-password page; require custom SMTP before real staff delivery, while live Task 2.5 proof uses non-delivering Admin `generateLink` and deletes the temporary identity | The token hash never enters client application state, expired/reused links fail generically, and the feature can be verified without using Supabase's restricted built-in sender or exposing one-time links | Put an access token in the URL; add public password reset/magic links; send a real staff invite through the built-in sender; defer acceptance to another task |
| D60 | 2026-10-25 | Keep one independently hand-authored route-access manifest for Task 2.6 and compare it one-to-one with runtime controller discovery; execute its role matrix through locally signed ES256 tokens and a controlled loopback JWKS server, and retain a conditional skipped sentinel for Task 7.2 cache invalidation | The test oracle must not derive expected access from production permissions, new handlers cannot disappear from coverage silently, and the full suite remains hermetic while exercising the real JWT/guard stack | Reuse the shared permission map as expected data; maintain a disconnected route list; contact hosted Supabase; defer cache coverage without an executable reminder |
| D61 | 2026-10-25 | Evaluate CORS with an exact-origin callback: requests without an Origin remain usable by server clients, the configured `WEB_ORIGIN` receives CORS headers, and every other origin receives no allow-origin header | The consolidated bypass tests exposed that a fixed string configuration emitted the configured allow-origin value even for a different request Origin; browsers still rejected the mismatch, but omitting the header is the precise allow-list contract | Keep the fixed string behavior; reject non-browser requests that omit Origin; allow multiple or wildcard origins |
| D62 | 2026-10-25 | Let every active authenticated role read categories through its existing `machine:read` grant, reserve mutations for `reference:manage`, normalize category names with shared NFC/trim/whitespace rules, and enforce case-insensitive uniqueness with `machine_categories_name_lower_key`; list counts include non-retired, non-deleted machines while deletion state/count includes every machine reference | All six roles need reference data to view machines, the documented matrix already grants only ADMIN/SUPER_ADMIN reference management, shared normalization keeps form/API behavior identical, and the foreign key blocks deletion even for retired or soft-deleted machines. The API's 1–3650 day and 5–1440 minute limits intentionally narrow the original database checks, which enforce positivity only | Add a new permission; make reads public; application-only uniqueness; count only active machines for deletion; broaden the database checks in this task |
| D63 | 2026-10-25 | Return `MANAGER_NOT_ELIGIBLE` as HTTP 422 and permit a department manager only when the locked user is active, non-seed, has role `DEPT_MANAGER`, and belongs to that department; validate only when the manager value changes | Eligibility is a semantically invalid relationship rather than a conflict with current state, row locking closes concurrent user-change races, and unrelated department edits must remain possible when old/demo data contains an ineligible manager | HTTP 409; validate without a lock; block every edit until a stale manager is repaired; allow broader manager roles |
| D64 | 2026-10-25 | Clear `departments.manager_user_id` with a same-transaction audit whenever user administration deactivates that manager, moves them to another department, or changes their role away from `DEPT_MANAGER`; a department may have no manager | Maintaining the relation from both mutation paths prevents stale authority while preserving an explicit valid unassigned state | Leave stale managers for manual cleanup; database trigger; reject the user mutation until a replacement manager is selected |
| D65 | 2026-10-25 | Enforce department name/code and per-department location-name uniqueness with the explicit lower-case expression indexes from migration `20261025130000_department_location_case_insensitive`; keep a location's department immutable, while allowing an explicitly warned department-code rename | Shared normalization plus database case-folding closes concurrent duplicates; re-parenting a physical location would silently rewrite placement/report meaning for machines, whereas a code rename does not alter existing relations | Application-only duplicate checks; `citext`; allow location re-parenting; make department codes immutable |
| D66 | 2026-10-25 | Read departments/locations through centralized services, calculate dependency counts without N+1 queries, count every machine reference for deletion, and reserve `ref:departments:v1` / `ref:locations:v1` cache-aside plus write invalidation for Task 7.2 | The API can report precise race-safe deletion conflicts now while retaining one future cache boundary and honoring restrictive foreign keys for retired/soft-deleted machines | Cache in Task 3.2; count only active machines; expose raw Prisma relations; query counts per row |
| D67 | 2026-10-26 | Keep machine identity/database state authoritative: require the schema's seven non-null registration fields, generate asset tags with the existing database default, normalize manufacturer/serial to lowercase, permit cross-department placement, and expose only minimized relation-aware DTOs | This preserves the Task 1.3 physical-identity and placement invariants under concurrency without leaking Prisma/internal fields. Database sequences are unique but intentionally not gapless because rolled-back registrations consume values | Client-generated tags; reuse deleted identities; require location ownership to match; expose raw rows |
| D68 | 2026-10-26 | On registration, atomically create the OPERATIONAL machine, its first SYSTEM status-history row and `machine.created` audit; accept `last_serviced_at` for onboarding but calculate `next_service_due_at` only from it plus `service_interval_days` and leave schedule creation to Task 6.3 | A registered machine begins with explainable condition history, audit cannot diverge from the write, and one deterministic derived due date prevents client drift while later service workflows retain clear ownership | Let clients submit the due date; create maintenance schedules early; omit the first history row; separate transactions |
| D69 | 2026-10-26 | Define DELETE as soft removal from the active registry, not retirement: lock the machine, reject open sessions/active bookings, preserve condition and identity, return 409 on repeated deletion, and hide deleted rows from every current read. RETIRED remains a Task 4.1 condition transition | Registration mistakes/decommissioned registry entries and genuine end-of-life are different events; row locking plus the future matching locks in Tasks 4.2/5.3 closes new-work races while historical identity and records remain intact | Hard delete; change condition to RETIRED; idempotent repeated 200; allow deletion with active work |
| D70 | 2026-10-26 | Make machine PATCH field-level and semantically idempotent: write only supplied editable fields, treat an unchanged request as 200 without audit or timestamp movement, and allow BIOMED_TECH to edit every currently editable machine field while preserving the Architecture §7 create/delete restrictions | Partial writes reduce unrelated administrator overwrites, empty/forbidden fields remain fail-closed, and the documented matrix says BIOMED is edit-only without a narrower field list. Full optimistic locking is deferred until a demonstrated concurrent-edit need | Replace the entire record; audit/touch no-ops; silently accept internal fields; invent technician field restrictions |
| D71 | 2026-10-26 | Group npm minor and patch updates into one weekly Dependabot PR, cap npm PRs at five, retain separate GitHub Actions updates, and ignore semver-major updates for `@types/node` and TypeScript until their recorded upgrade criteria are met | The ten-PR backlog created avoidable merge/rebase churn; grouped compatible updates preserve review while major runtime/toolchain transitions need intentional verification | Keep one PR per package and a limit of ten; allow automatic Node-types/TypeScript major PRs; disable Dependabot |
| D72 | 2026-10-26 | Accept `@hookform/resolvers` 6 only after checking its Zod-path release scope and declared peers against react-hook-form 7.90/Zod 4.6 plus form/full tests; accept `pg` 8.23 only after disposable-Neon migration, integration, drift and readiness proof | Major labels and runtime database libraries require evidence beyond a green lockfile-only PR, while both upgrades proved compatible without application changes | Close every major update; trust hosted CI alone; test database runtime changes against long-lived `dev` |

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

### Historical summary — Task 1.6 — Support tables

Task 1.6 added the closed attachment enum and mapped audit, notification, preference, attachment and app-settings models plus shared event schemas. Its additive migration enforced checked evolving identifiers, bounded JSON/inet audit data, an immediate append-only trigger, preference defaults/composite identity, polymorphic attachment safeguards, stable indexes, restrictive user relations and four non-overwriting settings defaults. A fresh disposable branch and Neon dev applied the six-migration chain with zero drift; 39 guarded integration tests plus all hermetic quality gates passed before PR #14 delivery. D38–D42, the object-lifecycle/least-privilege follow-ups and existing known issues remain authoritative.

### Historical summary — Task 1.7 — Seed and index review

Task 1.7 added the guarded deterministic demo seed, fixed hash-derived identities, 60 realistic Kenyan hospital machines, relative bookings/sessions/service data, sequence advancement, protected-host/CI refusal and credential-safe Neon automation. Fresh-branch migrate/seed/reseed, dev seed, 39 live integration cases, zero drift and five 3,000-row EXPLAIN query shapes all passed without a speculative index; the rotated Neon password and D43 output policy resolved the earlier credential incident. PR #16 delivered the task and D43–D46 plus all recorded follow-ups remain authoritative.

### Historical summary — Task 2.1 — Supabase Auth foundation

Task 2.1 configured and independently verified invite-only confirmed email/password Supabase Auth with public sign-up disabled, 12-character passwords, rotation, exact localhost redirects, modern publishable/secret keys and ES256 JWKS. Repository env validation, setup guidance, hermetic placeholders, bundle-secret checks and a credential-safe sign-in/wrong-password/signup-disabled verifier were added; Supabase remained Auth-only with no application tables. PR #18 delivered the task; custom SMTP, deployed URLs and invitation flow remain pending where recorded, and D47–D48 remain authoritative.

### Historical summary — Task 2.2 — API JWT guard and identity resolution

Task 2.2 added the global strict-Bearer ES256/JWKS authentication guard, explicit public/authenticated metadata, typed current-user context, minimized `GET /me`, identity-only Neon lookup, inactive/unprovisioned handling, bounded JWKS outage semantics, five-minute login touches and race-safe one-time SUPER_ADMIN bootstrap. Hermetic local-key/JWKS coverage plus sequential and concurrent disposable-Neon hosted proofs passed without exposing identity data or secrets; all proof branches were deleted and protected branches retained no test row. PR #20 delivered the task; the private real-owner bootstrap remains an operational dev/production step, and D49–D51 remain authoritative.

### Historical summary — Task 2.3 — Exhaustive scoped RBAC

Task 2.3 added the browser-safe exhaustive role × permission × scope matrix, fail-closed global authorization guard, typed decorators, department-scope helpers and shared administrator policy functions with independent table-driven unit/e2e coverage. Roles, active state and department stay Neon-authoritative, no implicit inheritance exists, production excludes test-only controllers, and changes take effect on the next request pending Task 7.2 cache invalidation. PR #22 delivered the task; proposed later ownership/capability mappings remain pending and D52–D53 remain authoritative.

### Historical summary — Task 2.4 — Web authentication

Task 2.4 added supported Supabase SSR browser/server clients, Next.js 16 `proxy.ts`, validated server trust, accessible login/logout, exact-origin bearer attachment, one-refresh 401 handling, distinct forbidden/no-access/unavailable UX, role-aware navigation and cache-clearing cross-tab sign-out. Hermetic tests, secret-bundle checks, responsive Playwright QA and a credential-safe disposable-Neon live flow proved login, reload, role-aware navigation, forbidden hard navigation and logout without exposing cookies or identities. PR #24 delivered the task; idle logout/rate limiting and private owner bootstrap remain pending, and D54–D56 remain authoritative.

### Historical summary — Task 2.5 — User management

Task 2.5 added permission-gated paginated user administration, compensated Supabase/Neon invitations, race-safe role/department/active changes, same-transaction minimal audits, invite acceptance/password setup, orphan reconciliation and an accessible responsive admin UI. Hermetic concurrency/denial/compensation tests and a credential-safe disposable-Neon browser proof verified one linked row, acceptance, immediate policy changes, ADMIN/SUPER_ADMIN boundaries and audit rows; the temporary identity and branch were removed. PR #26 delivered the task; custom SMTP, reconciliation, rate limiting and the real-owner bootstrap remain pending exactly as recorded, and D57–D59 remain authoritative.
### Historical summary — Task 2.6 — Consolidated Auth/RBAC test suite

Task 2.6 added the independently hand-authored six-role route-access oracle, production-handler discovery, strict declaration coverage, local ES256/JWKS e2e authentication, authorization ordering, hostile-path/token/CORS/Swagger/response-hygiene checks and the Task 7.2 cache sentinel. Its mutation proofs caught missing metadata and a deliberately widened permission, and the suite exposed/fixed the exact-origin CORS defect. Hermetic install/format/lint/typecheck/test/build and hosted GitHub Quality passed before PR #28 delivery; D60–D61 and the cache-invalidation follow-up remain authoritative.

### Historical summary — Task 3.1 — Categories CRUD implementation

Task 3.1 added shared category validation/audit contracts, permission-correct NestJS CRUD with grouped active/all-reference counts and stable conflict mapping, and the accessible responsive `/admin/reference` category UI plus typed navigation. The reviewed `machine_categories_name_lower_key` migration applied to Neon dev and a fresh disposable branch with zero drift; guarded live CRUD, soft-deleted/retired reference blocking, audit rollback, authorization mutations, responsive Playwright and 257 hermetic tests passed before the implementation commit. The shell selected-state bug was fixed, Task 7.2 cache work stayed deferred, and D62 remains authoritative.

### [2026-10-25 16:33 EAT] — Task(s): 3.1 — Hosted verification and delivery
- **Prompt summary:** Deliver the verified categories API/UI, migration and documentation through the complete owned Git workflow.
- **What I did:** Committed the full Task 3.1 implementation as `246194d`, pushed the task branch, opened PR #30, monitored hosted checks, merged only after the required job passed, deleted the task branch, and synchronized local `main` with `origin/main`.
- **How:** Used the D18 branch/PR lifecycle. GitHub Actions independently repeated frozen installation, formatting, linting, typechecking, hermetic tests and the production build; Supabase Preview correctly skipped because the additive category index is a Prisma/Neon migration rather than a Supabase database migration.
- **Files touched:** this handoff only in the delivery follow-up; the category contracts, API/UI, migration, tests, live verifier and architecture clarification were delivered by PR #30
- **Migrations:** `20261025093000_category_name_case_insensitive` was delivered after its successful Neon `dev`, fresh-disposable-branch and zero-drift proof
- **Verification:** GitHub `Quality` passed in 1m49s for PR #30; Supabase Preview reported skipped as expected; PR #30 merged as `3ad3b23`; local `main` matched `origin/main` with a clean worktree before this handoff-only update.
- **Result:** Task 3.1 is complete and delivered on `main`.
- **Progress after this session:** 21 / 71 (29.6%)
- **Left undone / follow-ups:** Department/location CRUD remains Task 3.2 and reference-data caching remains Task 7.2. All previously recorded pending items and known issues remain unchanged.
- **Next task:** 3.2 Departments & locations CRUD (API + UI)
- **Branch / commit:** `main` / `3ad3b23 Merge pull request #30 from nevilndubi/phase-3/task-3.1-categories-crud`

### [2026-10-25 21:51 EAT] — Task(s): 3.2 — Departments and locations CRUD
- **Prompt summary:** Add only department/location CRUD API and the corresponding `/admin/reference` UI, with exact reference permissions, manager eligibility/consistency, normalized shared validation, dependency-safe deletes, audits, route coverage, responsive and disposable-Neon proof, and complete owned Git delivery.
- **What I did:** Added shared department/location schemas, DTO types and audit actions; complete NestJS controllers/services/errors with manager candidates, grouped dependency counts, pagination/search and minimized responses; same-transaction manager cleanup in user administration; a typed web client and accessible URL-addressable Departments/Locations tabs; hermetic API/web tests and the expanded independent authorization inventory; the single approved case-insensitive uniqueness migration; and a credential-safe live verifier.
- **How:** Reads use `machine:read`; writes and the candidate endpoint use only `reference:manage`. Changed managers are validated against a locked active non-seed same-department `DEPT_MANAGER` row and rejected as 422; user deactivation, role removal and department movement clear the manager plus audit in the same transaction. Location ownership is immutable, department codes remain editable with a reporting warning, all delete counts include retired/soft-deleted machine references, and writes map `P2002`/`P2003` race backstops. Service boundaries preserve the future Task 7.2 cache seam (D63–D66).
- **Files touched:** shared reference/event contracts; API reference module/controllers/services/errors/DTOs/tests, app wiring, user manager-cleanup regression; web typed client, responsive reference UI/tests and tabs component; authorization inventories; migration/live verifier/root scripts; architecture and handoff
- **Migrations:** `20261025130000_department_location_case_insensitive` adds `departments_name_ci_key`, `departments_code_ci_key`, and `locations_department_id_name_ci_key`. Preflight found zero collisions; the full chain applied to a fresh disposable branch and Neon `dev`; post-apply Prisma diff reported `No difference detected.`
- **Verification:** `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint` and `pnpm typecheck` passed. `pnpm test` passed 24 API suites (191 passed, one intentional Task 7.2 skip) and 16 web files (82 passed), for 273 passing tests. An env-less build correctly failed with the complete required-variable list; the CI-equivalent safe-placeholder `pnpm build` then passed, generated `/admin/reference`, and excluded the test-only RBAC controller. The unclassified-route mutation failed route inventory, and granting STAFF `reference:manage` failed with `Access mismatch for STAFF POST /api/v1/categories: expected DENY, received 201`; both changes were reverted and the focused suite passed. Headless Chromium/Playwright covered populated 360/768/1280 px screens with ignored, identity-safe screenshots; all six were visually inspected with no horizontal overflow. The in-app browser runtime had no browser available, so the permitted repository fallback was used.
- **Live proof:** A fresh disposable Neon child applied the complete chain and guarded seed, then proved eligible manager assign/clear; rejection of STAFF, inactive, seed and other-department candidates; same-transaction audited manager clearing on deactivation; same-department duplicate location rejection and cross-department allowance; exact department/location dependency counts; unchanged machine placement across department rename; clean empty-location deletion; failed-audit rollback; category create/rename/delete through the signed-in UI; and clean protected branches. The branch was deleted. Neon `dev` accepted only the reviewed index migration; `main`, `staging` and `dev` contain no Task 3.2 proof rows.
- **Result:** Task 3.2 acceptance criteria are verified and the checklist is ticked; commit/PR/hosted CI/merge remain in this turn.
- **Progress after this session:** 22 / 71 (31.0%)
- **Left undone / follow-ups:** Task 7.2 owns reference-data cache-aside/invalidation. Machine CRUD remains Task 3.3. Session Log housekeeping was completed now: Task 2.6 was compacted to one historical paragraph, leaving the two Task 3.1 entries and this Task 3.2 entry as the last three full entries without changing checklist, decisions, pending items or known issues.
- **Next task:** 3.3 Machines CRUD API (pagination, filter, search, sort)
- **Branch / commit:** `phase-3/task-3.2-departments-locations-crud` / `feat(reference): add department and location management` (pending)

### [2026-10-25 21:55 EAT] — Task(s): 3.2 — Hosted verification and delivery
- **Prompt summary:** Deliver the verified department/location API, UI, migration and documentation through the complete owned Git workflow and leave the repository ready for Task 3.3.
- **What I did:** Committed the complete implementation as `db4a258`, pushed the task branch, opened PR #32, monitored the required checks, merged only after success, deleted the remote task branch, and synchronized local `main` with `origin/main`.
- **How:** Followed D18. GitHub Actions independently repeated frozen installation, formatting, linting, typechecking, all hermetic tests and the production build; the Supabase Preview integration correctly skipped because the additive expression indexes belong to Prisma/Neon rather than the Supabase database.
- **Files touched:** this handoff only in the delivery follow-up; PR #32 delivered the shared contracts, API/UI, user-manager consistency update, migration, tests, verifier and architecture clarification
- **Migrations:** `20261025130000_department_location_case_insensitive` was delivered only after successful Neon `dev`, fresh-disposable-chain and zero-drift verification
- **Verification:** GitHub `Quality` passed in 1m50s for PR #32; Supabase Preview skipped as expected; PR #32 merged as `0a9e662`; local `main` matched `origin/main` with a clean worktree before this handoff-only update.
- **Result:** Task 3.2 is complete and delivered on `main`.
- **Progress after this session:** 22 / 71 (31.0%)
- **Left undone / follow-ups:** Machine CRUD remains Task 3.3; reference caching remains Task 7.2. The Session Log now retains exactly the last three entries in full (Task 3.1 delivery and the two Task 3.2 entries); older Task 3.1 implementation detail is compacted into one paragraph. Checklist, decisions, pending items and known issues remain intact.
- **Next task:** 3.3 Machines CRUD API (pagination, filter, search, sort)
- **Branch / commit:** `main` / `0a9e662 Merge pull request #32 from nevilndubi/phase-3/task-3.2-departments-locations-crud`

### [2026-10-26 06:16 EAT] — Task(s): 3.3 — Machines CRUD API
- **Prompt summary:** Add only the complete machine registry API with exact shared validation, documented RBAC, stable listing/search/filter/sort, transactional history/audit/service-date handling, concurrency-safe soft deletion, exhaustive hermetic coverage, disposable-Neon evidence and owned Git delivery.
- **What I did:** Added shared create/PATCH/query/ID/tag schemas and DTO contracts; a NestJS machine module with list/create/detail/by-tag/update/soft-delete endpoints and stable errors; atomic first history and audit writes; relation validation, service-due calculation and active-work delete guards; expanded the independent route/access inventory; unit/e2e coverage; and a credential-safe live verifier. No UI or later machine behavior was added.
- **How:** Reads use `machine:read`, registration `machine:create`, PATCH `machine:update`, and DELETE `machine:retire`; the hand-written matrix proves BIOMED_TECH is update-only while DEPT_MANAGER/STAFF/VIEWER are read-only. The database generates immutable tags, and create/identity/delete concurrency is settled by existing constraints plus row locks. PATCH writes supplied fields only and skips audit/timestamp work for semantic no-ops. Soft deletion preserves condition/history/identity and rejects open sessions or active bookings (D67–D70).
- **Files touched:** `packages/shared/src/{machine-management,event-types,index}.ts`; `apps/api/src/machines/*`; API app wiring and authorization inventories; `apps/api/test/machines.e2e-spec.ts`; `scripts/verify-machines-live.ts`; root scripts; architecture and this handoff
- **Migrations:** none. The Task 1.3 schema, sequence/function, constraints and indexes were sufficient; disposable-branch `prisma migrate diff` reported `No difference detected.`
- **Verification:** Frozen install, format check, lint and typecheck passed. `pnpm test` passed 26 API suites/223 tests plus the intentional Task 7.2 skip and 16 web files/82 tests (305 passing total); the production build passed and excluded the test-only RBAC controller. Focused machine/consolidated tests passed 44 plus the sentinel skip. A temporary unclassified machine route failed inventory by naming that route, and a temporary DEPT_MANAGER `machine:update` grant failed with `Access mismatch for DEPT_MANAGER PATCH /api/v1/machines/:id: expected DENY, received 200`; both mutations were reverted.
- **Live proof:** A fresh disposable Neon child applied the complete chain and guarded seed. It proved pagination, every filter, 2-character/name/tag/serial search, stable sorting, due-service filtering, 20 concurrent unique tags continuing after the seed, exactly one row from concurrent identical creates, cross-department placement, case/whitespace identity collision, update/no-op/due recomputation, forbidden condition writes, audited rollback, active-booking/open-session deletion guards, and hidden-but-retained soft deletion. EXPLAIN used the due-date and asset-tag indexes where cost-effective; PostgreSQL preferred sequential scans for selective trigram searches at only 3,060 rows, so no speculative index was added. The branch was deleted and protected `dev`, `staging`, and `main` each had zero proof rows.
- **Result:** Task 3.3 acceptance criteria are verified and the checklist is ticked; commit/PR/hosted CI/merge remain in this turn.
- **Progress after this session:** 23 / 71 (32.4%)
- **Left undone / follow-ups:** The Machines UI is Task 3.4. Tasks 4.2/5.3 must take the matching machine lock before creating work, Tasks 6.2/6.3 own service progression, Task 7.2 owns caching/invalidation, and Task 3.8 owns restore. No migration was needed.
- **Next task:** 3.4 Machines list and detail UI
- **Branch / commit:** `phase-3/task-3.3-machines-crud-api` / `feat(api): add machine registry CRUD` (pending)

### [2026-10-26 06:21 EAT] — Task(s): 3.3 — Hosted verification and delivery
- **Prompt summary:** Deliver the verified machine CRUD API, shared contracts, tests and documentation through the complete owned Git workflow and leave the repository ready for Task 3.4.
- **What I did:** Committed the complete Task 3.3 implementation as `d4d68bb`, pushed the task branch, opened PR #38, monitored the required checks, merged only after success, deleted the remote task branch, and synchronized local `main` with `origin/main`.
- **How:** Followed D18. GitHub Actions independently repeated frozen installation, formatting, linting, typechecking, all hermetic tests and the production build; the Supabase Preview integration correctly skipped because Task 3.3 adds neither a Supabase database change nor a Prisma migration.
- **Files touched:** this handoff only in the delivery follow-up; PR #38 delivered the shared machine contracts, complete API module, tests, live verifier and architecture clarification
- **Migrations:** none; the existing Task 1.3 schema and indexes remained sufficient and the live disposable database reported no drift
- **Verification:** GitHub `Quality` passed in 1m13s for PR #38; Supabase Preview skipped as expected; PR #38 merged as `614aa72`; local `main` matched `origin/main` with a clean worktree before this handoff-only update.
- **Result:** Task 3.3 is complete and delivered on `main`.
- **Progress after this session:** 23 / 71 (32.4%)
- **Left undone / follow-ups:** Machines list/detail UI remains Task 3.4. The Task 4.2/5.3 locking, Task 6.2/6.3 service ownership, Task 7.2 caching, and Task 3.8 restore follow-ups remain recorded in Pending.
- **Next task:** 3.4 Machines list and detail UI
- **Branch / commit:** `main` / `614aa72 Merge pull request #38 from nevilndubi/phase-3/task-3.3-machines-crud-api`

### [2026-10-26 21:57 EAT] — Task(s): Maintenance: dependency sweep
- **Prompt summary:** Triage Dependabot PRs #2, #3, #34–#37 and #39–#42 in risk order; prove higher-risk compatibility, reduce future update noise, preserve the Phase 3 checklist state, and own the complete Git delivery.
- **What I did:** Merged green patch PRs #42 (dotenv), #41 (Vite), #37 (Nest CLI) and #34 (Nest Swagger); locally validated and merged minor PRs #40 (lucide-react) and #39 (react-hook-form); merged #36 (`pg`/`@types/pg`) only after its hosted gate, then ran the live database proof; closed #2 (`@types/node` 26) and #3 (TypeScript 6) with explicit compatibility reasons; and rebased/conflict-resolved #35 (`@hookform/resolvers` 6) onto the current dependency set after Dependabot did not refresh it. The initial repository was clean at `dd6011c`, while §9 still recorded the earlier implementation merge `614aa72`; repository history was trusted and this status was corrected.
- **How:** Every merged dependency first had a green hosted `Quality` check. PRs #40/#39 passed frozen install, format, lint, typecheck, 305 hermetic tests and build locally. Resolver v6 declared peers compatible with react-hook-form 7.90.0 and Zod 4.6.7; its five form-focused files passed 23 tests, the full 305-test suite passed, and hosted Quality passed after the manual refresh. The PostgreSQL upgrade used a credential-safe disposable Neon child: the complete migration chain, `pnpm test:integration`, zero-drift diff and live readiness (`database=up`, overall degraded only because Redis was intentionally unavailable) passed before branch deletion. D71–D72 record the maintenance policy.
- **Files touched:** `.github/dependabot.yml`, dependency manifests/lockfile through the merged Dependabot PRs, and this handoff
- **Migrations:** none; the full existing chain applied to the disposable PostgreSQL branch and `prisma migrate diff` reported `No difference detected.`
- **Verification:** Patch PR Quality durations were #42 1m19s, #41 1m50s, #37 1m52s and #34 1m45s. Minor PR Quality durations were #40 1m51s and #39 1m53s; database PR #36 passed in 1m55s; refreshed resolver PR #35 passed in 1m34s. The updated Dependabot YAML passed Prettier and structural parsing, and `actionlint` 1.7.12 reported the CI workflow valid. On the fully updated dependency tree, frozen install, repository format/lint/typecheck, 305 hermetic tests (plus the intentional Task 7.2 skip) and the production build all passed; maintenance PR delivery remains to be recorded in the delivery follow-up.
- **Result:** All ten requested dependency PRs are resolved: eight merged and two deliberately closed. No Dependabot PR remains open at this point, and Task 3.4 has not started.
- **Progress after this session:** 23 / 71 (32.4%) — unchanged because this is maintenance, not a checklist task.
- **Left undone / follow-ups:** Revisit the Node declaration and TypeScript majors only under the criteria recorded in Pending. Complete the maintenance configuration PR, confirm its hosted and post-merge main CI, and synchronize `main`.
- **Next task:** 3.4 Machines list and detail UI
- **Branch / commit:** `maintenance/dependency-sweep` / pending maintenance commit

### [2026-10-26 22:03 EAT] — Task(s): Maintenance: dependency sweep — hosted delivery
- **Prompt summary:** Deliver the verified dependency-policy and handoff update, confirm hosted and post-merge CI, synchronize `main`, and leave no requested Dependabot PR unresolved.
- **What I did:** Committed the policy/handoff update as `2b9167f`, pushed it, opened PR #44, waited for its required Quality check, merged it only after success as `aac861e`, deleted the task branch, and synchronized local `main`. No checklist item was changed.
- **How:** Followed D18 after completing the risk-ordered dependency merges and D71 policy change. GitHub Actions independently repeated the repository-wide frozen install, format, lint, typecheck, test and build gate.
- **Files touched:** this handoff only in the final delivery follow-up; PR #44 delivered `.github/dependabot.yml` and the maintenance record
- **Migrations:** none
- **Verification:** PR #44 `Quality` passed in 1m20s. The push-to-`main` Quality run for merge `aac861e` passed in 1m37s before this entry was finalized. GitHub reports no open Dependabot PRs.
- **Result:** Maintenance is complete: eight updates merged, two unsupported majors closed with reasons, the future PR policy is active, and `main` is synchronized.
- **Progress after this session:** 23 / 71 (32.4%) — unchanged because this was maintenance, not a checklist task.
- **Left undone / follow-ups:** The two deliberate major-version revisit criteria remain in Pending. Task 3.4 was not started.
- **Next task:** 3.4 Machines list and detail UI
- **Branch / commit:** `main` / `aac861e Merge pull request #44 from nevilndubi/maintenance/dependency-sweep`

---

## 13. KNOWN ISSUES / TECH DEBT

- **Resolved in the 2026-10-26 dependency sweep:** the ten-request Dependabot backlog was reduced to zero by merging eight compatible updates and closing the two unsupported runtime/toolchain-major proposals; future npm minor/patch updates are grouped and capped at five open PRs.
- **Resolved in Task 3.1:** the shell styled every available navigation link as current. It now marks and styles only the route returned by `usePathname()`, with a focused regression assertion and responsive visual proof.
- **Resolved in Task 2.6:** a fixed string CORS origin setting emitted the configured `Access-Control-Allow-Origin` value when a request supplied a different Origin. Exact-origin callback evaluation now omits the header for disallowed origins while retaining server-to-server requests without an Origin; consolidated regression coverage proves both cases.
- **Resolved in Task 2.2:** a private confirmed non-reserved proof identity verified the sequential and concurrent bootstrap behavior on disposable branches; the real owner bootstrap remains an intentional post-Task-2.4 operational step rather than an acceptance blocker.
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
- Live Neon integration still emits a `pg-connection-string` warning after the verified `pg` 8.23.1 update: `sslmode=require` is treated as `verify-full` today but will adopt weaker libpq semantics in its next major version. Current TLS verification remains strict; before upgrading to `pg` 9 / `pg-connection-string` 3, change managed connection URLs to explicit `sslmode=verify-full` or deliberately opt into libpq compatibility.
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
| `NEON_PROJECT_ID` | Task 1.7 / 2.5 verification helpers | Explicit live verification only | Non-secret Neon project identifier; connection output remains captured |
| `REDIS_URL` | api | Development default; required in production | Redis connection; production must use `rediss://` |
| `SUPABASE_URL` | api | Yes | Supabase project URL; source for the derived issuer/JWKS endpoints |
| `SUPABASE_SECRET_KEY` | api only | Yes | Modern server-side administration/storage key — never expose or print |
| `SUPABASE_JWT_ISSUER` | api | No (derived) | Optional explicit issuer; must equal `SUPABASE_URL/auth/v1` |
| `SUPABASE_JWKS_URL` | api | No (derived) | Optional explicit JWKS URL; must equal the project well-known endpoint |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | api only | One-off bootstrap only | Confirmed real first-administrator address; ignored after an active non-seed SUPER_ADMIN exists; never use or log a seed/`.invalid` address |
| `API_BASE_URL` | web server | Yes | Server-side API location |
| `NEXT_PUBLIC_API_URL` | web public | Yes | Browser-visible API location |
| `NEXT_PUBLIC_SUPABASE_URL` | web public | Yes | Browser-visible Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | web public | Yes | Modern browser-safe Supabase key; never substitute a server secret |
| `SUPABASE_AUTH_TEST_EMAIL` | ignored Task 2.1 proof file | Live proof only | Dedicated non-staff confirmed test identity; never print it |
| `SUPABASE_AUTH_TEST_PASSWORD` | ignored Task 2.1 proof file | Live proof only | Dedicated test password; never print it |
| `SUPABASE_AUTH_PROOF_ENV_FILE` | Task 2.1 verifier | No | Optional path override for the ignored proof credential file |
| `RESEND_API_KEY` | api | No (Phase 9) | Email provider key |
| `SENTRY_DSN` | api, web server | No (Phase 11) | Error tracking destination |

**Commands:**
- Install: `pnpm install`
- Create local API environment: `cp apps/api/.env.example apps/api/.env`
- Create local web environment: `cp apps/web/.env.example apps/web/.env.local`
- Run all workspaces in development: `pnpm dev`
- Run only the web app in development: `pnpm --filter @app/web dev`
- Run only the API in development: `pnpm --filter @app/api dev`
- Start local Redis: `docker compose up -d redis`
- Check local Redis: `docker compose ps redis`
- Stop local Redis: `docker compose stop redis`
- Remove local Redis resources: `docker compose down`
- Build shared, web and API: `pnpm build`
- Verify the API production build excludes test-only RBAC controllers: `pnpm build` (automatic final assertion)
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
- Run the credential-safe hosted Auth proof: `pnpm verify:supabase:auth`
- Run the credential-safe Task 2.5 invite/bootstrap/browser proof: `NEON_PROJECT_ID=<project-id> pnpm verify:users:live`
- Run the credential-safe Task 3.1 category migration/seed/CRUD proof: `NEON_PROJECT_ID=<project-id> pnpm verify:categories:live`
- Run the credential-safe Task 3.2 migration/seed/CRUD/UI proof: `NEON_PROJECT_ID=<project-id> pnpm verify:reference:live`
- Run the credential-safe Task 3.3 machine API/concurrency/query-plan proof: `NEON_PROJECT_ID=<project-id> pnpm verify:machines:live`
- List Supabase identity IDs without matching Neon users (read-only, never addresses): `pnpm users:reconcile-auth`
- Run API unit tests: `pnpm --filter @app/api test:unit`
- Run API e2e tests: `pnpm --filter @app/api test:e2e`
- Run web unit/component tests: `pnpm --filter @app/web test`
- Validate GitHub Actions workflows: `actionlint .github/workflows/ci.yml` (actionlint must be installed separately)

**API operational endpoints:**
- Liveness: `GET /health`
- Readiness: `GET /health/ready`
- Authenticated local profile: `GET /api/v1/me`
- User list/search: `GET /api/v1/users`
- User-management department choices: `GET /api/v1/users/departments`
- Invite/provision user: `POST /api/v1/users`
- Edit user role/department/name: `PATCH /api/v1/users/:id`
- Deactivate/reactivate user: `POST /api/v1/users/:id/deactivate`, `POST /api/v1/users/:id/reactivate`
- List/create categories: `GET /api/v1/categories`, `POST /api/v1/categories`
- Read/update/delete a category: `GET /api/v1/categories/:id`, `PATCH /api/v1/categories/:id`, `DELETE /api/v1/categories/:id`
- List/create departments: `GET /api/v1/departments`, `POST /api/v1/departments`
- Read/update/delete a department: `GET /api/v1/departments/:id`, `PATCH /api/v1/departments/:id`, `DELETE /api/v1/departments/:id`
- List eligible managers: `GET /api/v1/departments/:id/eligible-managers`
- List/create locations: `GET /api/v1/locations`, `POST /api/v1/locations`
- Read/update/delete a location: `GET /api/v1/locations/:id`, `PATCH /api/v1/locations/:id`, `DELETE /api/v1/locations/:id`
- List/register machines: `GET /api/v1/machines`, `POST /api/v1/machines`
- Read a machine by asset tag: `GET /api/v1/machines/by-tag/:assetTag`
- Read/update/remove a machine from the active registry: `GET /api/v1/machines/:id`, `PATCH /api/v1/machines/:id`, `DELETE /api/v1/machines/:id`
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
