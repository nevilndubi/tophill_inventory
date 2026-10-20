# ARCHITECTURE — Hospital Equipment Tracking & Booking System

Companion to `project_model_handoff.md`. If you change anything here, update this file in the same commit and log a Decision in the handoff file.

---

## 1. System overview

```
                       ┌──────────────────────────────┐
                       │          Browser / Tablet     │
                       └───────┬───────────────▲───────┘
                  HTTPS (pages) │               │ SSE (live status)
                               ▼               │
                  ┌─────────────────────┐      │
                  │  Next.js (Vercel)   │      │
                  │  App Router, RSC    │      │
                  └───────┬─────────────┘      │
          login (JWT)     │ REST + Bearer JWT  │
   ┌──────────────┐       ▼                    │
   │ Supabase     │  ┌────────────────────────┴─────────┐
   │  • Auth      │◄─┤  NestJS API (persistent Node host)│
   │  • Storage   │  │  modules: auth, users, machines,  │
   └──────────────┘  │  usage, bookings, service, ...    │
                     └───┬───────────────┬───────────┬───┘
                         │ Prisma        │ ioredis   │ BullMQ jobs
                         ▼               ▼           ▼
                  ┌────────────┐   ┌──────────────────────┐
                  │ Neon       │   │ Redis                │
                  │ PostgreSQL │   │ cache • pub/sub •    │
                  │ (truth)    │   │ queues • rate limits │
                  └────────────┘   └──────────────────────┘
                                           ▲
                                  ┌────────┴────────┐
                                  │ Worker process  │  (same codebase, `WORKER=true`)
                                  │ reminders, sweeps│
                                  └─────────────────┘
```

**Principles**
1. **Neon is the single source of truth.** Everything else (Redis, UI state) is derivable.
2. **Rules live server-side.** UI mirrors rules; API and DB enforce them.
3. **Vertical modules.** Each NestJS module owns its controller, service, repository access, DTOs and tests.
4. **Fail soft on cache.** Redis down ⇒ slower, not broken.
5. **Boring, explicit, testable.** Prefer simple code over cleverness.

---

## 2. Component responsibilities

| Component | Responsibility | Notes |
|---|---|---|
| **Next.js web** | UI, routing, forms, calendar, status board, live updates | Talks to NestJS API only (never directly to Neon). Talks to Supabase only for sign-in/sign-out and session refresh |
| **NestJS API** | All business logic, validation, authorization, persistence, caching, realtime stream | Stateless apart from SSE connections; horizontally scalable via Redis pub/sub |
| **Worker** | BullMQ consumers + schedulers | Same repo/image, started with a different entrypoint. Never serves HTTP traffic |
| **Neon PostgreSQL** | Persistent data, constraints, transactions | Pooled URL for runtime, direct URL for migrations. Branches for dev/staging/CI |
| **Redis** | Cache, pub/sub, BullMQ, rate-limit counters, short locks | TLS in production; every key has a TTL (BullMQ keys excepted) |
| **Supabase Auth** | Identity (email/password, magic link), JWT issuance | App roles are **not** trusted from the JWT — they come from our `users` table |
| **Supabase Storage** | Machine photos, manuals, service attachments | Private buckets; API issues short-lived signed URLs |
| **GitHub Actions** | CI: lint, typecheck, test, build, migration check, deploy hooks | |

**Why Supabase Auth/Storage but Neon for data (D1):** two Postgres databases would split the data and double the operational burden. Neon stays the one database; Supabase is used only for the services that save us from writing auth and file storage ourselves. If the owner later prefers one vendor, the swap is isolated to the `auth` and `files` modules.

**Why the API is not on Vercel serverless (D4):** SSE streams and BullMQ workers need long-lived processes. Vercel hosts the Next.js app; the API runs on a persistent Node host (Azure App Service recommended).

---

## 3. Data model

All tables: `id` (UUID v7 or `uuid`), `created_at`, `updated_at` (timestamptz, UTC). Soft delete via `deleted_at` where noted.

### 3.1 Tables

