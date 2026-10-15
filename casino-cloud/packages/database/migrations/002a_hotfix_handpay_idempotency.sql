-- Step 1 hotfix (temporary until the money ledger in 003+).

-- A handpay is tied to the jackpot event it pays. The partial unique index makes a second
-- payment of the same jackpot impossible, whatever happens in the application layer.
ALTER TABLE cash_transactions ADD COLUMN source_event_id uuid REFERENCES machine_events(event_id);
CREATE UNIQUE INDEX cash_transactions_one_payment_per_event ON cash_transactions (source_event_id) WHERE source_event_id IS NOT NULL;

-- Idempotency keys for money / cashier actions. The key row is written in the same
-- transaction as the action, so an action and its stored response commit or roll back together.
CREATE TABLE idempotency_keys (
  org_id        uuid NOT NULL REFERENCES organizations(id),
  key           text NOT NULL,
  employee_id   uuid NOT NULL REFERENCES employees(id),
  route         text NOT NULL,
  request_hash  text NOT NULL,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, employee_id, key)   -- keys are scoped to the client (employee) that sent them
);
CREATE INDEX ON idempotency_keys (created_at);
