-- M1 Casino Cloud: Phase 1 schema.
-- Every tenant-owned table carries org_id. All API queries are scoped by it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Generic guard for append-only tables (ledger, audit log, events).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE casinos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  code        text NOT NULL,
  name        text NOT NULL,
  city        text,
  country     text,
  timezone    text NOT NULL DEFAULT 'Europe/Vienna',
  currency    text NOT NULL DEFAULT 'EUR',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX ON casinos (org_id);

CREATE TABLE casino_modules (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  casino_id   uuid NOT NULL REFERENCES casinos(id),
  module_key  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (casino_id, module_key)
);

CREATE TABLE floors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  casino_id   uuid NOT NULL REFERENCES casinos(id),
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  width       int NOT NULL DEFAULT 1200,
  height      int NOT NULL DEFAULT 700,
  -- Static fixtures (bar, cashier, entrance ...): [{id,label,kind,x,y,w,h}]
  layout      jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON floors (org_id, casino_id);

CREATE TABLE zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  floor_id    uuid NOT NULL REFERENCES floors(id),
  name        text NOT NULL,
  color       text
);

CREATE TABLE gateways (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  casino_id          uuid NOT NULL REFERENCES casinos(id),
  device_id          text NOT NULL UNIQUE,
  name               text NOT NULL,
  hardware           text,
  api_key_hash       text NOT NULL,
  status             text NOT NULL DEFAULT 'OFFLINE',
  last_heartbeat_at  timestamptz,
  last_ip            text,
  version            text,
  stats              jsonb NOT NULL DEFAULT '{}',
  -- Remote configuration, e.g. {"simulation":{"running":true,"eventsPerSecond":2}}
  config             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE machine_models (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  manufacturer  text NOT NULL,
  name          text NOT NULL,
  cabinet       text,
  UNIQUE (org_id, manufacturer, name)
);

CREATE TABLE players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  card_number     text NOT NULL,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  tier            text NOT NULL DEFAULT 'BRONZE',
  points          numeric(14,2) NOT NULL DEFAULT 0,
  total_coin_in   numeric(14,2) NOT NULL DEFAULT 0,
  visits          int NOT NULL DEFAULT 0,
  last_visit_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, card_number)
);

CREATE TABLE machines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  casino_id              uuid NOT NULL REFERENCES casinos(id),
  floor_id               uuid REFERENCES floors(id),
  zone_id                uuid REFERENCES zones(id),
  model_id               uuid REFERENCES machine_models(id),
  gateway_id             uuid REFERENCES gateways(id),
  machine_code           text NOT NULL,           -- e.g. VIE-001-000001
  asset_no               text NOT NULL,           -- e.g. M001
  serial_number          text,
  game                   text,
  denomination           numeric(10,2) NOT NULL DEFAULT 0.01,
  position_label         text,
  pos_x                  int NOT NULL DEFAULT 0,
  pos_y                  int NOT NULL DEFAULT 0,
  adapter_key            text NOT NULL DEFAULT 'simulator',
  adapter_config         jsonb NOT NULL DEFAULT '{}',
  -- live state
  status                 text NOT NULL DEFAULT 'OFFLINE',
  online                 boolean NOT NULL DEFAULT false,
  disabled               boolean NOT NULL DEFAULT false,
  maintenance            boolean NOT NULL DEFAULT false,
  error_code             text,
  door_open              boolean NOT NULL DEFAULT false,
  cashbox_open           boolean NOT NULL DEFAULT false,
  printer_error          boolean NOT NULL DEFAULT false,
  jackpot_pending        boolean NOT NULL DEFAULT false,
  current_player_id      uuid REFERENCES players(id),
  current_session_id     uuid,
  last_communication_at  timestamptz,
  status_changed_at      timestamptz,
  last_error             text,
  last_error_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, machine_code),
  UNIQUE (casino_id, asset_no)
);
CREATE INDEX ON machines (org_id, casino_id);