**users** — `id`, `supabase_user_id` (unique), `email` (unique), `full_name`, `role` (enum), `department_id` (nullable FK), `phone`, `is_active`, `last_login_at`

**departments** — `id`, `name` (unique), `code` (unique), `manager_user_id` (nullable FK)

**locations** — `id`, `department_id` (FK), `name` (e.g. "ICU Bay 3"), `building`, `floor`, `room`; unique (`department_id`, `name`)

**machine_categories** — `id`, `name` (unique), `description`, `default_service_interval_days` (nullable), `default_max_booking_minutes` (nullable)

**machines**
- identity: `id`, `asset_tag` (unique, human-readable e.g. `HM-000123`), `name`, `category_id`, `manufacturer`, `model`, `serial_number` (unique per manufacturer), `description`
- placement: `department_id` (owning), `location_id` (current)
- lifecycle: `purchase_date`, `warranty_expires_on`, `commissioned_on`, `retired_on`
- **condition**: `condition` enum — `OPERATIONAL | NEEDS_SERVICE | UNDER_MAINTENANCE | OUT_OF_SERVICE | RETIRED` (default `OPERATIONAL`)
- booking policy: `is_bookable` (bool), `requires_approval` (bool), `allow_booking_when_needs_service` (bool, default false), `max_booking_minutes` (nullable override), `buffer_minutes` (nullable override; cleaning/setup time after each booking)
- service: `service_interval_days` (nullable override), `last_serviced_at`, `next_service_due_at`
- `deleted_at`
- **No `is_in_use` column.** Usage is derived from `usage_sessions` (D2).

**machine_status_history** — `id`, `machine_id`, `from_condition`, `to_condition`, `reason`, `changed_by_user_id`, `source` (`MANUAL | SERVICE_TICKET | SCHEDULE | SYSTEM`), `ticket_id` (nullable), `created_at`

**usage_sessions** — `id`, `machine_id`, `user_id`, `booking_id` (nullable), `started_at`, `expected_end_at` (nullable), `ended_at` (nullable), `purpose` (free text, ≤200 chars, **no patient data**), `end_note`
- Partial unique index: **one open session per machine** → `UNIQUE (machine_id) WHERE ended_at IS NULL`

**bookings** — `id`, `machine_id`, `requested_by_user_id`, `starts_at`, `ends_at`, `status` enum (`PENDING | CONFIRMED | IN_PROGRESS | COMPLETED | CANCELLED | REJECTED | NO_SHOW`), `purpose`, `approved_by_user_id`, `decision_note`, `cancelled_reason`, constraint `ends_at > starts_at`
- **Overlap guard (raw SQL migration; requires `btree_gist`):**
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      machine_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status IN ('PENDING','CONFIRMED','IN_PROGRESS'));
  ```
  The API catches Postgres error `23P01` (exclusion violation) and returns `409 BOOKING_CONFLICT` with the conflicting window. Buffer minutes are applied by storing `ends_at` + buffer in a separate `blocked_until` column **or** by extending the range used in the constraint (choose one in Task 1.4 and log the decision).

**service_tickets** — `id`, `machine_id`, `reported_by_user_id`, `title`, `description`, `severity` (`LOW | MEDIUM | HIGH | CRITICAL`), `status` (`OPEN | ASSIGNED | IN_PROGRESS | RESOLVED | CLOSED | CANCELLED`), `assigned_to_user_id`, `type` (`FAULT | PREVENTIVE | CALIBRATION | INSPECTION`), `opened_at`, `resolved_at`, `closed_at`, `machine_out_of_service_from`, `machine_back_in_service_at`

**service_records** — `id`, `ticket_id`, `performed_by_user_id`, `performed_at`, `work_done`, `parts_replaced`, `cost_amount` (nullable, integer minor units), `currency` (default `KES`), `next_due_at`, `vendor_name`

**maintenance_schedules** — `id`, `machine_id`, `interval_days`, `last_done_at`, `next_due_at`, `is_active`

**attachments** — `id`, `entity_type` (`MACHINE | TICKET`), `entity_id`, `storage_path`, `file_name`, `mime_type`, `size_bytes`, `uploaded_by_user_id`

**notifications** — `id`, `user_id`, `type`, `title`, `body`, `entity_type`, `entity_id`, `read_at`, `emailed_at`

**notification_preferences** — `user_id`, `type`, `in_app` (bool), `email` (bool)

**audit_logs** — `id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb), `ip`, `request_id`, `created_at` (append-only; no updates/deletes)

