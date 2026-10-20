# PHASE GUIDE — Hospital Equipment Tracking & Booking System

Companion to `project_model_handoff.md` (rules, progress) and `docs/ARCHITECTURE.md` (design).
Task IDs match the checklist in the handoff file. **Build one task per prompt, in order.**

Each task lists **Depends on**, **Do** (what to build), and **Done when** (acceptance criteria). A task is only complete when its Done-when items are verified **and** the Definition of Done in the handoff file (§15) is met.

---

## How the owner drives this (prompt cheat-sheet)

| Intent | Prompt |
|---|---|
| Normal step | `Do task 3.3.` |
| Continue | `Continue with the next task.` (agent picks the first unchecked task with met prerequisites) |
| Split a big task | `Do the API half of 3.4 only.` |
| Fix | `Fix: <what you saw>. Log it in Known Issues.` |
| Review | `Review phase 4 against its acceptance criteria and tick/untick honestly.` |
| Resync | `Audit the repo against the handoff file and correct the file.` |

The agent already knows the scope and rules from the handoff file. Short prompts are expected.

---

# PHASE 0 — Foundation & Tooling
*Goal: an empty but professional skeleton that builds, lints, tests and deploys nothing yet.*

### 0.1 Monorepo scaffold
- **Depends on:** —
- **Do:** Initialise git; pnpm workspace with `apps/web` (Next.js App Router, TS), `apps/api` (NestJS, TS), `packages/shared` (TS library, builds to CJS+ESM or consumed via TS path/`tsup`). Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`. Node version pinned (`.nvmrc` / `engines`). `.gitignore`, `README` stub.
- **Done when:** `pnpm install && pnpm build` succeeds from a clean clone; web and api both import a trivial exported constant from `@app/shared`.

### 0.2 Code quality tooling
- **Depends on:** 0.1
- **Do:** TS `strict` + `noUncheckedIndexedAccess` everywhere; shared ESLint config; Prettier; Husky + lint-staged (pre-commit); commitlint (conventional commits); `.editorconfig`.
- **Done when:** a bad commit message is rejected; a lint error blocks commit; `pnpm lint` and `pnpm typecheck` pass repo-wide.

### 0.3 Env management & validation
- **Depends on:** 0.1
- **Do:** Zod-validated env schema per app (fail fast on boot with readable errors). `.env.example` for each app with every variable from handoff §14 (no real values). Never expose server secrets to the web bundle.
- **Done when:** starting either app with a missing required var exits with a clear message; `.env.example` is complete.

### 0.4 API bootstrap
- **Depends on:** 0.2, 0.3
- **Do:** Config module; global `ValidationPipe`/Zod pipe; standard error filter producing `{error:{code,message,details,requestId}}`; request-ID middleware; pino logger; Swagger at `/api/docs`; versioned prefix `/api/v1`; `GET /health` (liveness) and `GET /health/ready` (stub: DB/Redis added later); global response envelope helpers; graceful shutdown hooks.
- **Done when:** `/health` returns 200; an invalid request returns the standard 400 shape with a requestId; Swagger renders; an e2e test covers health + error shape.

### 0.5 Web bootstrap
- **Depends on:** 0.2, 0.3
- **Do:** Tailwind + shadcn/ui; app shell (sidebar/topbar, responsive), theme tokens including **status colours** (available, in-use, needs-service, maintenance, out-of-service, retired) each with an icon; TanStack Query provider; typed API client wrapper (base URL, auth header injection placeholder, error normalisation); global error and loading boundaries; `/` placeholder page.
- **Done when:** shell renders at 360px, 768px and 1280px; the API client can call `/health` and show the result on a temporary page.

### 0.6 CI pipeline
- **Depends on:** 0.2
- **Do:** GitHub Actions: install (cached), lint, typecheck, test, build for all workspaces on PR and `main`; Dependabot config; PR template with checklist; branch protection notes in README.
- **Done when:** a PR runs all jobs green; a deliberate lint failure turns CI red.

### 0.7 Local dev services & Redis skeleton
- **Depends on:** 0.4
- **Do:** `docker-compose.yml` with Redis; `RedisModule` (ioredis provider, config via env, TLS option, connection events logged, graceful close); extend `/health/ready` to ping Redis (status `degraded` not `down` if Redis fails — Postgres check added in 1.1). No caching logic yet.
- **Done when:** `docker compose up -d` + API boot shows Redis connected; stopping Redis flips `/health/ready` to `degraded` without crashing the API.

---

# PHASE 1 — Database & Schema
*Goal: the complete, constraint-rich data model on Neon, migrated and seeded.*

### 1.1 Prisma + Neon setup
- **Depends on:** 0.4
- **Do:** Prisma in `prisma/`; datasource uses `DATABASE_URL` (pooled) + `DIRECT_URL` (direct); `PrismaModule`/`PrismaService` with lifecycle hooks; Neon branches `dev`, `staging`, `main` documented; add DB check to `/health/ready`; scripts `prisma:migrate:dev`, `prisma:migrate:deploy`, `prisma:generate`, `db:seed`.
- **Done when:** an empty initial migration applies to the `dev` branch; `/health/ready` reports DB ok; README documents Neon branch workflow.

### 1.2 Core tables: users, departments, locations
- **Depends on:** 1.1
- **Do:** Models + enums (`Role`) per ARCHITECTURE §3; relations; unique constraints; `updated_at` handling; first real migration.
- **Done when:** migration applies cleanly to a fresh DB; Prisma client types generated; a unit/integration test inserts and reads each model.

### 1.3 Machine tables
- **Depends on:** 1.2
- **Do:** `machine_categories`, `machines` (all fields incl. condition enum, booking-policy flags, service fields, soft delete), `machine_status_history`. Indexes from ARCHITECTURE §3.2 (including search index via `pg_trgm` in a raw SQL migration).
- **Done when:** constraints verified by tests (unique asset tag, unique serial per manufacturer, enum validity).

### 1.4 Usage & booking tables with overlap constraint
- **Depends on:** 1.3
- **Do:** `usage_sessions` with **partial unique index** (one open session per machine); `bookings` with status enum, `CHECK (ends_at > starts_at)`, and the `EXCLUDE USING gist` constraint in a **hand-written SQL migration** (`btree_gist`). Decide and log how `buffer_minutes` is enforced (extended range vs `blocked_until`).
- **Done when:** integration tests prove: overlapping `CONFIRMED` bookings on one machine are rejected with `23P01`; adjacent windows (end == next start) are allowed; `CANCELLED`/`REJECTED` bookings don't block; a second open session on the same machine is rejected; different machines never conflict.

### 1.5 Service tables
- **Depends on:** 1.3
- **Do:** `service_tickets`, `service_records`, `maintenance_schedules` with enums and indexes.
- **Done when:** migration clean; relations tested; cost stored as integer minor units with currency default `KES`.

### 1.6 Support tables
- **Depends on:** 1.2
- **Do:** `audit_logs` (append-only: revoke UPDATE/DELETE for the app role if feasible, else document), `notifications`, `notification_preferences`, `attachments`, `app_settings` with default rows (max booking minutes, lead time, no-show grace, ad-hoc guard minutes).
- **Done when:** migration clean; default settings seeded idempotently.

### 1.7 Indexes, seed & migration review
- **Depends on:** 1.4, 1.5, 1.6
- **Do:** Review all indexes against expected queries; write `prisma/seed.ts` (idempotent): 5 departments, ~20 locations, 8 categories (ventilator, infusion pump, patient monitor, ultrasound, X-ray, defibrillator, ECG, dialysis, etc.), ~60 machines with mixed conditions, sample usage sessions and bookings, sample tickets, one user per role (placeholders until Supabase links in 2.2). Document `migrate reset` is **dev-only**.
- **Done when:** `pnpm db:seed` is re-runnable without duplicates; fresh DB → migrate → seed works in CI; schema docs in ARCHITECTURE match reality.

---

# PHASE 2 — Authentication & Authorization
*Goal: only the right people can do the right things.*

### 2.1 Supabase Auth setup
- **Depends on:** 1.2
- **Do:** Document and apply Supabase project config: email/password (+ magic link optional), disable public sign-ups (invite-only), redirect URLs per env, JWT settings. Add Supabase env vars. Create `docs/SUPABASE_SETUP.md`.
- **Done when:** a test user can sign in via Supabase and receive a JWT; steps are reproducible from the doc.

### 2.2 API JWT guard & user provisioning
- **Depends on:** 2.1, 1.2
- **Do:** Global `AuthGuard` verifying Supabase JWT via JWKS (cache keys); `@Public()` decorator; `CurrentUser` decorator; on first valid token link/provision `users` row (match by `supabase_user_id`, else by invited email); reject inactive users (403 `USER_INACTIVE`); `GET /me`; Redis-cached user lookup comes later in 7.2 (use DB now).
- **Done when:** no token → 401; expired/forged token → 401; valid token → `/me` returns role & department; tests cover each case.

### 2.3 RBAC
- **Depends on:** 2.2
- **Do:** Permission map in `packages/shared/permissions.ts` per ARCHITECTURE §7; `@RequirePermission()` decorator + guard; department-scoped checks helper (for `DEPT_MANAGER`); unit tests asserting the full matrix.
- **Done when:** a table-driven test iterates every role × permission and matches the matrix exactly.

### 2.4 Web auth
- **Depends on:** 2.2, 0.5
- **Do:** Login page (Supabase), logout, session refresh, Next middleware protecting `(app)` routes, API client attaches token, 401 → redirect to login, role-aware nav using the shared permission map, `/me` bootstrapping context.
- **Done when:** unauthenticated visit redirects to login; after login the user lands on the dashboard shell; STAFF does not see admin links; hard-navigating to a forbidden route shows a 403 page.

### 2.5 User management
- **Depends on:** 2.3, 2.4
- **Do:** Admin UI + API: list/search users, invite by email (creates `users` row + Supabase invite), assign role & department, deactivate/reactivate. Rules: ADMIN cannot create/modify SUPER_ADMIN; cannot deactivate yourself; last SUPER_ADMIN protected.
- **Done when:** all rules enforced and tested (403/409 paths); changes immediately effective on next request.

### 2.6 Auth/RBAC test suite
- **Depends on:** 2.5
- **Do:** Consolidated e2e: every protected route family returns 401/403 appropriately for each role; verify no endpoint is accidentally public (test that enumerates routes and asserts guard coverage).
- **Done when:** the route-coverage test fails if someone adds an unguarded route.

---

# PHASE 3 — Machine Registry
*Goal: a complete, searchable inventory of machines.*

### 3.1 Categories CRUD
- **Depends on:** 2.3
- **Do:** API + UI for categories (name, description, default service interval, default max booking). Block delete when machines reference it (409 with count).
- **Done when:** CRUD works with permissions (ADMIN+), validation errors surface in the form, tests pass.

### 3.2 Departments & locations CRUD
- **Depends on:** 2.3
- **Do:** API + UI; locations belong to departments; assign department manager; block deletes with dependants.
- **Done when:** CRUD + referential rules tested; reference data endpoints are ready for caching later.

### 3.3 Machines CRUD API
- **Depends on:** 3.1, 3.2
- **Do:** `GET /machines` with pagination, filters (department, category, location, condition, bookable, service-due), full-text/trigram search (name, asset tag, serial), sorting; `POST`, `GET :id`, `PATCH`, `DELETE` (soft); auto-generated asset tag sequence `HM-000001` (unique, race-safe); `GET /machines/by-tag/:assetTag`. Condition **cannot** be changed through PATCH (reserved for the 4.1 endpoint).
- **Done when:** filters/search/pagination verified with the seed dataset; duplicates return 409; PATCH rejects `condition`; DTOs never leak internal fields.

### 3.4 Machines UI
- **Depends on:** 3.3, 0.5
- **Do:** List (table + cards, filters, search, pagination, URL-synced state), detail page (tabs: Overview, Status, Bookings, Service, Files, History — only Overview functional now, others placeholders), create/edit forms with shared Zod schemas, empty/error/loading states.
- **Done when:** a technician can add and edit a machine end-to-end; mobile layout usable; Playwright smoke test added.

### 3.5 Attachments
- **Depends on:** 3.4, 2.1
- **Do:** Private Supabase Storage bucket; API issues signed upload URLs after validating type (jpg/png/webp/pdf) and size (≤10MB); records `attachments` row on confirm; signed download URLs ≤5 min; UI gallery/list with delete (permissioned).
- **Done when:** upload/download/delete works; disallowed types and oversize files rejected server-side; no public URLs exist.

### 3.6 Asset tags & QR labels
- **Depends on:** 3.3
- **Do:** Generate QR code encoding `https://<web>/scan/<assetTag>`; printable label sheet (PDF or print-CSS) per machine and in bulk; `/scan/[assetTag]` page: resolves the machine, shows live status and **contextual actions** (Check out / Check in / Book / Report a fault) — actions wired in later phases (disabled with tooltip until then).
- **Done when:** scanning a printed label on a phone opens the right machine after login; invalid tags show a friendly not-found.

