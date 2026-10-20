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

## Part 4: Final acceptance before the first pilot (October 2026)

### Findings and resolution

| ID | Severity | Finding | Type | Resolution |
|---|---|---|---|---|
| F1 | CRITICAL | `AUTO_SEED` defaulted to true in production: an empty production database received the demo accounts with the password `demo`, including a platform administrator | security, configuration | fixed: production never seeds; `AUTO_SEED=true` refuses the start unless `DEMO_MODE=true` |
| F2 | CRITICAL | Legacy TITO (rail not cut over): a machine acceptance (`TITO_IN` with `holdId`) of a ticket the same machine had held was rejected; the ticket stayed HELD, returned to VALID after the hold expired and could be paid a second time | money | fixed: the acceptance commits its own hold, as on the ledger (Step 7c rule) |
| F3 | CRITICAL (commercial) | The plans TITO_STARTER, TITO_HANDPAY and CASHLESS_MACHINE cannot run their money on the ledger: the existing cutover order needs CASH for TITO and HANDPAY, MACHINE needs TITO and HANDPAY, ledger vault operations need CASH. Customer B cannot pay a handpay at all, customer D cannot move wallet money at all | product definition | fixed in Part 5: accidental dependencies removed, workflow dependencies conditional, handpay payout as TITO voucher (migration 013) |
| F4 | HIGH | Production accepted an open CORS configuration (warning only) | security | fixed: explicit `CORS_ORIGIN` required, `*` and paths refused |
| F5 | HIGH | No API or UI to register players, issue / block / replace cards, record the identity verification | operations | fixed: `/api/v1/players*` (permission `player.manage`), players page |
| F6 | HIGH | A new customer's gateway could not be registered, nor machines assigned, without SQL | operations | fixed: `npm run gateway -w @m1/database -- <org-slug> <casino-code> <device-id>`; new machines join the casino's only gateway |
| F7 | HIGH | A dropped database connection crashed the API process | reliability | fixed: idle and checked-out connection errors handled; 503 `TEMPORARILY_UNAVAILABLE` |
| F8 | HIGH | A ledger vault session could be opened where CASH is not on the ledger and could never be verified | money (stuck state) | fixed in Part 5 at the root: vault count verification needs only VAULT on the ledger (the interim refusal is removed) |
| F9 | MEDIUM | The SSE stream reflected any Origin | security | fixed: same allow-list as the API |
| F10 | MEDIUM | The SSE token (JWT in the query string) was written to the request log | security | fixed: redacted |
| F11 | MEDIUM | Platform administrator bootstrap left no audit trail and needed a migrated database | audit | fixed: migrates, audits (`SYSTEM` / `cli`), email validated |
| F12 | MEDIUM | Operational states only as text | UX / API | fixed: codes `RAIL_LEGACY`, `RAIL_ON_LEDGER`, `RAIL_FROZEN`, `BUSINESS_DATE_CLOSED`, `INSUFFICIENT_BALANCE`, `IDEMPOTENCY_CONFLICT`, `OPERATIONAL_ERROR`, `TEMPORARILY_UNAVAILABLE` next to the entitlement codes |
| F13 | MEDIUM | On a legacy TITO rail a ticket void needs no second person (four eyes exist on the ledger only) | money control | resolved for every plan by Part 5: TITO can run on the ledger without Cash (cancel and void are four-eyes requests there) |
| F14 | MEDIUM | A casino admin can reset the password of / deactivate another casino admin (same role) | security | open |
| F15 | LOW | A JWT stays valid for 12 h after a password change (deactivation, role and organisation status act at once) | security | open |
| F16 | LOW | With an inactive subscription an open shift cannot be closed until reactivation (money stays on the ledger) | operations | open |
| F17 | LOW | JWT algorithm not pinned; no security headers on the web app | security | fixed: HS256 only (`alg=none` refused), X-Frame-Options, nosniff, Referrer-Policy |
| F18 | LOW | Login timing reveals whether an e-mail exists; login rate limit per address | security | open |
| F19 | LOW | Gateway queue written without fsync; a permanently rejected batch blocks the queue (events stay durable) | reliability | open |
| F20 | LOW | Event bus and entitlement cache are per process: run one API instance (or add a shared bus) | operations | open, documented |

