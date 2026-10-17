# M1 Casino Cloud

Modular, multi-tenant casino management SaaS: machine management, floor control, accounting, alerts and audit,
connected to gaming machines through an edge gateway and a manufacturer-neutral adapter layer.

**Status: Phase 1 + Phase 2 with simulated machines.** No real manufacturer protocols, no real money functions.

## Quick start

```bash
cd casino-cloud
docker compose up --build
```

Open **http://localhost:3000** and sign in with `admin@example.com` / `demo`.

On first start the API migrates the database and seeds the demo tenant automatically:
**M1 Demo Casino** (Vienna), 3 floors, 20 machines (Novomatic, IGT, EGT, SYNOT, Zitro), 60 players,
7 jackpots, 7 days of history. The gateway starts simulating immediately, so the dashboard is live at once.

| Demo account | Role |
|---|---|
| admin@example.com | SUPER_ADMIN |
| manager@example.com | MANAGER |
| floor@example.com | FLOOR_SUPERVISOR |
| tech@example.com | TECHNICIAN |
| accounting@example.com | ACCOUNTING |
| cashier@example.com | CASHIER (tickets, cash, mobile cashier only) |
| attendant@example.com | ATTENDANT (floor service + mobile cashier) |
| admin@riverside.example | Admin of a second tenant (plan TITO + Handpay, proves tenant isolation and entitlements) |
| platform@example.com | Platform administrator: `/admin` portal (organisations, plans, onboarding) |

All passwords: `demo`. Tablets on the same network can open `http://<your-ip>:3000`.

### Without Docker (development)

```bash
cd casino-cloud
npm install
docker compose up -d db          # or any PostgreSQL 16, see .env.example
npm run dev                      # api :4000, gateway, web :3000 with hot reload
```

`npm run db:reset` drops and re-seeds the database. `npm test` and `npm run typecheck` run the checks.

## Architecture

```
Gaming machines ──(adapter per manufacturer)──► Edge Gateway (Raspberry Pi / Rock Pi, Docker)
                                                   │ durable offline queue, heartbeat, remote config
                                                   ▼ HTTPS (MQTT later)
                                               Cloud API (Fastify) ──► PostgreSQL
                                                   │ SSE realtime stream
                                                   ▼
                                               Web dashboard (Next.js)
```

```
apps/
  api/        Fastify REST API, event ingestion, RBAC, SSE stream, gateway watchdog
  gateway/    Edge gateway: adapters, offline queue (JSONL), heartbeat, command execution
  web/        Next.js 15 + Tailwind dashboard (dark/light, responsive)
packages/
  shared/     Internal data model: machine status, unified events, RBAC, modules, ledger types
  adapters/   GamingMachineAdapter interface, registry, SimulatorAdapter, manufacturer stubs
  database/   SQL migrations, migration runner, demo seed, hash-chained audit writer
  ui/         Formatters and status colours shared by the UI
```

### Key design decisions

- **Manufacturer neutrality.** Every integration implements `GamingMachineAdapter`
  (`packages/adapters/src/types.ts`) and translates native messages into the unified `MachineEvent`
  (`packages/shared/src/events.ts`). Nothing outside the adapter knows the manufacturer.
  Stubs exist for Novomatic, IGT, EGT, SYNOT, Zitro, Aristocrat, Konami and SAS.
- **Adding a manufacturer:** extend `ProtocolAdapter`, implement transport + translation, register one line
  in `packages/adapters/src/registry.ts`, set `machines.adapter_key` for the machines. Done.
- **No lost events.** The gateway writes each event to a JSONL file before sending and removes it only after the
  cloud acknowledged it. Every event carries a UUID; ingestion is idempotent (`machine_events.event_id` unique),
  so resends after a crash or outage are harmless. Out-of-order replays never overwrite newer machine state.
- **Immutable financial history.** `gaming_transactions` (ledger), `machine_events` and `audit_logs` are
  append-only, enforced by database triggers. Corrections are new `ADJUSTMENT` rows with a mandatory reason.
- **Tamper evidence.** Audit entries form a per-tenant SHA-256 hash chain; `GET /api/v1/audit/verify`
  (button in the Audit Log page) recomputes it.
