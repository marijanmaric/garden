-- 007 (Step 7a): final ledger rail guard, rail freezes, reconciliation, business day close and the
-- ledger-backed vault / cash drawer operations (fills, drops, counts, short / over).
--
-- The rule, enforced here independently of the application:
--   LEGACY rail -> no ledger booking on its accounts.
--   LEDGER rail -> no independent legacy money write (006 guards; legacy rows are projections).
--   Frozen rail -> only corrections (ADJUSTMENT / REVERSAL) until the freeze is lifted.
-- Opening balances exist only inside a cutover. Nothing here moves or rewrites money.

-- ---------------------------------------------------------------------------------------------
-- Rail of each account kind (filled from the shared model by syncMoneyModel)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ledger_account_kinds
  ADD COLUMN cutover_rail text CHECK (cutover_rail IN ('VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE'));

-- ---------------------------------------------------------------------------------------------
-- Reconciliation runs, freezes, resolutions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reconciliation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  casino_id    uuid REFERENCES casinos(id),
  trigger      text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL', 'DAY_CLOSE', 'LIFT')),
  ok           boolean NOT NULL,
  checks       jsonb NOT NULL,
  employee_id  uuid REFERENCES employees(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reconciliation_runs (org_id, casino_id, created_at DESC);
CREATE TRIGGER reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON reconciliation_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE money_rail_freezes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  rail                    text NOT NULL CHECK (rail IN ('VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE', 'GLOBAL')),
  casino_id               uuid REFERENCES casinos(id),          -- NULL: organisation-wide (CASHLESS, GLOBAL)
  machine_id              uuid REFERENCES machines(id),
  reason                  text NOT NULL,
  reconciliation_run_id   uuid REFERENCES reconciliation_runs(id),
  frozen_at               timestamptz NOT NULL DEFAULT now(),
  lifted_at               timestamptz,
  lifted_by               uuid REFERENCES employees(id),
  lift_reason             text,
  lift_run_id             uuid REFERENCES reconciliation_runs(id),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_run_id IS NULL))
);
CREATE UNIQUE INDEX money_rail_freezes_one_active ON money_rail_freezes (org_id, rail, casino_id, machine_id) NULLS NOT DISTINCT WHERE lifted_at IS NULL;

-- A freeze can only be lifted (once); nothing else changes, nothing is deleted.
CREATE OR REPLACE FUNCTION money_rail_freezes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'money_rail_freezes cannot be deleted'; END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL OR NEW.org_id <> OLD.org_id OR NEW.rail <> OLD.rail
     OR NEW.casino_id IS DISTINCT FROM OLD.casino_id OR NEW.machine_id IS DISTINCT FROM OLD.machine_id OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'money_rail_freezes: a freeze can only be lifted once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER money_rail_freezes_guard BEFORE UPDATE OR DELETE ON money_rail_freezes FOR EACH ROW EXECUTE FUNCTION money_rail_freezes_guard();

-- Frozen: the rail itself (casino / org for CASHLESS / whole rail or one machine) or a GLOBAL freeze
-- of the organisation or the casino.
CREATE OR REPLACE FUNCTION money_rail_frozen(p_org uuid, p_casino uuid, p_rail text, p_machine uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM money_rail_freezes f
    WHERE f.org_id = p_org AND f.lifted_at IS NULL
      AND (
        (f.rail = 'GLOBAL' AND (f.casino_id IS NULL OR f.casino_id = p_casino))
        OR (p_rail IS NOT NULL AND f.rail = p_rail
            AND f.casino_id IS NOT DISTINCT FROM (CASE WHEN p_rail = 'CASHLESS' THEN NULL ELSE p_casino END)
            AND (f.machine_id IS NULL OR f.machine_id = p_machine))))
$$ LANGUAGE sql STABLE;

