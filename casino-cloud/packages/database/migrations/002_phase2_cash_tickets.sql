-- Phase 2: TITO tickets, cashier, cash management, employee management.

ALTER TABLE casinos ADD COLUMN ticket_expiry_days int NOT NULL DEFAULT 30;
ALTER TABLE employees ADD COLUMN phone text;
ALTER TABLE employees ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE tickets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  casino_id            uuid NOT NULL REFERENCES casinos(id),
  barcode              text NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  status               text NOT NULL DEFAULT 'VALID',   -- VALID, REDEEMED, CANCELLED, EXPIRED, VOID
  issued_by_machine_id uuid REFERENCES machines(id),
  issued_by_employee   uuid REFERENCES employees(id),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  redeemed_at          timestamptz,
  redeemed_machine_id  uuid REFERENCES machines(id),
  redeemed_by_employee uuid REFERENCES employees(id),
  redeemed_session_id  uuid,
  status_reason        text,
  reprint_count        int NOT NULL DEFAULT 0,
  replaces_ticket_id   uuid REFERENCES tickets(id),
  source_event_id      uuid,
  UNIQUE (org_id, barcode)
);
CREATE INDEX ON tickets (org_id, casino_id, status, issued_at DESC);

-- Full, immutable history of every ticket.
CREATE TABLE ticket_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  ticket_id    uuid NOT NULL REFERENCES tickets(id),
  action       text NOT NULL,     -- ISSUED, REDEEMED, CANCELLED, VOIDED, EXPIRED, REPRINTED, REPLACED, REJECTED
  machine_id   uuid REFERENCES machines(id),
  employee_id  uuid REFERENCES employees(id),
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ticket_events (ticket_id);
CREATE TRIGGER ticket_events_immutable BEFORE UPDATE OR DELETE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE cash_desks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  casino_id   uuid NOT NULL REFERENCES casinos(id),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'DESK',   -- DESK, MOBILE
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A cashier shift on one desk. Closing it records counted vs. expected balance.
CREATE TABLE cashier_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  casino_id        uuid NOT NULL REFERENCES casinos(id),
  cash_desk_id     uuid NOT NULL REFERENCES cash_desks(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  status           text NOT NULL DEFAULT 'OPEN',   -- OPEN, CLOSED
  opening_balance  numeric(14,2) NOT NULL,
  expected_balance numeric(14,2),
  counted_balance  numeric(14,2),
  difference       numeric(14,2),
  close_note       text,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE UNIQUE INDEX one_open_session_per_desk ON cashier_sessions (cash_desk_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX one_open_session_per_employee ON cashier_sessions (employee_id) WHERE status = 'OPEN';

CREATE TABLE cash_transactions (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  casino_id    uuid NOT NULL REFERENCES casinos(id),
  session_id   uuid NOT NULL REFERENCES cashier_sessions(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  type         text NOT NULL,
  amount       numeric(14,2) NOT NULL,     -- signed drawer effect
  ticket_id    uuid REFERENCES tickets(id),
  machine_id   uuid REFERENCES machines(id),
  player_id    uuid REFERENCES players(id),
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_transactions (session_id);
CREATE INDEX ON cash_transactions (org_id, casino_id, created_at DESC);
CREATE TRIGGER cash_transactions_immutable BEFORE UPDATE OR DELETE ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Machine drop collection: counted cashbox vs. what the meters say should be inside.
CREATE TABLE cash_collections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  casino_id     uuid NOT NULL REFERENCES casinos(id),
  machine_id    uuid NOT NULL REFERENCES machines(id),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  expected_cash numeric(14,2) NOT NULL,
  expected_tickets numeric(14,2) NOT NULL,
  counted_cash  numeric(14,2) NOT NULL,
  counted_tickets numeric(14,2) NOT NULL,
  difference    numeric(14,2) NOT NULL,
  note          text,
  collected_by  uuid NOT NULL REFERENCES employees(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_collections (machine_id, created_at DESC);
CREATE TRIGGER cash_collections_immutable BEFORE UPDATE OR DELETE ON cash_collections
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every existing casino gets a main cage and two mobile cashier devices.
INSERT INTO cash_desks (org_id, casino_id, name, kind)
SELECT c.org_id, c.id, d.name, d.kind FROM casinos c
CROSS JOIN (VALUES ('Main Cage', 'DESK'), ('Mobile Cashier 1', 'MOBILE'), ('Mobile Cashier 2', 'MOBILE')) d(name, kind);

-- Keep the RBAC reference tables in sync with the code.
INSERT INTO permissions (key) VALUES ('report.export'), ('ticket.view'), ('ticket.manage'), ('cashier.supervise'), ('cash.manage')
ON CONFLICT DO NOTHING;