- **Multi-tenancy.** Every tenant table has `org_id`; every query is scoped by the JWT's org and the employee's
  casino assignments. Next hardening step: PostgreSQL row level security as a second line of defence.
- **Configure instead of code.** Modules are switched per casino in Settings (`casino_modules`); the navigation
  follows. RBAC matrix lives in `packages/shared/src/rbac.ts`.
- **Realtime.** Server-Sent Events (`/api/v1/stream`) over an in-process bus with a tiny interface, ready to be
  replaced by Redis/NATS/MQTT for multiple API instances.

### Phase 2 modules

- **Tickets (TITO)** `/tickets`: machines print tickets (`TICKET_OUT` creates a VALID ticket), other machines
  or the cashier redeem them. Validation, cancellation, void, reprint and amount adjustment (old ticket cancelled,
  new one issued, never edited). Tickets expire automatically (`casinos.ticket_expiry_days`, default 30).
  Full immutable history per ticket in `ticket_events`. A machine accepting a non-valid ticket raises a
  `TICKET_REJECTED` alert.
- **Cashier** `/cashier`: shifts per desk (opening float, expected vs. counted balance, differences raise a
  `CASH_DIFFERENCE` alert), ticket payout, ticket sale, cash in/out, vault fill/drop, jackpot handpays
  (pays and sends `RESET_JACKPOT` to the machine). Supervisors see all desks and the shift history.
- **Mobile Cashier** `/mobile`: full-screen tablet UI with big buttons, keypad, camera barcode scan
  (browsers with BarcodeDetector), handpays, player lookup, machine lock/unlock, alerts, shift.
- **Cash Management** `/cash`: money in drawers, ticket liability, machine drop collections against meter values.
- **Employees** `/employees`: create/edit staff, roles, casino access, deactivate, password reset, activity log.
- **Reports** `/reports`: 10 reports (daily gaming, machine/manufacturer performance, jackpots, tickets,
  cashier sessions, cash transactions, collections, alerts, audit) with filters and CSV / Excel / PDF export.

`cash_transactions`, `cash_collections` and `ticket_events` are append-only like the ledger.

### Player identity (migration 003)

Player identity is its own domain, separate from money, gaming and loyalty:

- `players`: pseudonymous identity (`player_no`, status, verification status). Money and gaming refer to `player_id` only.
- `player_profiles`: personal data. It can be anonymised or deleted without breaking money, gaming or audit records.
- `player_cards`: the **only** card lookup source. A card is an identifier, never a money container. One card number = one
  player per organisation, forever. At most one ACTIVE card per player. Blocking or replacing a card never touches money;
  a replacement card resolves to the same player (and later the same wallet).
- `player_verifications`, `player_status_history`, `player_card_events`: append-only history. Document numbers are
  stored only masked and as a keyed hash (`PII_HASH_SECRET`).
- Legacy `players.card_number`, `first_name`, `last_name` are read-only (database trigger): kept for compatibility, may
  only be cleared, never written.

Player status rules (single definition: `packages/shared/src/player.ts`):

| Status | Allowed |
|---|---|
| ACTIVE | everything |
| SUSPENDED | account frozen: only machine to wallet (so credits are never stranded) and profile maintenance |
| EXCLUDED | no card login, no money into the wallet, no transfers to machines, no new cards; existing balance can be withdrawn, machine to wallet stays possible |
| CLOSED | terminal, nothing |

A verification (KYC) threshold can be configured per organisation (`organizations.verification_threshold_cents`);
no amount is built in.

Money model (shared, no database yet): integer cents, canonical money transaction types and the posting matrix in
`packages/shared/src/money`. Machine events use canonical names (`CASH_IN`, `CASH_OUT`, `TITO_IN`, `TITO_OUT`,
`CASHLESS_IN`, `CASHLESS_OUT`); legacy names (`COIN_IN`, `COIN_OUT`, `TICKET_IN`, `TICKET_OUT`) are still accepted
and normalised at ingestion.

### Money ledger (migration 004)

