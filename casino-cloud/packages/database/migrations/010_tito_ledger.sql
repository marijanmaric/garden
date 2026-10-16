-- 010 (Step 7c): TITO on the ledger.
--
-- Ticket money moves only through the ledger service (TITO_* transactions); tickets are the entity,
-- the ledger the money. This migration adds the database side of the TITO rules:
--   * ticket status transitions (REDEEMED / EXPIRED / CANCELLED / VOID are final, HELD never expires);
--   * exactly one issue booking and one final booking (redeem / expiry / cancel) per ticket;
--   * one legacy drawer projection per ticket sale / payout;
--   * D1: the LEGACY_FLOOR_CLEARING account only for ticket events of a machine that is still LEGACY;
--   * ticket machine events are durable while TITO is frozen (deferred records, as for jackpots in 009).

-- ---------------------------------------------------------------------------------------------
-- Ticket state machine (mirrors TICKET_TRANSITIONS in @m1/shared)
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER tickets_status_transition BEFORE UPDATE OF status ON tickets FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('VALID>HELD', 'VALID>REDEEMED', 'VALID>EXPIRED', 'VALID>CANCELLED', 'VALID>VOID', 'HELD>VALID', 'HELD>REDEEMED');

-- ---------------------------------------------------------------------------------------------
-- Exactly once per ticket (in addition to the dedupe keys of the ledger service)
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX money_transactions_one_ticket_issue ON money_transactions (ticket_id)
  WHERE type IN ('TITO_ISSUE_MACHINE', 'TITO_ISSUE_CASHIER');
CREATE UNIQUE INDEX money_transactions_one_ticket_final ON money_transactions (ticket_id)
  WHERE type IN ('TITO_REDEEM_CASHIER', 'TITO_REDEEM_MACHINE', 'TITO_EXPIRY', 'TITO_CANCEL');
-- Legacy drawer rows written by LegacyProjection (only projections: legacy history stays as it is).
CREATE UNIQUE INDEX cash_transactions_one_ticket_projection ON cash_transactions (ticket_id, type)
  WHERE money_transaction_id IS NOT NULL AND type IN ('TICKET_ISSUE', 'TICKET_PAYOUT');

-- ---------------------------------------------------------------------------------------------
-- D1: LEGACY_FLOOR_CLEARING - per machine, only while that machine is LEGACY, only ticket events
-- (and four-eyes corrections). It never becomes a general suspense account.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entries_floor_clearing_guard() RETURNS trigger AS $$
DECLARE acc ledger_accounts%ROWTYPE; tx money_transactions%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM ledger_accounts WHERE id = NEW.account_id;
  IF acc.kind <> 'LEGACY_FLOOR_CLEARING' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO tx FROM money_transactions WHERE id = NEW.transaction_id;
  IF tx.type NOT IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION', 'ADJUSTMENT', 'REVERSAL') THEN
    RAISE EXCEPTION 'ledger: LEGACY_FLOOR_CLEARING only takes ticket events of a legacy machine (not %)', tx.type;
  END IF;
  IF tx.type IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION')
     AND (tx.machine_id IS DISTINCT FROM acc.machine_id OR money_rail_ledger(acc.org_id, acc.casino_id, 'MACHINE', acc.machine_id)) THEN
    RAISE EXCEPTION 'ledger: LEGACY_FLOOR_CLEARING is only for a machine that is not on the ledger (its own ticket events)';
  END IF;
  IF tx.type = 'ADJUSTMENT' AND tx.approved_by IS NULL THEN
    RAISE EXCEPTION 'ledger: a LEGACY_FLOOR_CLEARING correction needs a second person (four eyes)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_floor_clearing_guard BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_floor_clearing_guard();

-- ---------------------------------------------------------------------------------------------
-- Deferred money events (009) extended to TITO machine events: a ticket printed (TITO_OUT) or
-- accepted (TITO_IN) by a machine while TITO is frozen is recorded and replayed after the lift,
-- exactly once (event id), on the business date of occurred_at. LATE_EVENT: an event whose business
-- date is not today goes through the same validated path (never moved silently to today).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE deferred_money_events DROP CONSTRAINT deferred_money_events_rail_check;
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_rail_check CHECK (rail IN ('HANDPAY', 'TITO'));
ALTER TABLE deferred_money_events DROP CONSTRAINT deferred_money_events_kind_check;
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_kind_check CHECK (
  (rail = 'HANDPAY' AND kind = 'JACKPOT') OR (rail = 'TITO' AND kind IN ('TITO_OUT', 'TITO_IN')));
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_reason_check CHECK (reason IN ('FROZEN', 'LATE_EVENT'));
ALTER TABLE deferred_money_events
  ADD COLUMN ticket_id uuid REFERENCES tickets(id),
  ADD COLUMN money_transaction_id uuid REFERENCES money_transactions(id);
ALTER TABLE deferred_money_events DROP CONSTRAINT deferred_money_events_check;
ALTER TABLE deferred_money_events ADD CONSTRAINT deferred_money_events_processed CHECK (
  (status = 'PROCESSED') = (replayed_at IS NOT NULL AND (rail <> 'HANDPAY' OR handpay_id IS NOT NULL)));

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
  NEW.ticket_id := NULL; NEW.money_transaction_id := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
