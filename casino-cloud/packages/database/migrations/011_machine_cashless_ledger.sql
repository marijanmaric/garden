-- 011 (Step 7d): machine money and cashless on the ledger.
--
--   * machine money events of a machine on the MACHINE ledger (cash in / hopper cash out / cashless
--     acks / credit meter settlement) are booked by the ingest transaction, deferred while frozen or on
--     another business date, or - if they cannot be booked (domain error) - recorded as an immutable
--     machine event exception: the event is kept, no money moves, reconciliation reports it;
--   * hopper fills (vault -> hopper, confirmed at the machine) and machine collections (verified count,
--     cashbox -> vault) on the ledger;
--   * wallet transfers confirmed after FAILED / EXPIRED: LATE_CONFIRMED (exception booking);
--   * the D1 floor clearing of a machine is closed by its MACHINE cutover (opening balance);
--   * an explicit, four-eyes late-event booking for deferred events whose business date is closed.

-- ---------------------------------------------------------------------------------------------
-- Machine event exceptions: deterministic business rejection of the money part of a machine event
-- ---------------------------------------------------------------------------------------------
CREATE TABLE machine_event_exceptions (
  event_id     uuid PRIMARY KEY REFERENCES machine_events(event_id),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  casino_id    uuid NOT NULL REFERENCES casinos(id),
  machine_id   uuid NOT NULL REFERENCES machines(id),
  rail         text NOT NULL CHECK (rail IN ('HANDPAY', 'TITO', 'MACHINE', 'CASHLESS')),
  event_type   text NOT NULL,
  code         text NOT NULL,
  message      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON machine_event_exceptions (casino_id, created_at);
CREATE TRIGGER machine_event_exceptions_immutable BEFORE UPDATE OR DELETE ON machine_event_exceptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A money event of a machine on the ledger needs its ledger transaction in the same database
-- transaction, a deferred processing record (009) or a recorded exception (no money moved).
CREATE OR REPLACE FUNCTION machine_events_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('CASH_IN', 'CASH_OUT', 'TITO_IN', 'TITO_OUT', 'CASHLESS_IN', 'CASHLESS_OUT', 'JACKPOT', 'COIN_IN', 'COIN_OUT', 'TICKET_IN', 'TICKET_OUT')
     AND money_rail_ledger(NEW.org_id, NEW.casino_id, 'MACHINE', NEW.machine_id)
     AND NOT money_tx_in_this_transaction('source_event_id', NEW.event_id::text)
     AND NOT EXISTS (SELECT 1 FROM deferred_money_events d WHERE d.event_id = NEW.event_id)
     AND NOT EXISTS (SELECT 1 FROM machine_event_exceptions x WHERE x.event_id = NEW.event_id) THEN
    RAISE EXCEPTION 'machine_events: machine money is on the ledger; % event % without a ledger transaction', NEW.type, NEW.event_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Deferred money events: machine money events (MACHINE) and the explicit late-event booking
-- ---------------------------------------------------------------------------------------------
ALTER TABLE deferred_money_events DROP CONSTRAINT deferred_money_events_rail_check;
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_rail_check CHECK (rail IN ('HANDPAY', 'TITO', 'MACHINE'));
ALTER TABLE deferred_money_events DROP CONSTRAINT deferred_money_events_kind_check;
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_kind_check CHECK (
  (rail = 'HANDPAY' AND kind = 'JACKPOT') OR (rail = 'TITO' AND kind IN ('TITO_OUT', 'TITO_IN'))
  OR (rail = 'MACHINE' AND kind IN ('CASH_IN', 'CASH_OUT', 'CASHLESS_IN', 'CASHLESS_OUT')));
-- A deferred event whose business date is closed is booked only through an approved late-event booking
-- (four eyes) on the current open business date; the original business date stays recorded.
ALTER TABLE deferred_money_events
  ADD COLUMN late_approval_id uuid REFERENCES approvals(id),
  ADD COLUMN booked_business_date date,
  ADD CONSTRAINT deferred_money_events_late_booking CHECK ((late_approval_id IS NULL) = (booked_business_date IS NULL)),
  ADD CONSTRAINT deferred_money_events_late_processed CHECK (late_approval_id IS NULL OR status = 'PROCESSED');

CREATE OR REPLACE FUNCTION deferred_money_events_from_event() RETURNS trigger AS $$
DECLARE e machine_events%ROWTYPE; tz text;
BEGIN
  SELECT * INTO e FROM machine_events WHERE event_id = NEW.event_id;
  SELECT timezone INTO tz FROM casinos WHERE id = NEW.casino_id;
  IF e.event_id IS NULL OR e.org_id <> NEW.org_id OR e.casino_id <> NEW.casino_id OR e.machine_id <> NEW.machine_id OR e.type <> NEW.kind
     OR round(e.amount * 100)::bigint <> NEW.amount_cents THEN
    RAISE EXCEPTION 'deferred_money_events: record does not match machine event %', NEW.event_id;
  END IF;
  NEW.occurred_at := e.occurred_at;
  NEW.received_at := e.received_at;
  NEW.business_date := (e.occurred_at AT TIME ZONE tz)::date;
  NEW.status := 'PENDING'; NEW.attempts := 0; NEW.last_error := NULL; NEW.handpay_id := NULL; NEW.replayed_at := NULL;
  NEW.ticket_id := NULL; NEW.money_transaction_id := NULL; NEW.late_approval_id := NULL; NEW.booked_business_date := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Wallet transfers: late confirmation after FAILED / EXPIRED
-- ---------------------------------------------------------------------------------------------
ALTER TABLE wallet_transfers DROP CONSTRAINT wallet_transfers_status_check;
ALTER TABLE wallet_transfers ADD CONSTRAINT wallet_transfers_status_check CHECK (status IN ('REQUESTED', 'SENT', 'CONFIRMED', 'FAILED', 'EXPIRED', 'LATE_CONFIRMED'));
ALTER TABLE wallet_transfers DROP CONSTRAINT wallet_transfers_check;
ALTER TABLE wallet_transfers ADD CONSTRAINT wallet_transfers_confirmed_amount CHECK ((status IN ('CONFIRMED', 'LATE_CONFIRMED')) = (confirmed_amount_cents IS NOT NULL));
DROP TRIGGER wallet_transfers_transition ON wallet_transfers;
CREATE TRIGGER wallet_transfers_transition BEFORE UPDATE ON wallet_transfers FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('REQUESTED>SENT', 'REQUESTED>FAILED', 'REQUESTED>EXPIRED', 'SENT>CONFIRMED', 'SENT>FAILED', 'SENT>EXPIRED',
    'FAILED>LATE_CONFIRMED', 'EXPIRED>LATE_CONFIRMED');
-- One confirmation booking per transfer (normal or late), in addition to the dedupe keys.
CREATE UNIQUE INDEX money_transactions_one_transfer_confirm ON money_transactions (transfer_id)
  WHERE type IN ('WALLET_TO_MACHINE_CONFIRM', 'MACHINE_TO_WALLET', 'WALLET_TO_MACHINE_LATE_CONFIRM');

-- ---------------------------------------------------------------------------------------------
-- Hopper fills: vault -> hopper, money moves only on confirmation at the machine
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_kind_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check CHECK (kind IN ('FILL', 'DROP', 'HOPPER_FILL'));
ALTER TABLE cash_movements ALTER COLUMN cashier_session_id DROP NOT NULL;
ALTER TABLE cash_movements ADD COLUMN machine_id uuid REFERENCES machines(id);
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_target CHECK (
  (kind = 'HOPPER_FILL' AND machine_id IS NOT NULL AND cashier_session_id IS NULL)
  OR (kind <> 'HOPPER_FILL' AND machine_id IS NULL AND cashier_session_id IS NOT NULL));

CREATE OR REPLACE FUNCTION cash_movements_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cash_movements cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id)
       OR NOT EXISTS (SELECT 1 FROM vault_sessions WHERE id = NEW.vault_session_id AND vault_id = NEW.vault_id)
       OR (NEW.cashier_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cashier_sessions WHERE id = NEW.cashier_session_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id))
       OR (NEW.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id)) THEN
      RAISE EXCEPTION 'cash_movements: vault, vault session and cashier session / machine must belong to the same casino';
    END IF;
  ELSIF NEW.amount_cents <> OLD.amount_cents OR NEW.kind <> OLD.kind OR NEW.vault_id <> OLD.vault_id
     OR NEW.cashier_session_id IS DISTINCT FROM OLD.cashier_session_id OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'cash_movements: amount, parties and references are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Machine collections on the ledger: the legacy collection row references its count and booking
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash_collections
  ADD COLUMN count_id uuid UNIQUE REFERENCES cash_counts(id),
  ADD COLUMN money_transaction_id uuid UNIQUE REFERENCES money_transactions(id);