Double-entry ledger, the financial source of truth. Integer cents, debit = destination (+), credit = source (-),
every money transaction sums to exactly 0 (checked by the database at COMMIT).

- Account kinds and transaction types come only from the shared model (`packages/shared/src/money`); the database
  reference tables are synced from it at startup (`syncMoneyModel`) and refuse diverging definitions.
- Wallet accounts are organisation-level (no casino); drawers, vaults, cashboxes, tickets, handpays and machine credits
  are casino-level. Player, wallet and card are references on the transaction only; a card is never an account.
- `money_transactions`, `ledger_entries` and `ledger_accounts` are immutable. `ledger_balances` is maintained only by the
  posting trigger and refuses overdrafts on non-negative accounts.
- One execution path: `executeMoneyTransaction` / `reverseMoneyTransaction` in `apps/api/src/services/ledger.ts`.
  Exactly once per `dedupe_key` (operator Idempotency-Key, machine event id or entity key). Reversals are new
  transactions that negate the original; one reversal per transaction.
- Gaming (bets/wins) never enters the ledger; `MACHINE_CREDIT` plus `GAMING_SETTLEMENT` is the bridge.
- `GET /api/v1/ledger/health` recomputes the invariants; `GET /api/v1/ledger/accounts` lists balances.
- Existing cashier/ticket/handpay flows still write their legacy tables; they move onto the ledger after the money
  entities (005) and opening balances (006).

### Money entities (migration 005)

Operational state of each money rail. Balances never live on these tables; they come from the ledger.

- **Wallet**: one per player, organisation-level, ACTIVE / BLOCKED (only cash-out to wallet) / CLOSED (terminal, needs
  zero balance). Balances via the `wallet_balances` view over the ledger.
- **Cashless session** (player, wallet, card, machine) and **wallet transfer** to/from a machine:
  REQUESTED -> SENT -> CONFIRMED, or FAILED / EXPIRED. REQUESTED only reserves funds; money moves on CONFIRMED.
- **Handpay**: PENDING -> APPROVED -> PAID -> MACHINE_RESET, or VOIDED before payment. Payment and machine reset are
  independent; one handpay per jackpot event; approver and payer must differ.
- **Vault**: vault per casino, vault sessions, append-only cash counts, cashier sessions linked to a vault session.
- **Approvals**: four-eyes (requester != decider), limits per casino in `casino_money_settings` (NULL = no approval).
- **Tickets**: HOLD on scan (hold id, expiry, machine) before redemption, released automatically when stale.
- Foreign keys point one way (ledger -> entity, command -> entity), so there are no circular references.
- Upgrade keeps all history and invents no balances: wallets for non-closed players, a Main Vault per casino,
  handpay entities for paid and currently pending jackpots only. Ledger stays empty until 006.

### Rail cutover (migration 006)

Legacy money moves onto the ledger one rail at a time: VAULT, CASH, HANDPAY, TITO per casino, CASHLESS per
organisation, MACHINE per machine. The migration itself moves nothing; every rail stays LEGACY until its cutover.

- `cutoverRail` (`apps/api/src/services/cutover.ts`), one database transaction: lock the rail's legacy tables, check,
  post OPENING_BALANCE transactions from verified legacy sources, reconcile ledger against legacy, record the cutover.
  Any failed check rolls everything back. Idempotent (a repeat returns the existing cutover). Forward-only.
- Opening sources: verified vault / desk / machine-collection counts (blind second count by another employee),
  outstanding tickets (VALID, HELD), unpaid handpays. Each source is used once (`money_backfill_items`).
  Wallets always open at zero; points, tier and play history are never money.
- Handpays are mapped only by jackpot event id; a legacy payment without one stops the cutover.
- After a cutover the ledger is the only money writer on the rail: database guards refuse legacy money writes
  unless they are the projection of a ledger transaction of the same database transaction.
- `POST /api/v1/money/counts`, `/counts/:id/verify`, `/money/cutover/dry-run`, `/money/cutover` (permission
  `money.cutover`), `GET /api/v1/money/rails`. A fresh demo database starts with CASHLESS on the ledger only.

### Ledger cash and vault (migration 007, Step 7a)

