-- 006: Money backfill / rail cutover.
--
-- A rail (VAULT, CASH, HANDPAY, TITO per casino; CASHLESS per organisation; MACHINE per machine)
-- moves from LEGACY money to LEDGER money in ONE database transaction (apps/api/src/services/cutover.ts):
-- lock the rail's legacy tables, verify, post opening balances from verified legacy sources,
-- reconcile ledger against legacy, record the cutover. Any failed check rolls everything back.
--
-- This migration only adds the mechanism. It moves no money, posts no opening balance and changes
-- no historical row: every rail stays LEGACY until its cutover is executed.
--
-- After a rail's cutover the ledger service is the ONLY money writer on it. Legacy tables may still
-- be written, but only as a projection of a ledger transaction created in the same database
-- transaction (guards below). There is no way back: corrections are reversals / adjustments.

-- ---------------------------------------------------------------------------------------------
-- Cutover counts: physical counts with a blind second count (four eyes)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash_counts
  ADD COLUMN vault_id uuid REFERENCES vaults(id),
  ADD COLUMN cash_desk_id uuid REFERENCES cash_desks(id),
  DROP CONSTRAINT cash_counts_context_check,
  ADD CONSTRAINT cash_counts_context_check CHECK (context IN ('VAULT_OPEN', 'VAULT_CLOSE', 'DRAWER_CLOSE', 'MACHINE_DROP', 'VAULT_CUTOVER', 'DRAWER_CUTOVER')),
  ADD CONSTRAINT cash_counts_vault_cutover_ref CHECK (context <> 'VAULT_CUTOVER' OR vault_id IS NOT NULL),
  ADD CONSTRAINT cash_counts_drawer_cutover_ref CHECK (context <> 'DRAWER_CUTOVER' OR cash_desk_id IS NOT NULL);
CREATE INDEX ON cash_counts (casino_id, context, created_at DESC);

CREATE OR REPLACE FUNCTION cash_counts_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.vault_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault_sessions WHERE id = NEW.vault_session_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cash_counts: vault session belongs to another casino';
  END IF;
  IF NEW.cashier_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cashier_sessions WHERE id = NEW.cashier_session_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cash_counts: cashier session belongs to another casino';
  END IF;
  IF NEW.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cash_counts: machine belongs to another casino';
  END IF;
  IF NEW.vault_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cash_counts: vault belongs to another casino';
  END IF;
  IF NEW.cash_desk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cash_desks WHERE id = NEW.cash_desk_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cash_counts: cash desk belongs to another casino';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A second employee counts the same cash blind. The count is verified only by a matching second count.