-- Explained discrepancies: an item (e.g. one projection row) explained by two different employees.
CREATE TABLE reconciliation_resolutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  casino_id     uuid REFERENCES casinos(id),
  item_key      text NOT NULL,
  explanation   text NOT NULL CHECK (length(explanation) >= 10),
  requested_by  uuid NOT NULL REFERENCES employees(id),
  approved_by   uuid NOT NULL REFERENCES employees(id),
  approval_id   uuid NOT NULL REFERENCES approvals(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_resolutions_four_eyes CHECK (approved_by <> requested_by),
  CONSTRAINT reconciliation_resolutions_once UNIQUE (org_id, item_key)
);
CREATE TRIGGER reconciliation_resolutions_immutable BEFORE UPDATE OR DELETE ON reconciliation_resolutions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Business day close: a closed casino business date takes no further money transactions
-- (late events / corrections need an explicit process, never a silent date change).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE business_day_closes (
  casino_id              uuid NOT NULL REFERENCES casinos(id),
  business_date          date NOT NULL,
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  closed_by              uuid NOT NULL REFERENCES employees(id),
  reconciliation_run_id  uuid NOT NULL REFERENCES reconciliation_runs(id),
  closed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (casino_id, business_date)
);
CREATE TRIGGER business_day_closes_immutable BEFORE UPDATE OR DELETE ON business_day_closes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION money_transactions_business_day_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.casino_id IS NOT NULL AND EXISTS (SELECT 1 FROM business_day_closes WHERE casino_id = NEW.casino_id AND business_date = NEW.business_date) THEN
    RAISE EXCEPTION 'money transaction: business date % of this casino is closed', NEW.business_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER money_transactions_business_day_guard BEFORE INSERT ON money_transactions FOR EACH ROW EXECUTE FUNCTION money_transactions_business_day_guard();

-- ---------------------------------------------------------------------------------------------
-- The ledger rail guard (database layer of the final rule)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entries_rail_guard() RETURNS trigger AS $$
DECLARE acc ledger_accounts%ROWTYPE; tx money_transactions%ROWTYPE; rail text; cutover text;
BEGIN
  SELECT * INTO acc FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT * INTO tx FROM money_transactions WHERE id = NEW.transaction_id;
  SELECT cutover_rail INTO rail FROM ledger_account_kinds WHERE code = acc.kind;
  IF tx.type NOT IN ('ADJUSTMENT', 'REVERSAL') AND money_rail_frozen(acc.org_id, COALESCE(acc.casino_id, tx.casino_id), rail, acc.machine_id) THEN
    RAISE EXCEPTION 'ledger: % is frozen after a reconciliation mismatch; only corrections are allowed', COALESCE(rail, 'the ledger');
  END IF;
  IF tx.type = 'OPENING_BALANCE' THEN
    cutover := current_setting('m1.cutover_id', true);
    IF cutover IS NULL OR cutover = '' THEN
      RAISE EXCEPTION 'ledger: opening balances are only created by a rail cutover';
    END IF;
    RETURN NEW;
  END IF;
  IF rail IS NOT NULL AND NOT money_rail_ledger(acc.org_id, acc.casino_id, rail, acc.machine_id) THEN
    RAISE EXCEPTION 'ledger: % is not on the ledger for this account (cutover pending); legacy money stays legacy', rail;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_rail_guard BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_rail_guard();

-- Every opening balance belongs to exactly one backfill item of a cutover (checked at COMMIT).
CREATE OR REPLACE FUNCTION money_transactions_opening_source() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM money_backfill_items WHERE money_transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'money transaction %: opening balance without cutover backfill item', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER money_transactions_opening_source AFTER INSERT ON money_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'OPENING_BALANCE') EXECUTE FUNCTION money_transactions_opening_source();

-- ---------------------------------------------------------------------------------------------
-- Vault <-> drawer movements: money moves only on confirmation by the receiving side
-- ---------------------------------------------------------------------------------------------
ALTER TABLE casino_money_settings
  ADD COLUMN cash_movement_timeout_seconds int NOT NULL DEFAULT 900 CHECK (cash_movement_timeout_seconds BETWEEN 30 AND 86400);