- **Final rail rule**, enforced by the ledger service and by a database trigger on `ledger_entries`: a LEGACY rail takes
  no ledger booking; a LEDGER rail takes no independent legacy money write (legacy rows are projections written by
  `legacy-projection.ts` in the same transaction); a frozen rail takes only corrections (ADJUSTMENT / REVERSAL);
  opening balances exist only inside a cutover.
- **Vault ↔ drawer** (`cash-ops.ts`): a fill is issued by the vault and confirmed by the cashier, a drop is handed in
  by the cashier and confirmed by the vault, each with the receiver's own count. REQUESTED moves nothing; a count
  mismatch rejects; unconfirmed requests expire.
- **Shift**: opens with an empty drawer (float = fill). Close = blind count → DRAWER_SHORT_OVER (supervisor approval
  above `short_over_approval_cents`) → final drop to the vault → closed with drawer 0.
- **Vault session**: blind opening / closing count verified by a second employee's blind count; the difference is
  booked as VAULT_COUNT_DIFFERENCE (counter = actor, verifier = approver). Fills / drops need a verified open vault.
- **Reconciliation** (`reconciliation.ts`, every 15 minutes and on demand): CASH (projection ↔ ledger per shift),
  VAULT (movements ↔ ledger, count settlements) and the global ledger invariants. A CRITICAL mismatch raises an alert
  and freezes the affected rail (global: everything); other rails continue. A freeze is lifted only after a clean run;
  a discrepancy that cannot be undone is explained by two different employees.
- **Day close**: only a past business date, only without freezes and with a clean run; afterwards that date takes no
  money transaction.
- Production cutover stays locked for VAULT / CASH until ticket payout and handpay run on the ledger (7b / 7c).

### Handpay on the ledger (migration 008, Step 7b)

- Jackpot event → handpay PENDING with HANDPAY_CREATE_JACKPOT (expense → payable) in the ingest transaction;
  approval only above `handpay_approval_cents` (approvals table, four eyes, approver ≠ payer); HANDPAY_PAY
  (payable → drawer, or → wallet with the HANDPAY_TO_WALLET capability) atomic with the state change; the cash row
  is a LegacyProjection carrying the jackpot event id. Verification required above the organisation threshold.
- Exactly once: one handpay per jackpot event, one payment and one creation booking per handpay (unique indexes),
  the Step 1 cash index, ledger dedupe keys and the HTTP Idempotency-Key.
- Machine reset is a separate gateway command: failure / timeout → FAILED → retried (job or
  `POST /api/v1/handpays/:id/reset`); late or duplicate responses confirm once; a reset never books money.
- Void before payment reverses the liability. LEGACY HANDPAY rails keep the Step 1 cash flow; a LEGACY HANDPAY with
  CASH on the ledger refuses payment instead of mixing.
- Legacy payments without jackpot event id (before Step 1) block the HANDPAY cutover until classified as LINK /
  HISTORICAL / DISPUTED by two employees with evidence (`/api/v1/handpays/legacy-exceptions`); no ledger money and
  no cash movement is created for history.
- Reconciliation adds HANDPAY (payable = open handpays, payments and creations booked once); mismatch freezes HANDPAY.
- Business date of a jackpot = casino date of `occurred_at` (`received_at` is receipt metadata, `replayed_at` replay
  metadata). A jackpot whose `occurred_at` is on another day than its receipt (delayed delivery, clock ahead) or that
  arrives while HANDPAY is frozen is recorded as a deferred money event and booked on that date through the validated
  replay path; a closed date is never bypassed (the record stays pending and is reported by reconciliation).

### TITO on the ledger (migration 010, Step 7c)

- Machine prints (TITO_OUT) → ticket VALID + TITO_ISSUE_MACHINE. Scan → `POST /gateway/tickets/hold` (no money) →
  accept ack = TITO_IN with `holdId` → TITO_REDEEM_MACHINE; reject → `/gateway/tickets/release`; timeouts release.
- Cashier sale / payout (cash or wallet) with LegacyProjection rows; payout above `ticket_payout_approval_cents` needs a
  four-eyes approval (`/tickets/:id/approval-request`), the approver cannot pay. Cancel and void (cashier sale only)
  are four-eyes requests executed on approval. Expiry is TITO_EXPIRY per ticket (HELD tickets never expire).