CREATE TABLE cash_count_verifications (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  count_id     uuid NOT NULL REFERENCES cash_counts(id),
  total_cents  bigint NOT NULL CHECK (total_cents >= 0),
  matches      boolean NOT NULL,
  verified_by  uuid NOT NULL REFERENCES employees(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_count_verifications (count_id);

CREATE OR REPLACE FUNCTION cash_count_verifications_guard() RETURNS trigger AS $$
DECLARE c cash_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM cash_counts WHERE id = NEW.count_id;
  IF c.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'cash_count_verifications: count belongs to another organisation';
  END IF;
  IF c.counted_by = NEW.verified_by THEN
    RAISE EXCEPTION 'cash_count_verifications: the second count must be done by a different employee';
  END IF;
  NEW.matches := (NEW.total_cents = c.total_cents);   -- computed, never trusted from the client
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cash_count_verifications_guard BEFORE INSERT ON cash_count_verifications FOR EACH ROW EXECUTE FUNCTION cash_count_verifications_guard();
CREATE TRIGGER cash_count_verifications_immutable BEFORE UPDATE OR DELETE ON cash_count_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Cutovers (a row = the rail is on the ledger) and the opening balance items they created
-- ---------------------------------------------------------------------------------------------
CREATE TABLE money_rail_cutovers (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES organizations(id),
  rail                 text NOT NULL CHECK (rail IN ('VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE')),
  casino_id            uuid REFERENCES casinos(id),
  machine_id           uuid REFERENCES machines(id),
  as_of                timestamptz NOT NULL DEFAULT now(),   -- snapshot time (all legacy tables locked)
  business_date        date NOT NULL,
  actor_type           text NOT NULL CHECK (actor_type IN ('EMPLOYEE', 'SYSTEM')),
  executed_by          uuid REFERENCES employees(id),
  opening_count        int NOT NULL CHECK (opening_count >= 0),
  opening_total_cents  bigint NOT NULL CHECK (opening_total_cents >= 0),
  legacy_totals        jsonb NOT NULL,
  ledger_totals        jsonb NOT NULL,
  checks               jsonb NOT NULL,
  created_txid         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT money_rail_cutovers_scope CHECK (
    (rail = 'CASHLESS' AND casino_id IS NULL AND machine_id IS NULL)
    OR (rail = 'MACHINE' AND casino_id IS NOT NULL AND machine_id IS NOT NULL)
    OR (rail NOT IN ('CASHLESS', 'MACHINE') AND casino_id IS NOT NULL AND machine_id IS NULL)),
  CONSTRAINT money_rail_cutovers_once UNIQUE NULLS NOT DISTINCT (org_id, rail, casino_id, machine_id),
  CONSTRAINT money_rail_cutovers_actor CHECK ((actor_type = 'EMPLOYEE') = (executed_by IS NOT NULL))
);

CREATE OR REPLACE FUNCTION money_rail_cutovers_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.casino_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM casinos WHERE id = NEW.casino_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money_rail_cutovers: casino belongs to another organisation';
  END IF;
  IF NEW.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'money_rail_cutovers: machine does not belong to this casino';
  END IF;
  NEW.created_txid := pg_current_xact_id();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER money_rail_cutovers_guard BEFORE INSERT ON money_rail_cutovers FOR EACH ROW EXECUTE FUNCTION money_rail_cutovers_guard();
CREATE TRIGGER money_rail_cutovers_immutable BEFORE UPDATE OR DELETE ON money_rail_cutovers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE money_backfill_items (
  id                    bigserial PRIMARY KEY,
  cutover_id            uuid NOT NULL REFERENCES money_rail_cutovers(id) DEFERRABLE INITIALLY DEFERRED,
  org_id                uuid NOT NULL REFERENCES organizations(id),
  source_table          text NOT NULL CHECK (source_table IN ('cash_counts', 'tickets', 'handpays')),
  source_id             text NOT NULL,
  account_kind          text NOT NULL REFERENCES ledger_account_kinds(code),
  amount_cents          bigint NOT NULL CHECK (amount_cents >= 0),
  money_transaction_id  uuid UNIQUE REFERENCES money_transactions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- A legacy source (ticket, handpay, verified count) is used by exactly one cutover, once.
  CONSTRAINT money_backfill_items_once UNIQUE (source_table, source_id),
  CONSTRAINT money_backfill_items_tx CHECK ((amount_cents = 0) = (money_transaction_id IS NULL))
);
CREATE INDEX ON money_backfill_items (cutover_id);
CREATE TRIGGER money_backfill_items_immutable BEFORE UPDATE OR DELETE ON money_backfill_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Is the rail on the ledger? Only a cutover committed by ANOTHER database transaction counts, so the
-- cutover transaction itself still sees (and may finish) the legacy state it is converting.
CREATE OR REPLACE FUNCTION money_rail_ledger(p_org uuid, p_casino uuid, p_rail text, p_machine uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM money_rail_cutovers c
    WHERE c.org_id = p_org AND c.rail = p_rail
      AND c.casino_id IS NOT DISTINCT FROM (CASE WHEN p_rail = 'CASHLESS' THEN NULL ELSE p_casino END)
      AND c.machine_id IS NOT DISTINCT FROM (CASE WHEN p_rail = 'MACHINE' THEN p_machine ELSE NULL END)
      AND c.created_txid <> pg_current_xact_id())
$$ LANGUAGE sql STABLE;

-- Rails a legacy cash_transactions type moves money on (mirrors LEGACY_CASH_TX_RAILS in @m1/shared).
CREATE OR REPLACE FUNCTION legacy_cash_tx_rails(p_type text) RETURNS text[] AS $$
  SELECT CASE p_type
    WHEN 'FILL' THEN ARRAY['CASH', 'VAULT']
    WHEN 'DROP' THEN ARRAY['CASH', 'VAULT']
    WHEN 'TICKET_ISSUE' THEN ARRAY['CASH', 'TITO']
    WHEN 'TICKET_PAYOUT' THEN ARRAY['CASH', 'TITO']
    WHEN 'HANDPAY' THEN ARRAY['CASH', 'HANDPAY']
    ELSE ARRAY['CASH'] END
$$ LANGUAGE sql IMMUTABLE;

-- A ledger transaction created in the current database transaction for the given entity.
CREATE OR REPLACE FUNCTION money_tx_in_this_transaction(p_column text, p_value text) RETURNS boolean AS $$
DECLARE found boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM money_transactions WHERE %I::text = $1 AND created_txid = pg_current_xact_id())', p_column)
    INTO found USING p_value;
  RETURN found;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------------------------
-- Dual-write guards: on a LEDGER rail a legacy money write is only a projection of a ledger
-- transaction of the same database transaction. Without one, the write (or the commit) fails.
-- On LEGACY rails nothing changes.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash_transactions ADD COLUMN money_transaction_id uuid REFERENCES money_transactions(id);
CREATE INDEX ON cash_transactions (money_transaction_id) WHERE money_transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION cash_transactions_ledger_guard() RETURNS trigger AS $$
DECLARE r text; tx money_transactions%ROWTYPE;
BEGIN
  IF NEW.money_transaction_id IS NOT NULL THEN
    SELECT * INTO tx FROM money_transactions WHERE id = NEW.money_transaction_id;
    IF tx.created_txid <> pg_current_xact_id() OR tx.org_id <> NEW.org_id OR tx.casino_id IS DISTINCT FROM NEW.casino_id THEN
      RAISE EXCEPTION 'cash_transactions: a projection must reference a ledger transaction of the same database transaction and casino';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH r IN ARRAY legacy_cash_tx_rails(NEW.type) LOOP
    IF money_rail_ledger(NEW.org_id, NEW.casino_id, r, NULL) THEN
      RAISE EXCEPTION 'cash_transactions: % money is on the ledger; legacy writes are only allowed as a projection of a ledger transaction', r;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cash_transactions_ledger_guard BEFORE INSERT ON cash_transactions FOR EACH ROW EXECUTE FUNCTION cash_transactions_ledger_guard();

-- Tickets: issue, redemption, cancellation, expiry and void move money (VALID <-> HELD does not).
CREATE OR REPLACE FUNCTION tickets_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.status = OLD.status OR (NEW.status IN ('VALID', 'HELD') AND OLD.status IN ('VALID', 'HELD'))) THEN
    RETURN NULL;
  END IF;
  IF money_rail_ledger(NEW.org_id, NEW.casino_id, 'TITO', NULL) AND NOT money_tx_in_this_transaction('ticket_id', NEW.id::text) THEN
    RAISE EXCEPTION 'tickets: TITO is on the ledger; ticket % changed without a ledger transaction', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER tickets_ledger_guard AFTER INSERT OR UPDATE OF status ON tickets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tickets_ledger_guard();

