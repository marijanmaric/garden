-- 009 (Step 7b correction): money events are never lost while a rail is frozen.
--
-- A jackpot that arrives while the HANDPAY rail is frozen is stored as the authoritative machine
-- event (machine_events) plus a deferred processing record here. No handpay and no ledger booking is
-- created while frozen. After the freeze is lifted the record is replayed exactly once, keyed by the
-- jackpot event id (source_event_id): one handpay per event, one creation booking per handpay.
--
-- Dates: occurred_at is the economic event time, received_at when the system received it,
-- replayed_at when the deferred record was processed. business_date is the casino business date of
-- occurred_at; the replay books on that date, never silently on today. A closed date is refused by
-- the business-day guard (the record then stays PENDING with last_error and reconciliation flags it).

CREATE TABLE deferred_money_events (
  event_id               uuid PRIMARY KEY REFERENCES machine_events(event_id),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  casino_id              uuid NOT NULL REFERENCES casinos(id),
  machine_id             uuid NOT NULL REFERENCES machines(id),
  rail                   text NOT NULL CHECK (rail IN ('HANDPAY')),
  kind                   text NOT NULL CHECK (kind IN ('JACKPOT')),
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0),
  reason                 text NOT NULL,                 -- e.g. FROZEN
  occurred_at            timestamptz NOT NULL,          -- economic event time (from the machine event)
  received_at            timestamptz NOT NULL,          -- received by the system (from the machine event)
  business_date          date NOT NULL,                 -- casino business date of occurred_at (never moved)
  status                 text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED')),
  attempts               int NOT NULL DEFAULT 0,
  last_error             text,
  handpay_id             uuid REFERENCES handpays(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  replayed_at            timestamptz,
  CHECK ((status = 'PROCESSED') = (replayed_at IS NOT NULL AND handpay_id IS NOT NULL))
);
CREATE INDEX ON deferred_money_events (org_id, casino_id, status);
CREATE TRIGGER deferred_money_events_transition BEFORE UPDATE ON deferred_money_events FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('PENDING>PROCESSED');
CREATE TRIGGER deferred_money_events_no_delete BEFORE DELETE ON deferred_money_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The record mirrors its machine event: dates and amount are taken from it, never supplied freely.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER deferred_money_events_from_event BEFORE INSERT ON deferred_money_events FOR EACH ROW EXECUTE FUNCTION deferred_money_events_from_event();

-- Only the processing columns change; the recorded event is immutable (audit trail).
CREATE OR REPLACE FUNCTION deferred_money_events_immutable() RETURNS trigger AS $$
BEGIN
  IF (NEW.event_id, NEW.org_id, NEW.casino_id, NEW.machine_id, NEW.rail, NEW.kind, NEW.amount_cents, NEW.reason,
      NEW.occurred_at, NEW.received_at, NEW.business_date, NEW.created_at)
     IS DISTINCT FROM
     (OLD.event_id, OLD.org_id, OLD.casino_id, OLD.machine_id, OLD.rail, OLD.kind, OLD.amount_cents, OLD.reason,
      OLD.occurred_at, OLD.received_at, OLD.business_date, OLD.created_at)
     OR OLD.status = 'PROCESSED' OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'deferred_money_events: recorded event % is immutable', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER deferred_money_events_immutable BEFORE UPDATE ON deferred_money_events FOR EACH ROW EXECUTE FUNCTION deferred_money_events_immutable();

-- A money event of a machine on the ledger needs its ledger transaction in the same database
-- transaction - or, when the money rail is frozen, a deferred processing record (006 guard, extended).
CREATE OR REPLACE FUNCTION machine_events_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('CASH_IN', 'CASH_OUT', 'TITO_IN', 'TITO_OUT', 'CASHLESS_IN', 'CASHLESS_OUT', 'JACKPOT', 'COIN_IN', 'COIN_OUT', 'TICKET_IN', 'TICKET_OUT')
     AND money_rail_ledger(NEW.org_id, NEW.casino_id, 'MACHINE', NEW.machine_id)
     AND NOT money_tx_in_this_transaction('source_event_id', NEW.event_id::text)
     AND NOT EXISTS (SELECT 1 FROM deferred_money_events d WHERE d.event_id = NEW.event_id) THEN
    RAISE EXCEPTION 'machine_events: machine money is on the ledger; % event % without a ledger transaction', NEW.type, NEW.event_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