- A machine accept without a liability (unknown, final, held elsewhere) is TITO_EXCEPTION with the reported amount.
- D1: a machine that is still LEGACY books its ticket side on its own LEGACY_FLOOR_CLEARING account (database guard,
  reconciled; an unexplained balance blocks further TITO cutovers until explained by four eyes; target 0 in 7d).
- Frozen TITO / off-day events: deferred and replayed exactly once on the date of `occurred_at` (as jackpots).

**Rail dependency matrix** (A = technical, B = cutover prerequisite, C = maintenance window):

| State | Technically allowed | Protection | Unbalanced money possible | Cutover operationally |
|---|---|---|---|---|
| HANDPAY LEDGER + TITO LEGACY | yes | handpay postings never touch TITO; legacy ticket cash rows refused (CASH on ledger); TITO bookings refused (rail guard, service + DB) | no | window C: legacy ticket sale / payout stops until TITO follows |
| TITO LEDGER + HANDPAY LEGACY | yes | ticket postings never touch HANDPAY; legacy handpay cash payment refused (CASH on ledger); HANDPAY bookings refused | no | window C: legacy handpay payment stops until HANDPAY follows |
| HANDPAY LEDGER + CASH LEGACY | no (B: HANDPAY needs CASH) | cutover prerequisite; if forced: handpay rows need their booking, drawer bookings refused by the rail guard, all roll back | no | not reachable |
| TITO LEDGER + CASH LEGACY | no (B: TITO needs CASH) | cutover prerequisite; if forced: tickets need their booking, drawer bookings refused | no | not reachable |
| MACHINE LEDGER + TITO LEGACY | no (B: MACHINE needs TITO) | cutover prerequisite; if forced: machine money events need a booking, TICKET_LIABILITY bookings refused | no | not reachable |

Every booking is balanced (shared postings + database zero-sum check) and every account it touches must be on a
LEDGER, unfrozen rail (service guard + `ledger_entries` trigger), so a mixed state can stop legacy operations but
cannot produce a ledger movement on a legacy rail. The window C is operational, not a database switch.

### Machine money and cashless on the ledger (migration 011, Step 7d)

- Machine on the MACHINE ledger (per machine, after a verified empty collection; the cutover also closes its D1 floor
  clearing): CASH_IN → MACHINE_CASH_IN, CASH_OUT → MACHINE_CASH_OUT (hopper), CASHLESS_IN / CASHLESS_OUT with
  `transferId` = the machine's ack of a wallet transfer, CREDIT_METER → D3 gaming settlement (reliable meter or verified
  zero-credit state only, never estimated, otherwise unreconciled).
- Cashless at the machine: `/gateway/cashless/sessions`, `/gateway/cashless/transfers` (+ `/:id/sent`, `/:id/fail`).
  Wallet → machine reserves first; the ack moves it; an ack after FAILED / EXPIRED is LATE_CONFIRMED from
  CASHLESS_EXCEPTION (alerted, the wallet is never charged twice). Cashier ↔ wallet: `/cashier/wallet/deposit|withdraw`
  (approval above the limits, KYC above the threshold, drawer projection).
- Hopper fills (`/machines/:id/hopper-fills`, confirmed at the machine) and ledger collections (`/machines/:id/collections/count`,
  blind second count `/machines/collections/counts/:id/verify`: difference + drop booked; nothing on a mismatch).
- Machine events whose money part cannot be booked (duplicate barcode, unknown transfer, empty hopper, closed day, ...) are
  stored with an immutable exception record: a deterministic business rejection (`exceptions` in the ingest response),
  audited and alerted, never an HTTP 500 and never a booking; reconciliation reports them until explained by four eyes.
- Frozen machine (per machine) or CASHLESS: machine money events are deferred and replayed exactly once on the date of
  `occurred_at`, like jackpots and tickets. A deferred event whose business date is closed is booked only through the
  four-eyes late-event booking (`/money/deferred/:eventId/late-booking`) on today's open date; the original date stays.