**app_settings** — `key` (PK), `value` (jsonb) — global defaults (max booking length, lead time, no-show grace minutes, ad-hoc checkout guard minutes)

### 3.2 Key indexes
- `machines (department_id)`, `machines (category_id)`, `machines (condition)`, `machines (next_service_due_at)`, trigram or full-text index on `name`, `asset_tag`, `serial_number`
- `bookings (machine_id, starts_at)`, `bookings (requested_by_user_id, starts_at)`, `bookings (status, starts_at)`
- `usage_sessions (machine_id) WHERE ended_at IS NULL` (unique), `usage_sessions (user_id, started_at)`
- `service_tickets (machine_id, status)`, `service_tickets (assigned_to_user_id, status)`
- `audit_logs (entity_type, entity_id, created_at)`, `notifications (user_id, read_at)`

---

## 4. State machines

### 4.1 Machine condition
```
OPERATIONAL ──fault reported / manual──► NEEDS_SERVICE
NEEDS_SERVICE ──work starts──► UNDER_MAINTENANCE
OPERATIONAL ──critical fault──► OUT_OF_SERVICE
UNDER_MAINTENANCE ──ticket resolved & verified──► OPERATIONAL
UNDER_MAINTENANCE ──cannot repair──► OUT_OF_SERVICE
OUT_OF_SERVICE ──repaired──► UNDER_MAINTENANCE ──► OPERATIONAL
ANY (except RETIRED) ──admin──► RETIRED   (terminal; restore = Admin-only, logged)
```
- Transitions are validated in one place (`ConditionService.transition()`); every transition writes `machine_status_history` and an audit entry and publishes a realtime event.
- A machine with an **open usage session** cannot move to `UNDER_MAINTENANCE`/`OUT_OF_SERVICE`/`RETIRED` until checked in (or an Admin force-ends the session with a reason).

### 4.2 Usage (derived)
- `IN_USE` ⇔ ∃ `usage_sessions` row with `ended_at IS NULL` for the machine.
- **Check-out** requires: machine `OPERATIONAL` (or `NEEDS_SERVICE` with the allow flag), no open session, and either the caller holds a `CONFIRMED` booking whose window includes now (±grace) **or** (ad-hoc) no other user's confirmed booking begins within `adhoc_checkout_guard_minutes`.
- **Check-in** closes the session; if linked to a booking, booking → `COMPLETED`. Optionally prompts "Report a problem?" which opens the fault form.

### 4.3 Display status (computed, `StatusService`)
Priority order: `RETIRED` → `OUT_OF_SERVICE` → `UNDER_MAINTENANCE` → `IN_USE` → `AVAILABLE_NEEDS_SERVICE` → `AVAILABLE_OK`. Also returns: current user (name only), `since`, `expected_end_at`, `next_booking_at`, `service_due` flag.

### 4.4 Booking
```
PENDING ──approve──► CONFIRMED ──check-in──► IN_PROGRESS ──check-in complete──► COMPLETED
PENDING ──reject──► REJECTED
PENDING/CONFIRMED ──cancel──► CANCELLED
CONFIRMED ──grace period passes without check-in──► NO_SHOW   (worker job)
```
Machines with `requires_approval = false` create bookings directly as `CONFIRMED`.

### 4.5 Service ticket
`OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED` (+ `CANCELLED`). Coupling to machine condition is performed by `ServiceService` calling `ConditionService.transition()`; it never writes `machines.condition` directly.

---

## 5. API design