-- D3: a machine whose credit meter is reliable may be settled at any meter report; otherwise only at a
-- verified zero-credit state. Never estimated.
ALTER TABLE machines ADD COLUMN credit_meter_reliable boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- D1: the MACHINE cutover closes the machine's floor clearing (opening balance, source = the account)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE money_backfill_items DROP CONSTRAINT money_backfill_items_source_table_check;
ALTER TABLE money_backfill_items ADD CONSTRAINT money_backfill_items_source_table_check CHECK (source_table IN ('cash_counts', 'tickets', 'handpays', 'ledger_accounts'));

CREATE OR REPLACE FUNCTION ledger_entries_floor_clearing_guard() RETURNS trigger AS $$
DECLARE acc ledger_accounts%ROWTYPE; tx money_transactions%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM ledger_accounts WHERE id = NEW.account_id;
  IF acc.kind <> 'LEGACY_FLOOR_CLEARING' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO tx FROM money_transactions WHERE id = NEW.transaction_id;
  IF tx.type NOT IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION', 'ADJUSTMENT', 'REVERSAL', 'OPENING_BALANCE') THEN
    RAISE EXCEPTION 'ledger: LEGACY_FLOOR_CLEARING only takes ticket events of a legacy machine (not %)', tx.type;
  END IF;
  IF tx.type IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION')
     AND (tx.machine_id IS DISTINCT FROM acc.machine_id OR money_rail_ledger(acc.org_id, acc.casino_id, 'MACHINE', acc.machine_id)) THEN
    RAISE EXCEPTION 'ledger: LEGACY_FLOOR_CLEARING is only for a machine that is not on the ledger (its own ticket events)';
  END IF;
  IF tx.type = 'ADJUSTMENT' AND tx.approved_by IS NULL THEN
    RAISE EXCEPTION 'ledger: a LEGACY_FLOOR_CLEARING correction needs a second person (four eyes)';
  END IF;
  -- the closing opening balance belongs to the MACHINE cutover of this very machine
  IF tx.type = 'OPENING_BALANCE' AND tx.machine_id IS DISTINCT FROM acc.machine_id THEN
    RAISE EXCEPTION 'ledger: LEGACY_FLOOR_CLEARING is closed only by the MACHINE cutover of its machine';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