### Business-day close: what blocks

Blocks: a past date only, not yet closed; an active freeze of a rail in use or GLOBAL; an unexplained pending
deferred money event of a rail in use; a reconciliation mismatch of a rail in use or of the global ledger invariants.
Does not block (shown as information): open drawers and pending approvals (they book on the open date), pending
handpays, outstanding tickets and pending wallet transfers (their liabilities and reservations are reconciled),
requested vault movements (no money moved yet), checks and freezes of rails whose module is not in use or switched off.
Closed dates take no booking (database guard); a late economic event is deferred and needs the four-eyes late-event process.

### Acceptance evidence

| Suite | Result |
|---|---|
| API (PostgreSQL 16) | 361 / 361 (new: 11 five-customer acceptance, 4 production configuration, 1 SSE isolation) |
| Shared / adapters / gateway / web unit tests | 38 / 4 / 1 / 11 |
| Typecheck (all workspaces), Next.js production build | clean (no lint configured) |
| Browser: SaaS matrix, five customers, operations, responsive (tablet and phone, 26 page / viewport pairs) | 16 / 16, 0 browser errors, 0 unexpected failed API requests |
| Browser: Enterprise operator flows (Step 7e) | 16 / 16 |
| Browser: legacy smoke (all pages, report export) | 0 errors |
| Docker production bootstrap (no demo): 3 refused misconfigurations, empty database, CLI platform admin, onboarding, CLI gateway | passed, 0 money transactions, no secret or token in logs |
| Docker demo stack: db, api, gateway, web | healthy, 13 migrations |
| Docker upgrades 006, 7b, 7c, 7d, 7e to current | money fingerprint identical for each, 0 unbalanced transactions |
| Gateway offline (API stopped 25 s) and database outage | 53 events buffered and delivered once, 0 duplicates, economic time kept; API stays up, 503 during the outage |

Upgrades from 005 and 7a are covered at database level by the API upgrade suites (`step5-upgrade`, `step7a-upgrade`).

## Part 5: F3, commercial modules without unnecessary cash dependencies (October 2026)

### Dependencies

| Dependency | Before | Kind | After |
|---|---|---|---|
| CASH -> VAULT | prerequisite | true (floats and drops go through the vault) | unchanged |
| TITO -> CASH | prerequisite | workflow (cashier sale / cash redemption only) | only where CASH is in use |
| HANDPAY -> CASH | prerequisite | workflow (cash payout from a drawer) | only where CASH is in use; payout as TITO voucher or into the wallet otherwise |
| MACHINE -> VAULT | prerequisite | true (machine cash is collected into the vault / count room) | unchanged |
| MACHINE -> CASHLESS | prerequisite | true (wallet transfers; rail cut over at zero at onboarding) | unchanged |
| MACHINE -> TITO | prerequisite | true where tickets are used (ticket events change the machine credit) | only where TITO is in use |
| MACHINE -> HANDPAY | prerequisite | accidental (no machine posting touches a handpay) | only where HANDPAY is in use (jackpot events of the machine) |
| VAULT operations -> CASH | service check | accidental (a vault count touches only VAULT / VAULT_SHORT_OVER) | removed |

"In use" = the module is contracted (purchased and enabled, independent of the subscription state) or legacy records
of the rail exist in the casino (cashier sessions, tickets, handpays). It is checked inside the cutover transaction and
reported in the cutover checks (`prerequisite:<rail>` or `not_in_use:<rail>`). It never grants anything.

### Changes

- Shared: `CUTOVER_PREREQUISITES` (unconditional) and `CUTOVER_WORKFLOW_PREREQUISITES` (conditional);
  `HANDPAY_PAY` with `payTo: 'TICKET'` posts HANDPAY_PAYABLE -> TICKET_LIABILITY; feature `handpay.pay` = HANDPAY plus
  Cash, Cashless or TITO; `ledgerGaps` counts only unconditional prerequisites (all plans ledger-ready).