- **REST, JSON, versioned:** application routes use `/api/v1/...`; root-level `/health` and `/health/ready` are explicit exceptions for infrastructure probes. OpenAPI is at `/api/docs` (non-production or Admin-only in production).
- **Auth:** `Authorization: Bearer <Supabase JWT>`; verified against Supabase JWKS (signature, `iss`, `exp`). On first valid token, a `users` row is provisioned/linked by `supabase_user_id`/email. The user's **role and active flag come from our DB**, cached in Redis for 60s.
- **Authorization:** `@RequirePermission('machine:update')` etc. Permission map is in `packages/shared`.
- **Validation:** shared Zod schemas; unknown fields stripped/rejected.
- **Errors (standard shape):**
  ```json
  { "error": { "code": "BOOKING_CONFLICT", "message": "…", "details": { }, "requestId": "…" } }
  ```
- **Pagination:** cursor or `page`/`pageSize` (max 100) with `total`; **filtering/sorting** via query params; consistent envelope `{ data, meta }`.
- **Idempotency:** `POST /bookings` accepts `Idempotency-Key` header (stored in Redis 24h) to survive double-taps on flaky hospital Wi-Fi.
- **Time:** ISO-8601 UTC in/out.

### 5.1 Main endpoints (summary)
| Area | Endpoints |
|---|---|
| Auth/Users | `GET /me`, `GET/POST/PATCH /users`, `POST /users/:id/deactivate` |
| Reference | `/departments`, `/locations`, `/categories` (CRUD) |
| Machines | `GET/POST /machines`, `GET/PATCH/DELETE /machines/:id`, `GET /machines/by-tag/:assetTag`, `POST /machines/import`, `GET /machines/:id/history` |
| Status | `GET /status/board` (filters), `GET /machines/:id/status`, `POST /machines/:id/condition` |
| Usage | `POST /machines/:id/check-out`, `POST /machines/:id/check-in` |
| Booking | `GET /machines/:id/availability?from&to`, `GET/POST /bookings`, `PATCH /bookings/:id`, `POST /bookings/:id/{cancel,approve,reject}` |
| Service | `POST /machines/:id/faults`, `GET/PATCH /service/tickets`, `POST /service/tickets/:id/{assign,start,resolve,close}`, `/service/schedules` |
| Dashboard | `GET /dashboard/summary`, `GET /reports/:type` |
| Realtime | `GET /stream` (SSE) |
| Files | `POST /attachments/sign-upload`, `GET /attachments/:id/url` |
| Ops | `GET /health` (liveness), `GET /health/ready` (db + redis) |

---

## 6. Redis usage (all uses, with rules)

| Use | Key pattern | TTL | Invalidation / notes |
|---|---|---|---|
| Status board snapshot | `board:v1:{filterHash}` | 15–30s | Deleted on any condition change, check-in/out, booking state change (use key-set `board:keys` or version counter `board:ver` to invalidate by bumping version) |
| Machine detail | `machine:{id}:v1` | 5 min | Deleted on machine update/condition/usage change |
| Machine status (single) | `status:{id}` | 30s | Same triggers as board |
| Reference data (categories, departments, locations) | `ref:{type}:v1` | 10 min | Deleted on CRUD |
| Availability grid | `avail:{machineId}:{date}` | 30s | Deleted on booking change for that machine |
| User + role lookup | `user:{supabaseId}` | 60s | Deleted on role/active change |
| Rate limiting | `rl:{route}:{userOrIp}` | window | Via Nest throttler Redis storage; stricter limits on auth-adjacent and booking endpoints |
| Idempotency keys | `idem:{userId}:{key}` | 24h | Stores response for replay |
| Booking contention lock | `lock:booking:{machineId}` | 5s | Optional short lock to reduce DB conflict storms. **Never a correctness mechanism — the DB constraint is** |
| Pub/Sub channel | `events:machine`, `events:booking`, `events:ticket` | n/a | API instances publish; every instance subscribes and forwards to its SSE clients |
| BullMQ queues | `bull:*` | n/a | Notifications, reminders, sweeps |

