-- 008 (Step 7b): HANDPAY on the ledger.
--
-- * One payment per handpay and one creation booking per handpay, enforced by the database in
--   addition to the ledger dedupe key, handpays_one_per_event (one handpay per jackpot event) and the
--   Step 1 index on cash_transactions (one cash payment per jackpot event).
-- * Legacy handpay exceptions: a legacy HANDPAY cash payment without a jackpot event id (before Step 1)
--   can only be classified by two different employees with evidence (LINK / HISTORICAL / DISPUTED).
--   Nothing is matched by amount or time; no ledger money is created for historical payments.
-- Nothing here moves money or rewrites history.

CREATE UNIQUE INDEX money_transactions_one_handpay_payment ON money_transactions (handpay_id) WHERE type = 'HANDPAY_PAY';
CREATE UNIQUE INDEX money_transactions_one_handpay_creation ON money_transactions (handpay_id)
  WHERE type IN ('HANDPAY_CREATE_JACKPOT', 'HANDPAY_CREATE_CANCEL_CREDIT');

-- A reset command that is neither confirmed nor failed within this time counts as failed (and is retried).
ALTER TABLE casino_money_settings
  ADD COLUMN handpay_reset_timeout_seconds int NOT NULL DEFAULT 120 CHECK (handpay_reset_timeout_seconds BETWEEN 10 AND 86400);

CREATE TABLE handpay_legacy_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  casino_id             uuid NOT NULL REFERENCES casinos(id),
  cash_transaction_id   bigint NOT NULL UNIQUE REFERENCES cash_transactions(id),
  machine_id            uuid REFERENCES machines(id),
  amount_cents          bigint NOT NULL,
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PROPOSED', 'APPROVED', 'REJECTED')),
  resolution            text CHECK (resolution IN ('LINK', 'HISTORICAL', 'DISPUTED')),
  linked_event_id       uuid REFERENCES machine_events(event_id),
  evidence_reference    text,
  evidence_hash         text,
  justification         text,
  proposed_by           uuid REFERENCES employees(id),
  proposed_at           timestamptz,
  approval_id           uuid REFERENCES approvals(id),
  decided_by            uuid REFERENCES employees(id),
  decided_at            timestamptz,
  linked_handpay_id     uuid REFERENCES handpays(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handpay_exceptions_four_eyes CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT handpay_exceptions_proposal CHECK (status = 'OPEN' OR (resolution IS NOT NULL AND proposed_by IS NOT NULL
    AND length(COALESCE(evidence_reference, '')) >= 3 AND length(COALESCE(justification, '')) >= 20)),
  CONSTRAINT handpay_exceptions_link CHECK ((resolution = 'LINK') = (linked_event_id IS NOT NULL)),
  CONSTRAINT handpay_exceptions_decided CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by IS NOT NULL)
);
-- A jackpot event can be linked to at most one legacy payment.
CREATE UNIQUE INDEX handpay_exceptions_one_link_per_event ON handpay_legacy_exceptions (linked_event_id) WHERE status = 'APPROVED' AND resolution = 'LINK';
CREATE INDEX ON handpay_legacy_exceptions (casino_id, status);
CREATE TRIGGER handpay_exceptions_transition BEFORE UPDATE ON handpay_legacy_exceptions FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('OPEN>PROPOSED', 'PROPOSED>APPROVED', 'PROPOSED>REJECTED', 'REJECTED>PROPOSED');

CREATE OR REPLACE FUNCTION handpay_exceptions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'handpay_legacy_exceptions cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM cash_transactions WHERE id = NEW.cash_transaction_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id
                   AND type = 'HANDPAY' AND source_event_id IS NULL) THEN
      RAISE EXCEPTION 'handpay_legacy_exceptions: only for legacy HANDPAY payments without jackpot event id';
    END IF;
  ELSIF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'handpay_legacy_exceptions: an approved classification is final';
  ELSIF NEW.cash_transaction_id <> OLD.cash_transaction_id OR NEW.amount_cents <> OLD.amount_cents OR NEW.casino_id <> OLD.casino_id THEN
    RAISE EXCEPTION 'handpay_legacy_exceptions: the legacy payment reference is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER handpay_exceptions_guard BEFORE INSERT OR UPDATE OR DELETE ON handpay_legacy_exceptions FOR EACH ROW EXECUTE FUNCTION handpay_exceptions_guard();

CREATE TABLE handpay_exception_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  exception_id  uuid NOT NULL REFERENCES handpay_legacy_exceptions(id),
  action        text NOT NULL,     -- DETECTED, PROPOSED, APPROVED, REJECTED
  employee_id   uuid REFERENCES employees(id),
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON handpay_exception_events (exception_id);
CREATE TRIGGER handpay_exception_events_immutable BEFORE UPDATE OR DELETE ON handpay_exception_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