### 3.7 Bulk CSV import
- **Depends on:** 3.3
- **Do:** Upload CSV (template downloadable); server-side parse + row-level validation; **dry-run mode** returning per-row errors/warnings; commit only if no blocking errors (or "import valid rows" option); resolves category/department/location by name; idempotent on serial number; 1,000-row limit; audit marker.
- **Done when:** a messy sample CSV yields a clear error report; a clean CSV imports and rerunning doesn't duplicate.

### 3.8 Retire / soft-delete & restore
- **Depends on:** 3.3, 4.1 (condition `RETIRED` semantics) — *implement the delete/restore mechanics now; wire to condition machine in 4.1*
- **Do:** Soft delete hides from default lists; "Show retired/deleted" filter for Admin; restore endpoint (Admin); block when machine has future confirmed bookings or open session (409 with details).
- **Done when:** rules tested; history preserved; bookings/tickets of retired machines remain viewable.

---

# PHASE 4 — Status: Usage & Condition
*Goal: answer the core question instantly — "is it in use, and if not, is it fine?"*

### 4.1 Condition state machine + history
- **Depends on:** 1.3, 2.3
- **Do:** `ConditionService.transition(machineId, to, {reason, source, ticketId?, actor})` enforcing the allowed-transition table (ARCHITECTURE §4.1) inside a DB transaction with row lock; writes `machine_status_history`; blocks transitions to maintenance/out-of-service/retired while a session is open (unless forced by Admin/Manager with reason); `POST /machines/:id/condition`; `GET /machines/:id/history`. Publishes an internal event hook (no Redis publish yet — stub).
- **Done when:** table-driven tests cover every allowed and disallowed transition; concurrent transitions don't corrupt state; history is complete and ordered.