**Rules**
1. **Cache-aside only:** read → miss → DB → set. Writes go to DB first, then invalidate.
2. **Invalidate on write, TTL as safety net.** Short TTLs on anything status-related; staleness must never exceed ~30s for status data.
3. **Graceful degradation:** a `CacheService` wrapper catches all Redis errors, logs a warning, and falls through to the database. Circuit-break after repeated failures. `/health/ready` reports Redis state but Redis being down yields `degraded`, not `down`.
4. **Namespaced + versioned keys** (`:v1`) so a bad cache shape can be abandoned by bumping the version.
5. **No PHI, no secrets, no raw JWTs in Redis.**
6. **Serialize with JSON**, keep values small (<100 KB), and never cache per-user permission decisions longer than 60s.
7. Environment prefix (`prod:`, `stg:`) so environments never share keys.
8. Redis hosting: managed Redis with TLS (Azure Cache for Redis or Redis Cloud). Serverless-priced Redis (e.g. Upstash) is fine for cache-only but gets expensive with BullMQ polling — check before choosing.

---

## 7. Authorization matrix (initial)

| Capability | SUPER_ADMIN | ADMIN | BIOMED_TECH | DEPT_MANAGER | STAFF | VIEWER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View status board / machines | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit/retire machines | ✅ | ✅ | ✅ (edit only) | ❌ | ❌ | ❌ |
| Manage categories/departments/locations | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Book a machine | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Approve/reject bookings | ✅ | ✅ | ❌ | ✅ (own dept machines) | ❌ | ❌ |
| Check-out / check-in | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Force-end a session | ✅ | ✅ | ❌ | ✅ (own dept) | ❌ | ❌ |
| Report a fault | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Manage service tickets / change condition | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage users & roles | ✅ | ✅ (not SUPER_ADMIN) | ❌ | ❌ | ❌ | ❌ |
| View audit log | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View reports/dashboard | ✅ | ✅ | ✅ | ✅ (own dept) | ❌ | ✅ |

The matrix is encoded once in `packages/shared/src/permissions.ts` and consumed by both API guards and UI visibility checks.

---

## 8. Realtime design

- **Transport:** Server-Sent Events (`GET /api/v1/stream`) — one-way, simple, proxy-friendly.
- **Flow:** a mutation commits to Neon → service publishes a small event (`{type, machineId, version, at}`) to Redis → every API instance forwards to connected clients → the web app invalidates the relevant TanStack Query keys (or patches the cache) and refetches.
- **Events carry IDs, not data** — clients refetch through normal authorized endpoints, so realtime cannot leak data.
- **Resilience:** heartbeat every 25s, `Last-Event-ID` support, client auto-reconnect with backoff; if SSE fails the UI falls back to 30s polling.
- **Scale note:** one process handles thousands of SSE connections; Redis pub/sub makes multi-instance safe.

---

## 9. Background jobs (BullMQ, worker process)

| Job | Schedule | Action |
|---|---|---|
| `booking-reminder` | per booking, 30 min before start | Notify requester |
| `booking-no-show-sweep` | every 5 min | Confirmed bookings past grace without check-in → `NO_SHOW`, free the machine, notify |
| `overdue-checkout-alert` | every 10 min | Open sessions past `expected_end_at` → notify user and department manager |
| `service-due-sweep` | daily 06:00 EAT | Flag machines due/overdue; open `PREVENTIVE` tickets; notify BIOMED_TECH |
| `warranty-expiry-alert` | daily | Machines whose warranty ends within 30 days |
| `audit-retention` (optional) | weekly | Archive per policy |
| `send-email` | on demand | Resend delivery with retry/backoff |

All jobs are idempotent and safe to retry. Schedulers use repeatable jobs with a fixed job ID so multiple workers never duplicate them.

---

## 10. Frontend architecture