CREATE TABLE machine_meters (
  machine_id    uuid PRIMARY KEY REFERENCES machines(id),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  coin_in       numeric(14,2) NOT NULL DEFAULT 0,
  coin_out      numeric(14,2) NOT NULL DEFAULT 0,
  jackpot       numeric(14,2) NOT NULL DEFAULT 0,
  games_played  bigint NOT NULL DEFAULT 0,
  games_won     bigint NOT NULL DEFAULT 0,
  jackpot_wins  int NOT NULL DEFAULT 0,
  tickets_in    numeric(14,2) NOT NULL DEFAULT 0,
  tickets_out   numeric(14,2) NOT NULL DEFAULT 0,
  cash_in       numeric(14,2) NOT NULL DEFAULT 0,
  cash_out      numeric(14,2) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE machine_events (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL UNIQUE,                 -- idempotency key from the gateway
  org_id       uuid NOT NULL REFERENCES organizations(id),
  casino_id    uuid NOT NULL REFERENCES casinos(id),
  machine_id   uuid NOT NULL REFERENCES machines(id),
  gateway_id   uuid REFERENCES gateways(id),
  type         text NOT NULL,
  amount       numeric(14,2),
  win          numeric(14,2),
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON machine_events (org_id, casino_id, occurred_at DESC);
CREATE INDEX ON machine_events (machine_id, occurred_at DESC);
CREATE TRIGGER machine_events_immutable BEFORE UPDATE OR DELETE ON machine_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE machine_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  machine_id      uuid NOT NULL REFERENCES machines(id),
  gateway_id      uuid REFERENCES gateways(id),
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'PENDING',   -- PENDING, SENT, SUCCEEDED, FAILED
  requested_by    uuid,
  result_message  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX ON machine_commands (gateway_id, status);

CREATE TABLE player_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  casino_id     uuid NOT NULL REFERENCES casinos(id),
  player_id     uuid NOT NULL REFERENCES players(id),
  machine_id    uuid NOT NULL REFERENCES machines(id),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  coin_in       numeric(14,2) NOT NULL DEFAULT 0,
  games_played  int NOT NULL DEFAULT 0
);
CREATE INDEX ON player_sessions (org_id, casino_id, ended_at);

-- Immutable financial ledger. Corrections are new ADJUSTMENT rows, never updates.
CREATE TABLE gaming_transactions (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id),
  casino_id        uuid NOT NULL REFERENCES casinos(id),
  machine_id       uuid REFERENCES machines(id),
  player_id        uuid REFERENCES players(id),
  type             text NOT NULL,
  amount           numeric(14,2) NOT NULL,
  source_event_id  uuid,
  reference        text,
  created_by       uuid,
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON gaming_transactions (org_id, casino_id, occurred_at DESC);
CREATE INDEX ON gaming_transactions (machine_id, occurred_at DESC);
CREATE TRIGGER gaming_transactions_immutable BEFORE UPDATE OR DELETE ON gaming_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE jackpots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  casino_id          uuid NOT NULL REFERENCES casinos(id),
  name               text NOT NULL,
  type               text NOT NULL,      -- LOCAL, LINKED, WIDE_AREA, MYSTERY, TIME
  base_value         numeric(14,2) NOT NULL,
  current_value      numeric(14,2) NOT NULL,
  max_value          numeric(14,2),
  contribution_rate  numeric(6,4) NOT NULL DEFAULT 0.01,
  status             text NOT NULL DEFAULT 'ACTIVE',
  config             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jackpot_events (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  jackpot_id  uuid NOT NULL REFERENCES jackpots(id),
  machine_id  uuid REFERENCES machines(id),
  type        text NOT NULL,
  amount      numeric(14,2),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Which casinos an employee may access (SUPER_ADMIN sees all casinos of the org).
CREATE TABLE employee_casinos (
  employee_id  uuid NOT NULL REFERENCES employees(id),
  casino_id    uuid NOT NULL REFERENCES casinos(id),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (employee_id, casino_id)
);

-- Reference copy of the role/permission matrix (source of truth: @m1/shared rbac.ts).
CREATE TABLE roles (
  key   text PRIMARY KEY,
  name  text NOT NULL
);
CREATE TABLE permissions (
  key  text PRIMARY KEY
);
CREATE TABLE role_permissions (
  role_key        text NOT NULL REFERENCES roles(key),
  permission_key  text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  casino_id         uuid NOT NULL REFERENCES casinos(id),
  machine_id        uuid REFERENCES machines(id),
  gateway_id        uuid REFERENCES gateways(id),
  type              text NOT NULL,
  severity          text NOT NULL,      -- INFO, WARNING, CRITICAL
  message           text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN',   -- OPEN, ACKNOWLEDGED, RESOLVED
  created_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES employees(id),
  resolved_at       timestamptz
);
CREATE INDEX ON alerts (org_id, casino_id, status, created_at DESC);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  alert_id    uuid REFERENCES alerts(id),
  channel     text NOT NULL,      -- WEB, EMAIL, PUSH, SMS
  recipient   text,
  status      text NOT NULL DEFAULT 'PENDING',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Tamper-evident audit trail: each row stores the hash of the previous row of the same org.
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  org_id       uuid REFERENCES organizations(id),
  casino_id    uuid REFERENCES casinos(id),
  actor_type   text NOT NULL,      -- EMPLOYEE, GATEWAY, SYSTEM
  actor_id     uuid,
  actor_name   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  details      jsonb NOT NULL DEFAULT '{}',
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  hash         text NOT NULL
);
CREATE INDEX ON audit_logs (org_id, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