CREATE TABLE cash_movements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  casino_id               uuid NOT NULL REFERENCES casinos(id),
  kind                    text NOT NULL CHECK (kind IN ('FILL', 'DROP')),
  vault_id                uuid NOT NULL REFERENCES vaults(id),
  vault_session_id        uuid NOT NULL REFERENCES vault_sessions(id),
  cashier_session_id      uuid NOT NULL REFERENCES cashier_sessions(id),
  amount_cents            bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000000000),
  purpose                 text NOT NULL DEFAULT 'SHIFT' CHECK (purpose IN ('SHIFT', 'CLOSE')),   -- CLOSE = final drop of a shift
  status                  text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  request_key             text NOT NULL,
  requested_by            uuid NOT NULL REFERENCES employees(id),
  requested_at            timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  decided_by              uuid REFERENCES employees(id),
  decided_at              timestamptz,
  confirmed_count_cents   bigint CHECK (confirmed_count_cents >= 0),
  note                    text,
  money_transaction_id    uuid UNIQUE REFERENCES money_transactions(id),
  CONSTRAINT cash_movements_request_key UNIQUE (org_id, request_key),
  CONSTRAINT cash_movements_four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT cash_movements_money CHECK ((status = 'CONFIRMED') = (money_transaction_id IS NOT NULL)),
  CONSTRAINT cash_movements_close_is_drop CHECK (purpose = 'SHIFT' OR kind = 'DROP')
);
CREATE UNIQUE INDEX cash_movements_one_open_close_drop ON cash_movements (cashier_session_id) WHERE purpose = 'CLOSE' AND status = 'REQUESTED';
CREATE INDEX ON cash_movements (casino_id, status, requested_at DESC);
CREATE INDEX ON cash_movements (cashier_session_id);
CREATE TRIGGER cash_movements_transition BEFORE UPDATE ON cash_movements FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('REQUESTED>CONFIRMED', 'REQUESTED>REJECTED', 'REQUESTED>EXPIRED', 'REQUESTED>CANCELLED');

CREATE OR REPLACE FUNCTION cash_movements_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cash_movements cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id)
       OR NOT EXISTS (SELECT 1 FROM vault_sessions WHERE id = NEW.vault_session_id AND vault_id = NEW.vault_id)
       OR NOT EXISTS (SELECT 1 FROM cashier_sessions WHERE id = NEW.cashier_session_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
      RAISE EXCEPTION 'cash_movements: vault, vault session and cashier session must belong to the same casino';
    END IF;
  ELSIF NEW.amount_cents <> OLD.amount_cents OR NEW.kind <> OLD.kind OR NEW.vault_id <> OLD.vault_id OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'cash_movements: amount, parties and references are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cash_movements_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION cash_movements_guard();

-- ---------------------------------------------------------------------------------------------
-- Count settlements: a verified count compared with the ledger at that moment (vault open / close,
-- drawer close). The difference is booked (VAULT_COUNT_DIFFERENCE / DRAWER_SHORT_OVER) once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE count_settlements (
  count_id              uuid PRIMARY KEY REFERENCES cash_counts(id),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  casino_id             uuid NOT NULL REFERENCES casinos(id),
  ledger_cents          bigint NOT NULL,
  counted_cents         bigint NOT NULL CHECK (counted_cents >= 0),
  difference_cents      bigint NOT NULL,
  approval_id           uuid REFERENCES approvals(id),
  money_transaction_id  uuid UNIQUE REFERENCES money_transactions(id),
  settled_by            uuid NOT NULL REFERENCES employees(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT count_settlements_math CHECK (difference_cents = counted_cents - ledger_cents),
  CONSTRAINT count_settlements_booked CHECK ((difference_cents = 0) = (money_transaction_id IS NULL))
);
CREATE TRIGGER count_settlements_immutable BEFORE UPDATE OR DELETE ON count_settlements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE cash_movements IS 'Vault <-> drawer fills and drops. REQUESTED moves nothing; CONFIRMED = exactly one ledger transaction.';
COMMENT ON TABLE money_rail_freezes IS 'A CRITICAL reconciliation mismatch freezes the affected rail (GLOBAL: everything) until lifted after a clean run.';