### 4.2 Usage sessions: check-out / check-in
- **Depends on:** 4.1
- **Do:** `POST /machines/:id/check-out` {expectedEndAt?, purpose?} and `POST /machines/:id/check-in` {note?}; enforce: machine condition allows use, no open session (unique index is the last line of defence → map to 409 `MACHINE_IN_USE` with current user and since), ad-hoc guard against imminent bookings by others (setting-driven), only the holder or a permitted role can check in/force-end; purpose max 200 chars with PHI warning.
- **Done when:** parallel check-outs → exactly one succeeds; forced end requires reason and is recorded; tests cover each rule.

### 4.3 Live status service
- **Depends on:** 4.1, 4.2
- **Do:** `StatusService` computing display status per ARCHITECTURE §4.3 (priority order); `GET /machines/:id/status`; `GET /status/board` returning a compact list with filters (department, category, location, status) and counts per status; efficient single-query implementation (no N+1) — verify with query logging.
- **Done when:** the seed dataset produces expected statuses; the board for ~500 machines responds in a single query under target latency in a local benchmark; tests cover every status and priority conflict (e.g. in-use + needs-service shows **In use**).

### 4.4 Status board UI
- **Depends on:** 4.3, 0.5
- **Do:** `/status` page: summary chips with counts, grid/table toggle, filters, search, each card shows name, asset tag, location, **status (icon + text + colour)**, holder & since / expected end when in use, "needs service" indicator, next booking time. Inline quick actions per permission (Check out / Check in / Book / Report — wired as their features land). Auto-refresh by polling every 30s for now (SSE in 7.4).
- **Done when:** correct at 360/768/1280px; colour-blind-safe (icon+text); keyboard navigable; Playwright test asserts statuses against seeded data.

