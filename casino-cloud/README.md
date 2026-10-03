# M1 Casino Cloud

Modular, multi-tenant casino management SaaS: machine management, floor control, accounting, alerts and audit,
connected to gaming machines through an edge gateway and a manufacturer-neutral adapter layer.

**Status: Phase 1 (MVP) with simulated machines.** No real manufacturer protocols, no real money functions.

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
| cashier@example.com | CASHIER (sees almost nothing in Phase 1, by design) |
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
`/audit`, `/audit/verify`, `/gateways`, `/simulation`, `/players`, `/jackpots`, `/employees`, `/stream` (SSE).

Gateway device API (headers `x-gateway-id`, `x-gateway-key`): `/gateway/heartbeat`, `/gateway/events`,
`/gateway/commands/:id/result`.

## Roadmap

- **Phase 2:** Ticket system (TITO), cashier & mobile cashier, cash management, employee management UI, reporting/exports
- **Phase 3:** Loyalty rules, player app (PWA), promotions engine, cashless sandbox
- **Phase 4:** Jackpot engine (mystery, time, wide area)
- **Phase 5:** Real hardware gateway, MQTT, device certificates, first real manufacturer integration (likely SAS)

## Regulatory note

The architecture is prepared for auditability (immutable ledger, hash-chained audit log, role separation, device
identification, event timestamps, configuration history). No regulatory requirements are implemented or claimed.
Real money, cashless, jackpot and gaming functions must be reviewed and certified against the regulations of each
jurisdiction before production use. JWT secret and gateway keys in this repo are demo values only.
