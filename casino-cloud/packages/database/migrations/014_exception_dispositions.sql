-- 014 (V1): the financial disposition of a machine event exception is separate from its explanation.
--
-- A money event of a machine on the MACHINE ledger that could not be booked (machine_event_exceptions) changes
-- the machine's credit meter outside the ledger. Until its money is handled, the machine's credit-meter
-- settlement must not run: otherwise the unbooked amount would be booked as GAMING_RESULT. An explanation
-- (reconciliation resolution) books nothing and therefore never releases the settlement. Only a disposition does:
--
--   CORRECTION      a four-eyes ADJUSTMENT of this event (source_event_id), posted in the same transaction;
--   NO_MONEY_MOVED  a four-eyes attestation with evidence that the event moved no money (no posting);
--   EXPLAINED_BEFORE_014  exceptions explained before this migration (their settlement already ran; kept as is).
--
-- Nothing existing changes: no ledger row, balance or historical record is touched.

-- An exception that needs a disposition: a credit-changing event of a machine that was on the MACHINE ledger.
CREATE OR REPLACE FUNCTION machine_exception_needs_disposition(p_event uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM machine_event_exceptions x
    JOIN money_rail_cutovers mc ON mc.rail = 'MACHINE' AND mc.machine_id = x.machine_id
    WHERE x.event_id = p_event AND x.created_at > mc.as_of
      AND x.event_type IN ('CASH_IN', 'CASH_OUT', 'TITO_IN', 'TITO_OUT', 'CASHLESS_IN', 'CASHLESS_OUT'));
$$ LANGUAGE sql STABLE;

CREATE TABLE machine_event_dispositions (
  event_id             uuid PRIMARY KEY REFERENCES machine_event_exceptions(event_id),   -- one disposition per event
  org_id               uuid NOT NULL REFERENCES organizations(id),
  casino_id            uuid NOT NULL REFERENCES casinos(id),
  machine_id           uuid NOT NULL REFERENCES machines(id),
  kind                 text NOT NULL CHECK (kind IN ('CORRECTION', 'NO_MONEY_MOVED', 'EXPLAINED_BEFORE_014')),
  reason               text NOT NULL CHECK (length(reason) >= 10),
  evidence_ref         text,
  money_transaction_id uuid UNIQUE REFERENCES money_transactions(id),
  approval_id          uuid NOT NULL UNIQUE REFERENCES approvals(id),
  requested_by         uuid NOT NULL REFERENCES employees(id),
  approved_by          uuid NOT NULL REFERENCES employees(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT machine_event_dispositions_four_eyes CHECK (requested_by <> approved_by),
  CONSTRAINT machine_event_dispositions_posting CHECK ((kind = 'CORRECTION') = (money_transaction_id IS NOT NULL)),
  CONSTRAINT machine_event_dispositions_evidence CHECK (kind = 'EXPLAINED_BEFORE_014' OR length(evidence_ref) >= 3)
);
CREATE INDEX ON machine_event_dispositions (casino_id, created_at);

-- Exceptions already explained before this migration keep their state (no new block on historical data).
INSERT INTO machine_event_dispositions (event_id, org_id, casino_id, machine_id, kind, reason, approval_id, requested_by, approved_by, created_at)
SELECT DISTINCT ON (x.event_id) x.event_id, x.org_id, x.casino_id, x.machine_id, 'EXPLAINED_BEFORE_014',
       'Explained before migration 014: ' || r.explanation, r.approval_id, r.requested_by, r.approved_by, r.created_at
FROM machine_event_exceptions x
JOIN reconciliation_resolutions r ON r.org_id = x.org_id AND r.item_key IN ('machine_event:' || x.event_id, 'ticket_event:' || x.event_id)
WHERE machine_exception_needs_disposition(x.event_id)
ORDER BY x.event_id, r.created_at;

-- New dispositions: only for an exception that needs one, attributed to an executed four-eyes approval of exactly
-- this event; a correction is an ADJUSTMENT of this event by the same two people.
CREATE OR REPLACE FUNCTION machine_event_dispositions_guard() RETURNS trigger AS $$
DECLARE x machine_event_exceptions%ROWTYPE; ap approvals%ROWTYPE; tx money_transactions%ROWTYPE;
BEGIN
  IF NEW.kind = 'EXPLAINED_BEFORE_014' THEN
    RAISE EXCEPTION 'machine_event_dispositions: EXPLAINED_BEFORE_014 is only the migration backfill';
  END IF;
  SELECT * INTO x FROM machine_event_exceptions WHERE event_id = NEW.event_id;
  IF x.org_id IS DISTINCT FROM NEW.org_id OR x.casino_id IS DISTINCT FROM NEW.casino_id OR x.machine_id IS DISTINCT FROM NEW.machine_id THEN
    RAISE EXCEPTION 'machine_event_dispositions: organisation / casino / machine differ from the exception';
  END IF;
  IF NOT machine_exception_needs_disposition(NEW.event_id) THEN
    RAISE EXCEPTION 'machine_event_dispositions: the exception moved no machine credit on the ledger (use an explanation)';
  END IF;
  SELECT * INTO ap FROM approvals WHERE id = NEW.approval_id;
  IF ap.org_id IS DISTINCT FROM NEW.org_id OR ap.action <> 'MACHINE_EXCEPTION_DISPOSITION' OR ap.entity_id <> NEW.event_id::text
     OR ap.status NOT IN ('APPROVED', 'EXECUTED') OR ap.requested_by <> NEW.requested_by OR ap.decided_by <> NEW.approved_by
     OR ap.payload->>'kind' <> NEW.kind THEN
    RAISE EXCEPTION 'machine_event_dispositions: needs the approved four-eyes request of this event and kind';
  END IF;
  IF NEW.kind = 'CORRECTION' THEN
    SELECT * INTO tx FROM money_transactions WHERE id = NEW.money_transaction_id;
    IF tx.type <> 'ADJUSTMENT' OR tx.source_event_id IS DISTINCT FROM NEW.event_id OR tx.org_id <> NEW.org_id
       OR tx.actor_id IS DISTINCT FROM NEW.requested_by OR tx.approved_by IS DISTINCT FROM NEW.approved_by
       OR tx.amount_cents <> ap.amount_cents THEN
      RAISE EXCEPTION 'machine_event_dispositions: the correction must be the four-eyes ADJUSTMENT of this event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER machine_event_dispositions_guard BEFORE INSERT ON machine_event_dispositions FOR EACH ROW EXECUTE FUNCTION machine_event_dispositions_guard();
CREATE TRIGGER machine_event_dispositions_immutable BEFORE UPDATE OR DELETE ON machine_event_dispositions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every ledger ADJUSTMENT needs two people (new rows; existing rows are not rewritten) ...
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_adjustment_four_eyes
  CHECK (type <> 'ADJUSTMENT' OR (actor_id IS NOT NULL AND approved_by IS NOT NULL)) NOT VALID;
-- ... and a machine event is corrected at most once.
CREATE UNIQUE INDEX money_transactions_one_event_correction ON money_transactions (source_event_id)
  WHERE type = 'ADJUSTMENT' AND source_event_id IS NOT NULL;