### 4.5 Machine detail: status panel & timeline
- **Depends on:** 4.4
- **Do:** Status panel on the detail page with current state, holder, and condition controls (for permitted roles; reason required); timeline combining status history, usage sessions and (later) service events.
- **Done when:** timeline order and content verified against seeded and live data; unauthorised users see no controls and API rejects attempts.

---

# PHASE 5 — Booking Engine
*Goal: reliable, conflict-free reservations.*

### 5.1 Booking rules & config
- **Depends on:** 1.4, 1.6
- **Do:** `BookingPolicyService` resolving effective rules (machine override → category default → app setting): max duration, minimum lead time, max advance window (e.g. 60 days), buffer minutes, operating hours (optional), approval requirement, bookable flag/condition rule. Admin UI for global settings; machine-level overrides on the machine form.
- **Done when:** policy resolution unit-tested for each precedence level; invalid windows produce specific error codes (`BOOKING_TOO_LONG`, `BOOKING_TOO_SOON`, `MACHINE_NOT_BOOKABLE`, …).

### 5.2 Availability query
- **Depends on:** 5.1
- **Do:** `GET /machines/:id/availability?from&to` returns busy blocks (confirmed/pending/in-progress incl. buffers), free windows, and maintenance/out-of-service blocks; `GET /availability/search?start&end&category&department` to find free machines for a window.
- **Done when:** results are correct at boundaries (adjacent bookings, buffers, timezone/DST-free Nairobi but UTC-stored), tested with fixtures.