- Reconciliation adds MACHINE (per-machine freeze) and CASHLESS (organisation-wide) checks.

### Operator screens and reconciliation (Step 7e)

- **Principle:** simple for the operator, powerful underneath. The screens only show state and ask for
  confirmations; every money action goes through the existing guarded API (MoneyService, rail guards,
  freezes, four eyes, closed business dates). No balance is computed in the browser.
- **Cashier** (`/cashier`, ledger casinos): shift opens empty (float = vault fill, confirmed by a blind
  count), one scan field for TITO tickets and player cards, TITO payout (CASH or CASHLESS wallet),
  CASHLESS deposit / withdrawal, HANDPAY (CASH or wallet), TITO sale, own approval requests, close by blind
  count (short / over approval, final drop). Generic cash in / out is not offered on the ledger. LEGACY
  casinos keep the previous workstation. The mobile cashier uses the same ledger panels.
- **Vault** (`/vault`): vault session with blind opening / closing counts verified by a second person,
  fills to shifts, drops from shifts, hopper fills and machine collections (blind counts, second count).
- **Approvals** (`/approvals`): one inbox for every four-eyes request with amount, affected ticket /
  machine / player / shift, requester and decider; the requester cannot decide; history with notes.
- **Reconciliation** (`/reconciliation`): latest run per rail with open items (four-eyes explanation),
  ledger ↔ meters per machine and period, unresolved deferred events and exceptions, and the exact list
  of what blocks the business-day close.
- **Money control** (`/money`): rail state LEGACY / LEDGER, cutover counts (blind, four eyes), dry run and
  cutover, freezes and lift, deferred events (late booking of a closed date), event exceptions, legacy
  handpay exceptions. Machine detail shows the machine's money rail, freezes, MACHINE CREDIT meter,
  deferred events, exceptions and hopper fills to confirm at the machine.
