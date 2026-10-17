# M1 Casino Cloud: Production readiness audit and SaaS entitlement design

Status of this document: written in Phase A (audit) before the entitlement work, then extended with the design
(Phase B) and the results (Phase K). Code base audited: commit `1832aac` (Step 7e approved state).

## Part 1: Audit (Phase A, before changes)

Method: every route file (`apps/api/src/routes/*.ts`, 120 routes) was listed with its guard, every SQL statement of
the tenant routes was checked for `org_id` / casino scoping, the authentication path (`auth.ts`), the RBAC model
(`packages/shared/src/rbac.ts`), the module model (`packages/shared/src/modules.ts`, `casino_modules`), the
configuration (`config.ts`, `docker-compose.yml`) and the money architecture of Steps 7a to 7e were reviewed.
The UI was not trusted: every finding below is about what the API allows.

### A. Authentication
- JWT (HS256) in the `Authorization` header, 12 h lifetime; on every request the employee row is reloaded
  (`active`, current role), so a disabled account or a role change takes effect immediately. Good.
- Login rate limit 10 / minute / IP; failed logins are audited. bcrypt (cost 10). Passwords min. 8 characters.
- **CRITICAL C3**: `JWT_SECRET` falls back to `dev-secret-change-me` (and `PII_HASH_SECRET` to a known value) in any
  environment; `docker-compose.yml` defaults to `local-demo-secret-change-me`. A deployment that forgets the
  variable accepts forged tokens for any organisation.
- **HIGH H3**: `employees.email` is UNIQUE case-sensitively but login matches `lower(email)`. Two accounts that
  differ only in case resolve ambiguously at login (the first row wins).
- The SSE stream takes the token as a query parameter (EventSource cannot send headers): tokens can end up in
  proxy logs. LOW L3.

### B / G. Authorization and role permissions
- Route guards check one permission per route (`guard('x')`); a few routes check permissions inside the handler.
  Role permissions are a static matrix in `rbac.ts`, mirrored into the database by `syncRbac`.
- **HIGH H1**: there is no platform level. `SUPER_ADMIN` is the top role *of one organisation*; nobody can manage
  customers, plans or tenant status. Customer administration and platform administration are not separated.

### C / D / E / F. Organisation, casino, player and money isolation
- Every tenant query is scoped by `org_id` from the token (never from the request) and casino routes by
  `scopeCasino` / `casino_id = ANY(casinoIds)`; ids from the request are always re-checked against the org.
  Database triggers check organisation consistency on 22 money / identity tables (e.g. wallets, ledger accounts).
  No cross-tenant read or write was found (verified by the isolation tests added in Phase J).
- Players, wallets and employees are organisation-level by design (a player can visit every casino of the group).
- **MEDIUM M1**: the audit log (`/audit`) returns the whole organisation's entries to an employee who only has
  access to some casinos (casino isolation inside a multi-casino organisation).
- Money isolation: the ledger guard, rail guards, freezes, idempotency and four-eyes rules of 7a to 7e are
  enforced in the database and the money service, independent of the UI (unchanged, re-verified in Phase K).

### H / I. Rail and module permissions
- Rails (LEGACY / LEDGER, frozen) are enforced by the money service and database triggers. Good.
- **CRITICAL C1**: modules are not enforced at all by the API. `casino_modules` is only read by the web navigation
  (`moduleOn`). Every module API (TITO, cashier, vault, cashless, reports) works for every organisation.
- **CRITICAL C2**: any employee with `settings.manage` (CASINO_ADMIN and MANAGER) can switch any module on via
  `PUT /casinos/:id/modules/:key`, including modules the customer never bought. There is no commercial model.

### J / K / L. API route protection, frontend route protection, direct URL access
- All 120 routes are authenticated except `/health`, `/auth/login` and the gateway device API (device id + hashed
  key, bound to one casino). Permission guards exist on all tenant routes except a few read views that check
  inside the handler (`/cashier/desks`, `/tickets/lookup`, `/players/lookup`) and two that only require a login:
  `/operator/context` and `/machines/:id/money` (LOW L1: machine money status visible to every casino employee).
- Frontend: navigation is filtered by permission and `casino_modules`, but a direct URL renders any page; the API
  is the real protection (see C1: for modules it is missing).

### M / N / O / P. Database constraints, ledger integrity, idempotency, concurrency
- Double-entry ledger with a zero-sum constraint per transaction, immutable entries, balance non-negativity per
  account kind, rail guard triggers, closed business dates, exactly-once keys (dedupe keys, unique indexes per
  ticket / handpay / transfer), HTTP Idempotency-Key per employee, row locks in a fixed order. Covered by the
  Step 1 to 7e suites (327 tests at `1832aac`). No finding.