- **Next.js App Router** with route groups: `(auth)/login`, `(app)/dashboard`, `(app)/machines`, `(app)/machines/[id]`, `(app)/status`, `(app)/bookings`, `(app)/service`, `(app)/reports`, `(app)/admin/{users,reference,audit,settings}`, `/scan/[assetTag]` (QR landing).
- **Data fetching:** TanStack Query against the typed API client; server components for initial page shells; **no business rules in the client**.
- **API URL handling:** the client is configured with a validated API origin, sends infrastructure checks such as `/health` to that root origin, and prepends `/api/v1` only for application requests. Browser calls use the validated `NEXT_PUBLIC_API_URL`; server-only calls use `API_BASE_URL`. The auth-header provider currently returns no token and is replaced by Supabase integration in Phase 2.
- **Forms:** React Hook Form + shared Zod schemas.
- **Auth:** Supabase JS for sign-in; access token attached to API calls; Next middleware protects `(app)` routes; role-aware navigation using the shared permission map.
- **Bootstrap shell:** the Phase 0 shell uses a mobile navigation drawer below 768px, a compact icon rail from 768px, and the full sidebar from 1024px. The root placeholder is the only current route; future navigation labels remain disabled until their scheduled features exist.
- **Status board UX:** card grid + table toggle; filters (department, category, status, location); each status shown as **icon + text + colour** (never colour alone); auto-updates through SSE.
- **Calendar:** week/day timeline per machine; drag-to-select slot; conflicts shown inline from the availability endpoint.
- **Tablet-first for wards;** large tap targets for check-in/out.
- **Loading/empty/error states** designed for every list.

---

## 11. Environments & deployment

| Env | Web | API/Worker | Neon branch | Redis |
|---|---|---|---|---|
| Local | `next dev` | `nest start --watch` | `dev` | docker-compose |
| Staging | Vercel preview/staging | Azure App Service (staging slot) | `staging` | Staging instance |
| Production | Vercel production | Azure App Service (+ worker) | `main` | Production instance |
| CI | build only | tests against ephemeral Neon branch + Redis service container | per-run branch | service container |

**Migrations:** `prisma migrate deploy` runs as a pipeline step *before* the new API version receives traffic; migrations must be backward-compatible with the previous release (expand → migrate → contract).

**Health:** unversioned `GET /health` (liveness) and `GET /health/ready` (Neon + Redis) stay at the root so host probes and uptime monitoring do not depend on an application API version. Before those services are introduced, readiness reports their checks as `not_configured`.

---

## 12. Security & privacy

- No patient data stored; purpose fields carry a UI warning and are excluded from logs.
- Short-lived JWTs; server verifies signature, issuer, expiry; roles from our DB, never from client claims.
- Helmet, strict CORS (`WEB_ORIGIN` only), Redis rate limits, body size limits, upload type/size allow-list.
- Private storage buckets, signed URLs (≤5 min), virus-scan hook point documented for uploads.
- Secrets only in host/Vercel/GitHub secrets. Service-role key never reaches the browser.
- Audit log is append-only and Admin-visible.
- Dependency audit in CI; Dependabot enabled.
- Backups: Neon point-in-time restore window documented and a restore drill performed (Task 10.4).

---

## 13. Observability

- **Logs:** pino JSON with `requestId`, `userId` (id only), route, latency. Request ID propagated web → API → jobs.
- **Errors:** Sentry on web and API/worker.
- **Metrics (basic):** cache hit ratio, booking conflicts/day, SSE connections, job failures — exposed via logs or a `/metrics` endpoint behind auth.
- **Uptime:** external pinger on `/health/ready`.

---

## 14. Testing strategy

| Layer | Tool | What must be covered |
|---|---|---|
| Unit | Jest/Vitest | State machines, status derivation, booking rules, permission map |
| Integration | Jest + real Postgres (Neon branch or Testcontainers) + Redis | Repositories, **exclusion constraint**, transactions, cache invalidation |
| Concurrency | Jest | N parallel bookings for the same slot ⇒ exactly one succeeds; parallel check-outs ⇒ one succeeds |
| API e2e | Supertest | Auth, permissions (403s), validation (400s), conflict (409s) |
| UI e2e | Playwright | Login → find machine → see status → book → check-out → check-in → report fault → technician resolves |
| Resilience | Jest | Redis down ⇒ API still correct |
| Load | k6/Artillery | Status board under N concurrent users; booking under contention |
