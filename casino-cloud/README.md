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
| admin@riverside.example | Admin of a second tenant (proves tenant isolation) |

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

### Accounting definitions

| Metric | Definition |
|---|---|
| Coin In | Sum of wagers (`WAGER` ledger rows from `GAME_PLAYED`) |
| Coin Out | Sum of game wins (`WIN`) |
| GGR | Coin In - Coin Out - Jackpots |
| NGR | GGR + adjustments (promotional credits will be deducted once promotions exist) |
| Cash In | Bills/coins inserted (`COIN_IN` events) |
| Tickets In / Out | TITO ticket values accepted / printed |

Business day = calendar day in the casino's timezone.

## API overview

`/api/v1/auth/login`, `/auth/me`, `/dashboard`, `/casinos`, `/casinos/:id/modules`, `/floors`,
`/floors/:id/layout`, `/machines`, `/machines/:id`, `/machines/:id/commands`, `/machines/:id/maintenance`,
`/accounting/summary`, `/transactions`, `/transactions/adjustments`, `/alerts`, `/alerts/:id/acknowledge|resolve`,
`/audit`, `/audit/verify`, `/gateways`, `/simulation`, `/players`, `/jackpots`, `/employees`, `/stream` (SSE),
`/tickets`, `/tickets/lookup/:barcode`, `/tickets/redeem|issue`, `/tickets/:id/cancel|void|reprint|adjust`,
`/cashier/desks|session|session/open|session/close|sessions|transactions|handpays`, `/cash/overview|collections`,
`/reports`, `/reports/:key?format=json|csv|xlsx|pdf`.

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