### Q / R / S / T. Offline gateway, deferred events, reconciliation, business-day close
- Gateway events are idempotent per `eventId`; a resent offline queue is deduplicated. Deferred events are durable
  and replayed exactly once on the business date of `occurred_at`; closed dates need a four-eyes late booking.
- **HIGH H4**: reconciliation and day close are not module-aware: a rail that is on the ledger is checked, frozen
  and blocks the day close even when the customer does not use that module (e.g. the CASHLESS rail is cut over
  automatically on every fresh install).

### U. Audit
- Hash-chained audit log per organisation, verification endpoint. Module switches are audited (old / new value
  missing, no reason). Entitlement changes do not exist yet.

### V. Error handling
- Central error handler: validation 400, domain errors with status and message, unknown errors 500 without details.
  No stack traces leak. Good. Error codes are free text (no machine-readable codes): addressed for entitlements.

### W / X. Multi-casino organisations and multi-tenant behaviour
- Multi-casino works (employee ↔ casino assignment, `SUPER_ADMIN` sees all casinos of the org).
- **HIGH H2**: no organisation or casino lifecycle: a tenant cannot be suspended or disabled, a casino cannot be
  deactivated; nothing restricts the number of casinos, machines, users or players.
- **MEDIUM M4**: machines and casinos can only be created by the seed: there is no API to onboard a customer.
- **MEDIUM M2**: CORS reflects any origin (acceptable with bearer tokens and no cookies; must be restricted with
  `CORS_ORIGIN` in production).

### Findings summary (before the work)

| ID | Severity | Finding | Resolution (this phase) |
|---|---|---|---|
| C1 | CRITICAL | Modules not enforced by the API | Central entitlement service, every route declares its feature, enforced in the route guard |
| C2 | CRITICAL | Customers can enable unpurchased modules | Commercial entitlements managed by the platform only; customers can only switch purchased modules |
| C3 | CRITICAL | Default JWT / PII secrets accepted | Production start refused with default or short secrets |
| H1 | HIGH | No platform administration | Platform admin (separate platform organisation) and `/platform` API + `/admin` portal |
| H2 | HIGH | No tenant / casino lifecycle, no limits | Organisation status, casino status, subscription lifecycle, limit service |
| H3 | HIGH | Case-insensitive login vs case-sensitive unique email | Unique index on `lower(email)` (migration 012) |
| H4 | HIGH | Reconciliation / day close not module-aware | Checks of non-entitled modules are advisory: no freeze, no day-close block |
| M1 | MEDIUM | Audit log not casino-scoped | Non-organisation admins see entries of their casinos and their own |
| M2 | MEDIUM | CORS reflects any origin | Documented; production warning when `CORS_ORIGIN` is unset |
| M4 | MEDIUM | No onboarding API (casinos / machines) | Casino and machine creation with limits |
| L1 | LOW | `/machines/:id/money` without permission | Requires `machine.view` and the MACHINE module |
| L3 | LOW | SSE token in query string | Documented (remaining risk) |

## Part 2: Design (Phases B to I)

### Commercial modules are not money rails

| Concept | Owner | States | Changed by |
|---|---|---|---|
| Module purchase | platform | purchased (plan or override), not purchased | platform administrator (plan, subscription, override) |
| Module switch | customer | enabled, disabled | customer admin (`org.manage`) or platform |
| Subscription | platform | TRIAL, ACTIVE, SUSPENDED, EXPIRED, CANCELLED (+ `ends_at`) | platform administrator |
| Money rail | money service | LEGACY, LEDGER, frozen | cutover (four eyes), reconciliation |

Effective module = purchased AND enabled AND all dependencies effective AND usable subscription (CORE always
effective). "In use" is the same without the subscription condition: it keeps history readable and keeps
reconciliation running when a subscription lapses.

### Verified dependencies (from the code, shown in the UI)

| Module | Requires | Why |
|---|---|---|
| CASH | VAULT | drawer floats, drops and the final drop of a shift go through the vault |
| MACHINE | VAULT | collections are dropped into the vault, hopper fills come from it |
| CASHLESS | MACHINE | wallet transfers are confirmed by the machine and booked to its machine credit |
| TITO, HANDPAY, VAULT, REPORTING, ADVANCED_RECONCILIATION | CORE | standalone |

Feature level combinations: cage ticket redemption / sale = TITO + CASH; handpay payment = HANDPAY + (CASH for a
drawer payment, CASHLESS for a wallet payment); cage wallet deposit / withdrawal = CASHLESS + CASH.

### Enforcement order

`AUTH -> TENANT (organisation active) -> CASINO (active, assigned) -> ROLE -> ENTITLEMENT -> RAIL -> BUSINESS -> MONEY`.
Every `/api/v1` route declares `config.feature`; the `onRoute` hook refuses to register a route without one and
the guard answers 500 for a route that slipped through (fail closed). Gateway routes authenticate the device and
check the feature before validating the body.