-- Handpays: creation (liability), payment and void move money (approval and machine reset do not).
CREATE OR REPLACE FUNCTION handpays_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.status = OLD.status OR NEW.status NOT IN ('PAID', 'VOIDED')) THEN
    RETURN NULL;
  END IF;
  IF money_rail_ledger(NEW.org_id, NEW.casino_id, 'HANDPAY', NULL) AND NOT money_tx_in_this_transaction('handpay_id', NEW.id::text) THEN
    RAISE EXCEPTION 'handpays: HANDPAY is on the ledger; handpay % changed without a ledger transaction', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER handpays_ledger_guard AFTER INSERT OR UPDATE OF status ON handpays
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION handpays_ledger_guard();

-- Cashier sessions: an opening float or a closing count is drawer money.
CREATE OR REPLACE FUNCTION cashier_sessions_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.opening_balance = 0 THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.status = OLD.status OR (COALESCE(NEW.counted_balance, 0) = 0 AND COALESCE(NEW.difference, 0) = 0)) THEN
    RETURN NULL;
  END IF;
  IF money_rail_ledger(NEW.org_id, NEW.casino_id, 'CASH', NULL) AND NOT money_tx_in_this_transaction('cashier_session_id', NEW.id::text) THEN
    RAISE EXCEPTION 'cashier_sessions: CASH is on the ledger; session % moved money without a ledger transaction', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER cashier_sessions_ledger_guard AFTER INSERT OR UPDATE OF status ON cashier_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cashier_sessions_ledger_guard();

-- Machine drop collections.
CREATE OR REPLACE FUNCTION cash_collections_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF money_rail_ledger(NEW.org_id, NEW.casino_id, 'MACHINE', NEW.machine_id) AND NOT money_tx_in_this_transaction('machine_id', NEW.machine_id::text) THEN
    RAISE EXCEPTION 'cash_collections: machine money is on the ledger; collection without a ledger transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER cash_collections_ledger_guard AFTER INSERT ON cash_collections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_collections_ledger_guard();

-- Money events of a machine on the ledger must be booked by the same database transaction.
CREATE OR REPLACE FUNCTION machine_events_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('CASH_IN', 'CASH_OUT', 'TITO_IN', 'TITO_OUT', 'CASHLESS_IN', 'CASHLESS_OUT', 'JACKPOT', 'COIN_IN', 'COIN_OUT', 'TICKET_IN', 'TICKET_OUT')
     AND money_rail_ledger(NEW.org_id, NEW.casino_id, 'MACHINE', NEW.machine_id)
     AND NOT money_tx_in_this_transaction('source_event_id', NEW.event_id::text) THEN
    RAISE EXCEPTION 'machine_events: machine money is on the ledger; % event % without a ledger transaction', NEW.type, NEW.event_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER machine_events_ledger_guard AFTER INSERT ON machine_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machine_events_ledger_guard();

COMMENT ON TABLE money_rail_cutovers IS 'One row per rail (and casino / machine) that is on the ledger. Forward-only, immutable.';
COMMENT ON TABLE money_backfill_items IS 'Opening balances of a cutover with their legacy source; each source is used once.';