### 5.3 Create booking
- **Depends on:** 5.1, 5.2
- **Do:** `POST /bookings` — validate policy; insert inside a transaction; **rely on the exclusion constraint**; map `23P01` → `409 BOOKING_CONFLICT` with the conflicting window; status `CONFIRMED` or `PENDING` per machine; support `Idempotency-Key` (DB-backed for now, Redis in 7.x); user may not exceed N active bookings (setting).
- **Done when:** a single-slot race of ≥20 parallel requests yields exactly 1 success and 19 clean 409s; idempotent retry returns the same booking.

### 5.4 Modify / cancel / approve / reject
- **Depends on:** 5.3
- **Do:** Reschedule (re-validate + constraint), cancel (requester or manager/admin; reason; late-cancel flagged), approve/reject (DEPT_MANAGER for own department machines, ADMIN) with notes; all transitions via a booking state machine with tests.
- **Done when:** illegal transitions rejected; permissions enforced; rescheduling into a conflict leaves the original booking intact.

### 5.5 Booking ↔ check-in link, no-show, ad-hoc rule
- **Depends on:** 5.3, 4.2
- **Do:** Checking out with a `CONFIRMED` booking in its window links the session and moves booking to `IN_PROGRESS`; check-in completes it; early/late grace (setting); expose "check in now" from booking card; implement the **no-show sweep as a pure function/service** (scheduled by the worker in 9.2) that marks lapsed bookings `NO_SHOW`; ad-hoc check-out blocked when another user's confirmed booking starts within the guard window.
- **Done when:** end-to-end flow book → check-out → check-in tested; the sweep function tested with a fake clock.

### 5.6 Booking UI
- **Depends on:** 5.4, 5.5, 4.4
- **Do:** Machine calendar (day/week timeline, busy blocks, click-drag to select a slot, inline conflict feedback); booking dialog (purpose with PHI warning); "My bookings" (upcoming/past, cancel/reschedule); manager "Approvals" queue; "Find a free machine" search (by category/time).
- **Done when:** a STAFF user can book, reschedule and cancel; a manager can approve/reject; conflicts show a friendly message with alternatives; Playwright covers the happy path and a conflict.

### 5.7 Concurrency & edge-case suite
- **Depends on:** 5.6
- **Do:** Dedicated tests: parallel booking races, back-to-back bookings, booking during maintenance, machine goes `OUT_OF_SERVICE` after booking (flag—handled in 6.5), cancel-then-rebook same slot, boundary timestamps, long-window rejection, approval race (two managers approve simultaneously).
- **Done when:** suite is deterministic (no flaky sleeps) and runs in CI.

---

# PHASE 6 — Service & Maintenance
*Goal: faults get reported, tracked and resolved; the status board reflects reality.*

### 6.1 Fault reporting
- **Depends on:** 4.1, 2.3
- **Do:** `POST /machines/:id/faults` for any authenticated non-viewer: title, description, severity, optional photos (3.5), "machine unsafe to use" checkbox. Creates `service_ticket` (`FAULT`, `OPEN`); duplicates (open fault ticket same machine) offered as "add to existing". `CRITICAL`/"unsafe" immediately transitions the machine to `OUT_OF_SERVICE`; `HIGH`/`MEDIUM` → `NEEDS_SERVICE` (rules configurable constants, documented).
- **Done when:** reporting works from the machine page, the scan page and the check-in dialog; condition changes go through `ConditionService` with source `SERVICE_TICKET`.

### 6.2 Ticket lifecycle & condition coupling
- **Depends on:** 6.1
- **Do:** Ticket state machine (assign, start, resolve, close, cancel) with permissions (BIOMED_TECH/ADMIN); `start` moves the machine to `UNDER_MAINTENANCE`; `resolve` requires a `service_record` (work done, parts, optional cost in KSh, next due) and returns the machine to `OPERATIONAL` (or `OUT_OF_SERVICE` if unrepairable) via `ConditionService`; `close` finalises; comments/notes thread.
- **Done when:** every transition tested; the machine's displayed status always matches the ticket state; illegal transitions rejected.