- **Every money-moving action** shows a confirmation with the exact amount and entity, uses one
  Idempotency-Key per operator intent (a retry of the same intent replays, it never books twice), shows a
  deterministic result (done, already done, or the API's refusal) and surfaces approval requirements first.
- **Read views** (no writes): `/operator/context`, `/cashier/shift`, `/players/lookup/:card`,
  `/vault/status`, `/money/deferred`, `/money/day-close/status`, `/money/reconciliation/meters`,
  `/money/counts`, `/machines/:id/money`; `/approvals` and `/machines/event-exceptions` carry names and states.
- **Ledger ↔ meters** (plan section 5): reconciliation check `machine.ledger_matches_meters` compares, per
  machine and money event type since its cutover, the reported amounts with the ledger bookings of those
  events; a difference freezes only that machine (explained by four eyes, never edited).
- **Expected machine collection, one definition** (`services/collections.ts`), used by `/cash/collections/expected`,
  the legacy booking `/cash/collections`, the ledger collection settlement and the MACHINE cutover check:
  a machine on the ledger expects its CASHBOX ledger balance; a machine still LEGACY expects the cash it reported
  (CASH_IN / COIN_IN events received since its last collection). Paper tickets are reported separately and never
  change the cash expectation. Ledger machines cannot use the legacy booking route (409); their collection is the
  blind count + blind second count in the Vault screen.
- **Blind count, enforced by the API** (`services/blind-count.ts`): a role that counts a target (cash.manage for
  vault, machine cashbox and cutover counts; the cashier for the own drawer) gets no expected amount and no
  balance revealing it: `/cash/collections/expected` is blind, `/vault/status` has no vault balance,
  `/ledger/accounts` withholds VAULT / CASHBOX / DRAWER balances, desks / sessions / cash overview leave the
  own drawer out, open fills / drops / hopper fills hide the amount from the confirming side, the meters
  report withholds cash amounts and the cutover dry run hides legacy amounts until the counts are verified.
  The submitted count, the authoritative expected amount and the difference are disclosed only by
  `GET /counts/:id/review` to a different employee with cash.manage (403 for the counter), who approves
  (verification with the same total: the approved settlement, the reviewer as approver) or rejects with an
  own different count (nothing booked, recount). The audit records both people and the values.
- Operator wording uses CASH, TITO, CASHLESS, HANDPAY and MACHINE CREDIT; gaming meters are shown as bets /
  wins (database fields `coin_in` / `coin_out` stay for adapter compatibility).

### Multi-tenant SaaS and entitlements (migration 012)

Commercial modules (CORE, TITO, HANDPAY, CASH, VAULT, CASHLESS, MACHINE, REPORTING, ADVANCED_RECONCILIATION)
come from the organisation's plan or a platform override, can be switched off by the customer admin and are
enforced by the API on every route (`403 MODULE_NOT_ENTITLED`). Menus, pages, direct URLs, dashboard sections,
reports, reconciliation and the day close follow the same entitlements. Platform administrators work in `/admin`
(organisations, plans, subscriptions, overrides, limits, onboarding, audit); customer admins in `/organization`.
Design, dependencies, error codes, limits, lifecycle and the safe defaults for upgraded customers:
[docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).

Production configuration: `NODE_ENV=production` refuses to start with the default or a short (< 32 characters)
`JWT_SECRET` / `PII_HASH_SECRET` unless `DEMO_MODE=true` (the compose demo sets it); set `CORS_ORIGIN`. Create the
first platform administrator of an upgraded installation with
`npm run platform-admin -w @m1/database -- <email> <password> [name]`.

### Accounting definitions

| Metric | Definition |
|---|---|
| Bets (turnover) | Sum of wagers (`WAGER` ledger rows from `GAME_PLAYED`; field `coin_in`) |
| Wins | Sum of game wins (`WIN`; field `coin_out`) |
| GGR | Bets - Wins - Jackpots |
| NGR | GGR + adjustments (promotional credits will be deducted once promotions exist) |
| Cash In | Bills inserted (`CASH_IN` events; legacy protocol name `COIN_IN`) |
| Tickets In / Out | TITO ticket values accepted / printed |

Business day = calendar day in the casino's timezone.

## API overview

`/api/v1/auth/login`, `/auth/me`, `/me/entitlements`, `/dashboard`, `/casinos`, `/floors`,
`/floors/:id/layout`, `/machines`, `/machines/:id`, `/machines/:id/commands`, `/machines/:id/maintenance`,
`/accounting/summary`, `/transactions`, `/transactions/adjustments`, `/alerts`, `/alerts/:id/acknowledge|resolve`,
`/audit`, `/audit/verify`, `/gateways`, `/simulation`, `/players`, `/jackpots`, `/employees`, `/stream` (SSE),
`/tickets`, `/tickets/lookup/:barcode`, `/tickets/redeem|issue`, `/tickets/:id/cancel|void|reprint|adjust`,
`/cashier/desks|session|session/open|session/close|sessions|transactions|handpays`, `/cash/overview|collections`,
`/reports`, `/reports/:key?format=json|csv|xlsx|pdf`, `/org`, `/org/modules/:module`, `/org/casinos`, `/org/machines`.

Platform API (platform administrators only): `/platform/organizations[/:id[/status|subscription|entitlements/:module|modules/:module|limits/:key|users|casinos|machines|audit]]`,
`/platform/plans[/:id]`, `/platform/registry`, `/platform/audit`.

Gateway device API (headers `x-gateway-id`, `x-gateway-key`): `/gateway/heartbeat`, `/gateway/events`,
`/gateway/commands/:id/result`.

## Roadmap

- **Phase 2 (done):** Ticket system (TITO), cashier & mobile cashier, cash management, employee management, reporting/exports
- **Phase 3:** Loyalty rules, player app (PWA), promotions engine, cashless sandbox
- **Phase 4:** Jackpot engine (mystery, time, wide area)
- **Phase 5:** Real hardware gateway, MQTT, device certificates, first real manufacturer integration (likely SAS)

## Regulatory note

The architecture is prepared for auditability (immutable ledger, hash-chained audit log, role separation, device
identification, event timestamps, configuration history). No regulatory requirements are implemented or claimed.
Real money, cashless, jackpot and gaming functions must be reviewed and certified against the regulations of each
jurisdiction before production use. JWT secret and gateway keys in this repo are demo values only.