| Code | HTTP | Message |
|---|---|---|
| MODULE_NOT_ENTITLED | 403 | This feature is not included in your current plan. |
| MODULE_DISABLED | 403 | This module is switched off for your organisation. |
| SUBSCRIPTION_INACTIVE | 403 | Your subscription is not active: existing data stays readable, new actions are not possible. |
| ORGANIZATION_DISABLED | 403 | This organisation is disabled. |
| LIMIT_REACHED | 403 | The limit of your plan is reached. (limit, used, max) |
| MODULE_ENABLE_BLOCKED | 409 | exact reasons (dependency, missing vault / desk / machine / casino) |
| MODULE_DISABLE_BLOCKED | 409 | exact reasons (dependent modules, open shifts, unpaid handpays, pending transfers, wallet money, valid tickets, open vault movements) |

### Money integrity rules of the entitlement layer

- Physical machine events are always recorded (no lost money fact); new business (ticket hold, cashless session /
  transfer) needs the module. Lifecycle jobs (expiry, hold release, reset retries) run regardless of entitlement.
- A module (or plan / override change) that would strand money cannot be removed: open shifts, unpaid handpays,
  pending transfers, wallets with money, valid tickets, open vault movements block it with the exact count.
- Reconciliation: checks of rails whose module is not in use are recorded as advisory (no freeze, no day-close
  block); GLOBAL ledger invariants always count.
- Inactive subscription: reads of modules in use stay possible, every write of a module is refused, growth
  (casinos, machines, users, players) is refused. Nothing is deleted in any lifecycle state.
- No administrative action creates a money transaction (tested).

### Limits

HARD (enforced on create with a transaction advisory lock, also on reactivation): MAX_CASINOS, MAX_MACHINES,
MAX_USERS, MAX_PLAYERS. SOFT (measured and shown only): MAX_WALLETS, MAX_CASHLESS_PLAYERS,
MAX_MONTHLY_TITO_VOLUME, MAX_MONTHLY_HANDPAYS. A limit below the current usage removes nothing.

### Plans

Versioned and immutable (database trigger): a change of modules or limits creates a new version; subscriptions keep
their version. Name, description, offered flag and price metadata can change. No payment processing exists.

### Safe defaults for existing customers (migration 012)

Every existing organisation receives plan CUSTOM (CORE only) with status ACTIVE plus an override for each module
its data shows in use: TITO (tickets, TITO cutover, tickets switch), HANDPAY (handpays, Step 1 handpay cash rows,
cutover), CASH (cashier shifts, cutover, cash switch), VAULT (vault sessions, cutover, or required by Cash / Machine /
Cashless), MACHINE (collections, machine cutover, or required by Cashless), CASHLESS (wallet transfers, wallet
money, cashless switch), REPORTING (reporting switch), ADVANCED_RECONCILIATION (machine cutover). Each override
carries its derivation as reason. Nobody receives an unused paid module; the platform administrator assigns the
commercial plan afterwards. Upgrades do not create a platform organisation: create the first platform
administrator with `npm run platform-admin -w @m1/database -- <email> <password 12+> [name]`.

## Part 3: Results

| Suite | Result |
|---|---|
| API (node:test, PostgreSQL 16) | 345 / 345 (16 new SaaS entitlement tests, 2 new upgrade derivation tests) |
| Shared package | 37 / 37 (6 entitlement model tests) |
| Web unit tests | 11 / 11 (3 navigation / feature tests) |
| Typecheck (all workspaces) and Next.js production build | clean |
| Browser: SaaS matrix (platform admin, onboarding UI, 5 customers, customer admin, operator) | 14 / 14, 0 browser errors |
| Browser: Step 7e operator flows | 16 / 16 |
| Browser: legacy smoke (all pages, report export) | 0 errors |
| Docker fresh install | 13 migrations, 0 money transactions at startup |
| Docker upgrades 006, 7d, 7e to current | money fingerprint identical (18 / 20 / 20 lines), legacy activity works |

### Remaining risks

| Risk | Severity | Note |
|---|---|---|
| SSE token in the query string (L3) | LOW | Short-lived JWT; move to a cookie or ticket exchange before internet exposure |
| CORS reflects origins when `CORS_ORIGIN` is unset (M2) | MEDIUM | Production start warns; set `CORS_ORIGIN` |
| Open shifts during an inactive subscription | LOW | Money stays on the ledger; closing the shift waits for reactivation |
| Entitlement cache (5 s TTL per process) | LOW | Invalidated on every change in the process; other API instances see the change within 5 s |
| Login rate limit is per address | LOW | Shared NAT addresses share the limit |