### 6.3 Preventive maintenance schedules
- **Depends on:** 6.2
- **Do:** Per-machine/category intervals → `maintenance_schedules`; `next_service_due_at` computed from last serviced + interval; due/overdue flags in status; a `PreventiveService.generateDue()` function (scheduled in 9.2) creating `PREVENTIVE` tickets without duplicates; completing a preventive ticket resets the schedule.
- **Done when:** due calculation tested incl. overdue and interval changes; idempotent generation proven by running twice.

### 6.4 Service history & downtime
- **Depends on:** 6.2
- **Do:** Service history tab on machine detail; compute downtime per machine/period from `machine_status_history` (time in `UNDER_MAINTENANCE`/`OUT_OF_SERVICE`); MTTR and fault frequency helpers for reports.
- **Done when:** downtime math tested with fixtures spanning period boundaries.

### 6.5 Impact handling
- **Depends on:** 6.2, 5.4
- **Do:** When a machine becomes `OUT_OF_SERVICE`/`UNDER_MAINTENANCE`, find future `CONFIRMED/PENDING` bookings in the affected window → mark `needs_attention` (flag/reason), notify requesters (in-app now; email in Phase 9) and offer "find alternative machine" using 5.2 search; do **not** silently cancel. Admin/manager can bulk-cancel with reason.
- **Done when:** affected bookings are listed on the ticket and in "My bookings" with a warning; tests cover the flagging logic.

### 6.6 Service UI
- **Depends on:** 6.2, 6.3
- **Do:** Report-fault flow (mobile-first), technician ticket board (Kanban by status + list), ticket detail (timeline, record form, attachments), schedules view with due/overdue filters, "Needs service" quick filter on the status board.
- **Done when:** a technician can take a fault from report to closed, and the status board reflects each step live (via polling for now).

---

# PHASE 7 — Redis Caching & Realtime
*Goal: fast reads, live updates, and abuse protection — without compromising correctness.*

### 7.1 Cache service
- **Depends on:** 0.7
- **Do:** `CacheService` (`get/set/del/wrap`) with JSON serialisation, env-prefixed namespaced keys (ARCHITECTURE §6), mandatory TTL, error swallowing with logging, simple circuit breaker, optional versioned-key invalidation helper; metrics counters (hit/miss/error).
- **Done when:** unit tests prove: miss→loader→set; Redis error → loader still returns; breaker opens/closes; no key can be set without TTL.

### 7.2 Cache board, detail, reference & user lookups
- **Depends on:** 7.1, 4.3, 3.3, 2.2
- **Do:** Apply cache-aside to: status board (15–30s), machine detail, reference data, availability grid, user/role lookup (60s). Wire **invalidation on every relevant write** (condition change, check-in/out, booking changes, machine edits, ref-data CRUD, role changes). Centralise invalidation in one `CacheInvalidator` called by services — not scattered.
- **Done when:** integration tests show a write is visible on the next read (no stale data beyond the TTL contract); stopping Redis leaves all endpoints correct; before/after latency recorded in the handoff log.

### 7.3 Redis-backed rate limiting
- **Depends on:** 7.1
- **Do:** Nest throttler with Redis storage; global default plus stricter limits for login-adjacent, booking create, check-out, CSV import and file-sign endpoints; `429` with standard error shape and `Retry-After`; per-user when authenticated, per-IP otherwise.
- **Done when:** limits verified by tests; limits are env-configurable; behaviour when Redis is down is explicit (fail-open for reads, fail-closed for none — document choice).

### 7.4 Pub/Sub + SSE realtime
- **Depends on:** 7.2, 4.4
- **Do:** `EventsService.publish()` called after commits (condition, usage, booking, ticket); Redis pub/sub fan-out; `GET /stream` SSE endpoint (auth via header/cookie-safe approach, heartbeat 25s, `Last-Event-ID`, per-user connection cap); events carry IDs only; web hook `useLiveUpdates()` invalidates TanStack Query keys; fallback to 30s polling if SSE drops; board and detail pages update without refresh.
- **Done when:** two browser sessions show a check-out in <2s; killing the SSE connection falls back to polling and recovers; no sensitive data in events (asserted in test).

### 7.5 Booking contention helper
- **Depends on:** 5.3, 7.1
- **Do:** Optional short Redis lock per machine around booking creation to smooth contention + Redis-backed idempotency keys (replace DB-backed). If Redis is unavailable, skip the lock and rely on the DB constraint.
- **Done when:** race suite (5.7) still passes with Redis on **and** off; idempotent replay works from Redis.