- Migration 013 (only schema change): `handpays.pay_method` allows TICKET, `handpays.payout_ticket_id` (unique, required
  exactly for TICKET), one liability origin per ticket (machine print, cashier sale or handpay voucher). No data change.
- Cutover: workflow prerequisites only where the rail is in use. Vault count verification needs only VAULT.
- Ingest: a ticket or jackpot event of a ledger machine whose TITO / HANDPAY rail is not on the ledger is a recorded
  exception (`TITO_NOT_ON_LEDGER`, `HANDPAY_NOT_ON_LEDGER`): event kept, no money, audited, alerted.
- Machine settlement (D3): skipped while the machine has an unexplained exception of a credit-changing event, so an
  unbooked ticket or transfer is never absorbed into GAMING_RESULT.
- Reconciliation: `machine.events_accounted` includes those exceptions (MACHINE is mandatory where it is used).
- Payout of a handpay as TITO voucher: same approval limit, four eyes, verification threshold, one payment per handpay
  (unique index), machine reset requested separately; the voucher is an ordinary ticket afterwards. UI: Handpays page
  (`/handpays`) for casinos without a cash desk; the cashier workstation offers the voucher where TITO is purchased.
- Clearing accounts: none added. D1 `LEGACY_FLOOR_CLEARING` stays the only clearing account: per machine, only that
  machine's own ticket events, database-guarded, reconciled (`tito.floor_clearing_attributable`), closed to zero by
  the machine's MACHINE cutover.

### Remaining true business dependencies (isolated to the smallest workflow)

- Cash redemption of a ticket and ticket sale at a desk need Cash (feature `tito.cashier`).
- A cash handpay needs Cash; a wallet handpay needs Cashless.
- Wallets are funded only through machines (bill acceptor -> cashbox -> vault) without Cash: Cashless + Machine needs
  the vault as count room (plan CASHLESS_MACHINE contains it).
- A ticket or jackpot on a machine of a casino without TITO / HANDPAY is a physical fact the system cannot book: it is
  reported until explained by two people (and corrected with a four-eyes adjustment where money moved).

### Five customers after F3

| Customer | Plan | Rails on the ledger | Money proven (exact postings, balanced, reconciliation, day close) |
|---|---|---|---|
| A | TITO_STARTER | TITO | print, 15-way hold race (1 winner), accept, expiry (income), four-eyes cancel; liability = outstanding ticket; floor clearing per machine = own ticket events |
| B | TITO_HANDPAY | TITO, HANDPAY | jackpot payable, four-eyes approval (approver cannot pay), 15 parallel voucher payouts -> 1, reset, voucher accepted by a machine; payable 0, liability 0 |
| C | CASH_OPERATIONS | VAULT, CASH, HANDPAY, TITO | unchanged |
| D | CASHLESS_MACHINE | VAULT, MACHINE (+ CASHLESS) | vault blind count without Cash, cash in, machine <-> wallet, reliable-meter settlement, collection, hopper fill; ticket / jackpot exceptions never gaming, explained by four eyes |
| E | ENTERPRISE | all | unchanged |

### Evidence

| Suite | Result |
|---|---|
| API (PostgreSQL 16) | 361 / 361 (A, B, D rewritten for the ledger; workflow prerequisites still enforced where in use: step 5, 7b, 7c) |
| Shared / adapters / gateway / web unit tests | 39 / 4 / 1 / 11 |
| Typecheck, Next.js production build | clean (new page `/handpays`) |
| Docker upgrades 006, 7b, 7c, 7d, 7e and c836ea1 (012) to 013 | money fingerprint identical for each |
| Browser: SaaS matrix incl. B voucher payout | 17 / 17, 0 browser errors, only the intended 409 (Cash without Vault refused) |
| Browser: Enterprise operator flows | 16 / 16 |