### 7.6 Cache metrics & failure-mode tests
- **Depends on:** 7.2, 7.4
- **Do:** Expose hit ratio, errors, SSE client count (auth-protected `/metrics` or logs); chaos tests: Redis down at boot, Redis dying mid-request, Redis flush; tune TTLs from measured data; document final TTL table in ARCHITECTURE §6.
- **Done when:** all failure-mode tests pass; ARCHITECTURE reflects final TTLs.

---

# PHASE 8 — Dashboard & Reports
*Goal: management visibility.*

### 8.1 KPI queries
- **Depends on:** 6.4, 5.7
- **Do:** Services for: machines by status; availability % (time not in maintenance/OOS ÷ period); utilisation % (booked/in-use hours ÷ available hours); overdue services; upcoming services (7/30 days); bookings per day/department; no-show rate; top faulty machines; mean time to repair. Efficient SQL (aggregates/materialised or cached 60–300s via 7.1).
- **Done when:** KPIs tested against fixtures with hand-calculated expectations; queries have supporting indexes.

### 8.2 Dashboard UI
- **Depends on:** 8.1
- **Do:** KPI cards, status donut/bars, trend charts (utilisation, faults), "needs attention" lists (overdue service, long-running sessions, pending approvals, affected bookings). Date-range selector, department filter.
- **Done when:** loads <1.5s on seed data; accessible chart alternatives (tables/labels).

### 8.3 Reports & export
- **Depends on:** 8.1
- **Do:** Reports: inventory register, utilisation by machine/department, downtime & service history, booking log, upcoming maintenance. CSV for all; PDF for inventory register and service history. Server-side generation, size-limited, permissioned, audited.
- **Done when:** exports open correctly in Excel; row counts match the UI; permissions enforced.

### 8.4 Department-scoped views
- **Depends on:** 8.2
- **Do:** `DEPT_MANAGER` sees their department by default and cannot query others' reports; ADMIN/BIOMED_TECH see all.
- **Done when:** scoping enforced in the API (not just hidden in UI) and tested.

---

# PHASE 9 — Notifications & Background Jobs
*Goal: the system acts on time without anyone watching it.*

### 9.1 BullMQ & worker process
- **Depends on:** 0.7
- **Do:** BullMQ queues on Redis; separate worker entrypoint (`WORKER=true` or `main.worker.ts`) deployable independently; retry/backoff, dead-letter handling, job-failure logging, Bull Board (Admin-only, optional); graceful shutdown.
- **Done when:** a sample job runs in the worker; failed jobs retry then land in failed set; worker restarts cleanly.

### 9.2 Scheduled jobs
- **Depends on:** 9.1, 5.5, 6.3
- **Do:** Repeatable jobs with fixed IDs: `booking-reminder`, `booking-no-show-sweep`, `overdue-checkout-alert`, `service-due-sweep`, `warranty-expiry-alert` (ARCHITECTURE §9). All idempotent; each emits cache invalidation + realtime events when state changes.
- **Done when:** jobs verified with a fake clock; running twice has no duplicate effects; multiple workers don't double-fire.

### 9.3 Email + in-app notifications
- **Depends on:** 9.2
- **Do:** `NotificationService` writes in-app notifications and enqueues emails (Resend, templated, plain + HTML); bell icon with unread count (SSE-updated); mark read/all read; email contains no PHI.
- **Done when:** each notification type has a template and test; emails retried on failure and logged (`emailed_at`).

### 9.4 Notification preferences
- **Depends on:** 9.3
- **Do:** Per-user, per-type in-app/email toggles; sensible defaults; critical alerts (out-of-service on a booked machine) can't be fully disabled.
- **Done when:** preferences respected by the dispatcher (tested); settings page works.

---

# PHASE 10 — Audit & Hardening
*Goal: trustworthy and safe to run in a hospital.*

### 10.1 Audit trail
- **Depends on:** all mutating modules
- **Do:** Interceptor/service recording who/what/when/before/after for machines, condition, bookings, tickets, users/roles, settings, imports, exports; redact sensitive fields; Admin UI with filters and entity-level "History"; replace earlier `// AUDIT:` TODOs.
- **Done when:** every mutation endpoint is audited (a test enumerates mutating routes and asserts an audit entry); the log is append-only.

### 10.2 Security hardening
- **Depends on:** 10.1
- **Do:** Helmet; strict CORS; body-size limits; upload allow-lists; security headers on web (CSP, frame-ancestors, referrer-policy); cookie flags; `pnpm audit` + Dependabot in CI; secret scanning; remove Swagger from prod or gate by Admin; verify service-role key never reaches the client bundle (build-time check).
- **Done when:** a security checklist in `docs/SECURITY.md` is complete with evidence; ZAP/baseline scan has no high findings.

### 10.3 RBAC & data-exposure review
- **Depends on:** 10.2
- **Do:** Walk every endpoint vs the permission matrix; confirm DTOs expose minimum fields (e.g. STAFF see holder **name** only); grep/search for any PHI-capable fields in logs, caches, events and exports; fix gaps.
- **Done when:** a written review in `docs/SECURITY.md` with each endpoint ticked; automated test suite from 2.6 updated.

### 10.4 Backup & restore
- **Depends on:** 1.7
- **Do:** Document Neon PITR/retention; perform and record a restore drill to a new branch; document RPO/RTO; document Redis as disposable (no restore needed); export script for periodic logical backup (optional).
- **Done when:** the drill is performed and timed; `docs/RUNBOOK.md` section written.

### 10.5 Accessibility & responsive pass
- **Depends on:** UI phases
- **Do:** Axe audit on key pages; keyboard and screen-reader checks for booking calendar and status board; contrast checks on status colours; touch targets ≥44px; fix issues.
- **Done when:** no critical/serious axe violations on the main journeys; tablet and phone checks recorded.

---

# PHASE 11 — QA, Deployment & Handover

### 11.1 Playwright e2e
- **Depends on:** Phases 3–9
- **Do:** Journeys: login → status board → book → check-out → check-in; fault → technician resolves → machine returns to Operational; manager approval; conflict handling; role restrictions; CSV import. Run in CI against a seeded ephemeral stack.
- **Done when:** stable (no flakiness over 10 consecutive CI runs).

### 11.2 Load & performance
- **Depends on:** 7.6
- **Do:** k6/Artillery: board under 200 concurrent users; 50 concurrent booking attempts on hot machines; SSE with 500 connections; compare cache on/off.
- **Done when:** targets met (e.g. board p95 < 300ms cached; zero double bookings under load) and results recorded.

### 11.3 Production deployment
- **Depends on:** 11.1
- **Do:** Vercel project (web) with env vars; API + worker on the chosen persistent host (staging slot → production); managed Redis with TLS; Neon `main` branch; migrations run in the pipeline before traffic switch; custom domain + HTTPS; CORS/redirect URLs updated in Supabase; rollback procedure written.
- **Done when:** a tagged release deploys to staging then production via pipeline; smoke tests pass; rollback rehearsed.

### 11.4 Observability
- **Depends on:** 11.3
- **Do:** Sentry (web, api, worker) with release tagging; structured log shipping; uptime monitor on `/health/ready`; alerts for error spikes, failing jobs, Redis degraded, DB errors.
- **Done when:** a deliberate test error appears in Sentry with request ID; alert routes verified.

### 11.5 Documentation
- **Depends on:** 11.3
- **Do:** README (setup, scripts, env), `docs/RUNBOOK.md` (deploy, rollback, incident, Redis outage, restore), `docs/USER_GUIDE.md` (per role, with screenshots), API docs link, ADR summary from the Decision Log.
- **Done when:** a new developer can run the stack locally from the README alone (verified by following it fresh).

### 11.6 UAT & handover
- **Depends on:** 11.5
- **Do:** UAT script with hospital staff (STAFF, technician, manager, admin); collect and triage feedback into fixes/backlog; training session notes; final acceptance sign-off checklist; transfer of accounts/secrets ownership.
- **Done when:** sign-off recorded in the handoff file; remaining items live in Backlog.

---

## Phase dependency map

```
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 ──► P7 ──► P8
                                   │              │
                                   └──────────────┴──► P9 ──► P10 ──► P11
```
Phase 7 (Redis caching) intentionally comes **after** the functional core: make it correct, then make it fast. The Redis connection itself exists from Phase 0.7 so nothing needs rewiring.

## Suggested release milestones
- **MVP (end of Phase 5):** registry + live status + booking. Usable on a ward.
- **v1.0 (end of Phase 9):** + service workflow, caching/realtime, dashboards, notifications.
- **Production-ready (end of Phase 11):** audited, hardened, deployed, documented.
