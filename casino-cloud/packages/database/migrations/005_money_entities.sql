-- 005: Money domain entities (wallets, cashless sessions, wallet transfers, handpays, vaults,
-- cash counts, approvals, ticket holds) and the foreign keys left open in 004.
--
-- Rules:
--  * No balances here. Wallet balances come only from the ledger (view wallet_balances).
--  * Foreign keys point one way: ledger -> entity (money_transactions.wallet_id / handpay_id /
--    transfer_id / vault_id, machine_commands.handpay_id / transfer_id). Entities never point
--    back to money transactions, so there are no circular references.
--  * No money is moved and no opening balance is created (that is migration 006).
--  * Entity backfill only: settings + vault per casino, wallet per non-closed player, handpay
--    entities for jackpots already paid (Step 1) and for currently pending jackpots.

-- Generic status machine guard: allowed transitions are passed as 'FROM>TO' trigger arguments.
CREATE OR REPLACE FUNCTION enforce_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status || '>' || NEW.status) = ANY (TG_ARGV)) THEN
    RAISE EXCEPTION '%: status cannot change from % to %', TG_TABLE_NAME, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Casino money settings (business rules; NULL limit = no approval required)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE casino_money_settings (
  casino_id                     uuid PRIMARY KEY REFERENCES casinos(id),
  org_id                        uuid NOT NULL REFERENCES organizations(id),
  handpay_approval_cents        bigint CHECK (handpay_approval_cents >= 0),
  deposit_approval_cents        bigint CHECK (deposit_approval_cents >= 0),
  withdrawal_approval_cents     bigint CHECK (withdrawal_approval_cents >= 0),
  ticket_payout_approval_cents  bigint CHECK (ticket_payout_approval_cents >= 0),
  short_over_approval_cents     bigint CHECK (short_over_approval_cents >= 0),
  petty_cash_approval_cents     bigint CHECK (petty_cash_approval_cents >= 0),
  cash_advance_approval_cents   bigint CHECK (cash_advance_approval_cents >= 0),
  reversal_approval_cents       bigint CHECK (reversal_approval_cents >= 0),
  tito_hold_seconds             int NOT NULL DEFAULT 30 CHECK (tito_hold_seconds BETWEEN 5 AND 600),
  tito_hold_grace_seconds       int NOT NULL DEFAULT 120 CHECK (tito_hold_grace_seconds BETWEEN 0 AND 3600),
  transfer_timeout_seconds      int NOT NULL DEFAULT 60 CHECK (transfer_timeout_seconds BETWEEN 5 AND 3600),
  tito_offline_policy           text NOT NULL DEFAULT 'REJECT' CHECK (tito_offline_policy IN ('REJECT', 'ACCEPT_WITH_EXCEPTION')),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO casino_money_settings (casino_id, org_id) SELECT id, org_id FROM casinos;

-- ---------------------------------------------------------------------------------------------
-- Vaults, vault sessions, cash counts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  casino_id   uuid NOT NULL REFERENCES casinos(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (casino_id, name)
);
INSERT INTO vaults (org_id, casino_id, name) SELECT org_id, id, 'Main Vault' FROM casinos;

CREATE TABLE vault_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  casino_id      uuid NOT NULL REFERENCES casinos(id),
  vault_id       uuid NOT NULL REFERENCES vaults(id),
  business_date  date NOT NULL,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COUNTING', 'CLOSED')),
  opened_by      uuid NOT NULL REFERENCES employees(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  counting_at    timestamptz,
  closed_by      uuid REFERENCES employees(id),
  closed_at      timestamptz,
  note           text,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE OR REPLACE FUNCTION vault_sessions_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'vault_sessions: vault belongs to another casino';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER vault_sessions_scope_guard BEFORE INSERT ON vault_sessions FOR EACH ROW EXECUTE FUNCTION vault_sessions_scope_guard();
CREATE UNIQUE INDEX vault_sessions_one_open_per_vault ON vault_sessions (vault_id) WHERE status IN ('OPEN', 'COUNTING');
CREATE TRIGGER vault_sessions_transition BEFORE UPDATE ON vault_sessions FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('OPEN>COUNTING', 'COUNTING>OPEN', 'COUNTING>CLOSED');

CREATE TABLE cash_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  casino_id           uuid NOT NULL REFERENCES casinos(id),
  context             text NOT NULL CHECK (context IN ('VAULT_OPEN', 'VAULT_CLOSE', 'DRAWER_CLOSE', 'MACHINE_DROP')),
  vault_session_id    uuid REFERENCES vault_sessions(id),
  cashier_session_id  uuid REFERENCES cashier_sessions(id),
  machine_id          uuid REFERENCES machines(id),
  total_cents         bigint NOT NULL CHECK (total_cents >= 0),
  denominations       jsonb,                  -- {"<value in cents>": count}
  blind               boolean NOT NULL DEFAULT false,
  counted_by          uuid NOT NULL REFERENCES employees(id),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (context NOT IN ('VAULT_OPEN', 'VAULT_CLOSE') OR vault_session_id IS NOT NULL),
  CHECK (context <> 'DRAWER_CLOSE' OR cashier_session_id IS NOT NULL),
  CHECK (context <> 'MACHINE_DROP' OR machine_id IS NOT NULL)
);
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cash_counts_scope_guard BEFORE INSERT ON cash_counts FOR EACH ROW EXECUTE FUNCTION cash_counts_scope_guard();
CREATE TRIGGER cash_counts_immutable BEFORE UPDATE OR DELETE ON cash_counts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Approvals (four eyes)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE approvals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  casino_id             uuid NOT NULL REFERENCES casinos(id),
  action                text NOT NULL,          -- e.g. HANDPAY_PAY, CASH_WITHDRAWAL, DRAWER_SHORT_OVER
  entity_type           text,
  entity_id             text,
  amount_cents          bigint CHECK (amount_cents >= 0),
  payload               jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED')),
  requested_by          uuid NOT NULL REFERENCES employees(id),
  decided_by            uuid REFERENCES employees(id),
  decided_at            timestamptz,
  decision_note         text,
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  executed_at           timestamptz,
  money_transaction_id  uuid REFERENCES money_transactions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (status IN ('PENDING', 'EXPIRED') OR decided_by IS NOT NULL OR status = 'EXECUTED')
);
CREATE INDEX ON approvals (org_id, casino_id, status, created_at DESC);
CREATE TRIGGER approvals_transition BEFORE UPDATE ON approvals FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('PENDING>APPROVED', 'PENDING>REJECTED', 'PENDING>EXPIRED', 'APPROVED>EXECUTED', 'APPROVED>EXPIRED');

-- ---------------------------------------------------------------------------------------------
-- Cashier session extensions
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cashier_sessions
  ADD COLUMN vault_session_id uuid REFERENCES vault_sessions(id),
  ADD CONSTRAINT cashier_sessions_status_check CHECK (status IN ('OPEN', 'COUNTING', 'CLOSED'));

CREATE OR REPLACE FUNCTION cashier_sessions_vault_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.vault_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault_sessions WHERE id = NEW.vault_session_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'cashier_sessions: vault session belongs to another casino';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cashier_sessions_vault_guard BEFORE INSERT OR UPDATE OF vault_session_id ON cashier_sessions FOR EACH ROW EXECUTE FUNCTION cashier_sessions_vault_guard();

-- ---------------------------------------------------------------------------------------------
-- Wallets (organisation-level, one per player, no balance column)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wallets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  player_id          uuid NOT NULL UNIQUE REFERENCES players(id),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'CLOSED')),
  status_reason      text,
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES employees(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION wallets_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'wallets: player belongs to another organisation';
    END IF;
  ELSIF NEW.player_id <> OLD.player_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'wallets: player and organisation are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER wallets_guard BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard();
CREATE TRIGGER wallets_transition BEFORE UPDATE ON wallets FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('ACTIVE>BLOCKED', 'ACTIVE>CLOSED', 'BLOCKED>ACTIVE', 'BLOCKED>CLOSED');
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE wallet_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  wallet_id    uuid NOT NULL REFERENCES wallets(id),
  action       text NOT NULL,   -- CREATED, BLOCKED, UNBLOCKED, CLOSED
  reason       text,
  employee_id  uuid REFERENCES employees(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER wallet_events_immutable BEFORE UPDATE OR DELETE ON wallet_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO wallets (org_id, player_id, created_at) SELECT org_id, id, created_at FROM players WHERE status <> 'CLOSED';
INSERT INTO wallet_events (org_id, wallet_id, action, reason, created_at) SELECT org_id, id, 'CREATED', 'migration 005', created_at FROM wallets;

-- ---------------------------------------------------------------------------------------------
-- Cashless sessions: wallet play on one machine. The card is only the identifier that was used.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cashless_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  casino_id          uuid NOT NULL REFERENCES casinos(id),
  wallet_id          uuid NOT NULL REFERENCES wallets(id),
  player_id          uuid NOT NULL REFERENCES players(id),
  card_id            uuid NOT NULL REFERENCES player_cards(id),
  machine_id         uuid NOT NULL REFERENCES machines(id),
  gaming_session_id  uuid REFERENCES player_sessions(id),
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  request_key        text,                                    -- idempotency of the open request
  source_event_id    uuid REFERENCES machine_events(event_id),
  opened_at          timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  close_reason       text,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  UNIQUE (org_id, request_key)
);
CREATE UNIQUE INDEX cashless_sessions_one_open_per_machine ON cashless_sessions (machine_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX cashless_sessions_one_open_per_wallet ON cashless_sessions (wallet_id) WHERE status = 'OPEN';

-- Shared consistency check for entities that tie player, card, wallet and machine together.
CREATE OR REPLACE FUNCTION money_entity_refs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.casino_id <> OLD.casino_id OR NEW.wallet_id <> OLD.wallet_id
     OR NEW.player_id <> OLD.player_id OR NEW.card_id IS DISTINCT FROM OLD.card_id OR NEW.machine_id <> OLD.machine_id) THEN
    RAISE EXCEPTION '%: references are immutable', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND player_id = NEW.player_id AND org_id = NEW.org_id) THEN
      RAISE EXCEPTION '%: wallet does not belong to this player / organisation', TG_TABLE_NAME;
    END IF;
    IF NEW.card_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM player_cards WHERE id = NEW.card_id AND player_id = NEW.player_id AND org_id = NEW.org_id) THEN
      RAISE EXCEPTION '%: card does not belong to this player / organisation', TG_TABLE_NAME;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
      RAISE EXCEPTION '%: machine does not belong to this organisation / casino', TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cashless_sessions_refs BEFORE INSERT OR UPDATE ON cashless_sessions FOR EACH ROW EXECUTE FUNCTION money_entity_refs_guard();
CREATE TRIGGER cashless_sessions_transition BEFORE UPDATE ON cashless_sessions FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('OPEN>CLOSED');

-- ---------------------------------------------------------------------------------------------
-- Wallet transfers: wallet <-> machine. REQUESTED is never a completed money movement.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wallet_transfers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  casino_id               uuid NOT NULL REFERENCES casinos(id),
  wallet_id               uuid NOT NULL REFERENCES wallets(id),
  player_id               uuid NOT NULL REFERENCES players(id),
  card_id                 uuid REFERENCES player_cards(id),
  machine_id              uuid NOT NULL REFERENCES machines(id),
  cashless_session_id     uuid REFERENCES cashless_sessions(id),
  direction               text NOT NULL CHECK (direction IN ('TO_MACHINE', 'FROM_MACHINE')),
  amount_cents            bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000000000),
  confirmed_amount_cents  bigint CHECK (confirmed_amount_cents > 0),
  status                  text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'SENT', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  request_key             text NOT NULL,
  ack_event_id            uuid UNIQUE REFERENCES machine_events(event_id),
  failure_reason          text,
  expires_at              timestamptz NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  sent_at                 timestamptz,
  completed_at            timestamptz,
  requested_by            uuid REFERENCES employees(id),
  UNIQUE (org_id, request_key),
  CHECK ((status = 'CONFIRMED') = (confirmed_amount_cents IS NOT NULL)),
  CHECK (direction = 'FROM_MACHINE' OR confirmed_amount_cents IS NULL OR confirmed_amount_cents = amount_cents)
);
CREATE UNIQUE INDEX wallet_transfers_one_active_per_machine ON wallet_transfers (machine_id) WHERE status IN ('REQUESTED', 'SENT');
CREATE INDEX ON wallet_transfers (wallet_id, requested_at DESC);
CREATE INDEX ON wallet_transfers (status, expires_at) WHERE status IN ('REQUESTED', 'SENT');
CREATE TRIGGER wallet_transfers_refs BEFORE INSERT OR UPDATE ON wallet_transfers FOR EACH ROW EXECUTE FUNCTION money_entity_refs_guard();
CREATE OR REPLACE FUNCTION wallet_transfers_session_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.cashless_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cashless_sessions WHERE id = NEW.cashless_session_id AND wallet_id = NEW.wallet_id AND machine_id = NEW.machine_id) THEN
    RAISE EXCEPTION 'wallet_transfers: cashless session belongs to another wallet or machine';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER wallet_transfers_session_guard BEFORE INSERT ON wallet_transfers FOR EACH ROW EXECUTE FUNCTION wallet_transfers_session_guard();
CREATE TRIGGER wallet_transfers_transition BEFORE UPDATE ON wallet_transfers FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('REQUESTED>SENT', 'REQUESTED>FAILED', 'REQUESTED>EXPIRED', 'SENT>CONFIRMED', 'SENT>FAILED', 'SENT>EXPIRED');
CREATE OR REPLACE FUNCTION wallet_transfers_amount_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.direction <> OLD.direction OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'wallet_transfers: amount, direction and request key are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER wallet_transfers_amount_guard BEFORE UPDATE ON wallet_transfers FOR EACH ROW EXECUTE FUNCTION wallet_transfers_amount_guard();

-- ---------------------------------------------------------------------------------------------
-- Handpays: one per jackpot / cancel-credit event. Payment is independent from the machine reset.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE handpays (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL REFERENCES organizations(id),
  casino_id                   uuid NOT NULL REFERENCES casinos(id),
  machine_id                  uuid NOT NULL REFERENCES machines(id),
  source_event_id             uuid NOT NULL REFERENCES machine_events(event_id),
  kind                        text NOT NULL DEFAULT 'JACKPOT' CHECK (kind IN ('JACKPOT', 'CANCEL_CREDIT')),
  amount_cents                bigint NOT NULL CHECK (amount_cents > 0),
  status                      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'PAID', 'MACHINE_RESET', 'VOIDED')),
  player_id                   uuid REFERENCES players(id),
  card_id                     uuid REFERENCES player_cards(id),
  approval_id                 uuid REFERENCES approvals(id),
  approved_by                 uuid REFERENCES employees(id),
  approved_at                 timestamptz,
  paid_by                     uuid REFERENCES employees(id),
  paid_at                     timestamptz,
  pay_method                  text CHECK (pay_method IN ('CASH', 'WALLET')),
  cashier_session_id          uuid REFERENCES cashier_sessions(id),
  legacy_cash_transaction_id  bigint REFERENCES cash_transactions(id),   -- Step 1/legacy payment record
  reset_requested_at          timestamptz,
  reset_confirmed_at          timestamptz,
  reset_attempts              int NOT NULL DEFAULT 0,
  voided_by                   uuid REFERENCES employees(id),
  voided_at                   timestamptz,
  void_reason                 text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  -- One jackpot event creates exactly one handpay.
  CONSTRAINT handpays_one_per_event UNIQUE (source_event_id),
  CONSTRAINT handpays_four_eyes CHECK (approved_by IS NULL OR paid_by IS NULL OR approved_by <> paid_by),
  CHECK (status NOT IN ('PAID', 'MACHINE_RESET') OR (paid_at IS NOT NULL AND pay_method IS NOT NULL)),
  CHECK (status <> 'MACHINE_RESET' OR reset_confirmed_at IS NOT NULL),
  CHECK (status <> 'VOIDED' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX ON handpays (org_id, casino_id, status);
CREATE INDEX ON handpays (machine_id, created_at DESC);
CREATE TRIGGER handpays_transition BEFORE UPDATE ON handpays FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition('PENDING>APPROVED', 'PENDING>VOIDED', 'APPROVED>PAID', 'APPROVED>VOIDED', 'PAID>MACHINE_RESET');
CREATE OR REPLACE FUNCTION handpays_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
      RAISE EXCEPTION 'handpays: machine does not belong to this organisation / casino';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM machine_events WHERE event_id = NEW.source_event_id AND machine_id = NEW.machine_id AND type IN ('JACKPOT')) THEN
      RAISE EXCEPTION 'handpays: source event is not a jackpot event of this machine';
    END IF;
  ELSIF NEW.amount_cents <> OLD.amount_cents OR NEW.machine_id <> OLD.machine_id OR NEW.source_event_id <> OLD.source_event_id
     OR NEW.org_id <> OLD.org_id OR NEW.casino_id <> OLD.casino_id THEN
    RAISE EXCEPTION 'handpays: amount and references are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER handpays_guard BEFORE INSERT OR UPDATE ON handpays FOR EACH ROW EXECUTE FUNCTION handpays_guard();
CREATE TRIGGER handpays_no_delete BEFORE DELETE ON handpays FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE handpay_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  handpay_id   uuid NOT NULL REFERENCES handpays(id),
  action       text NOT NULL,   -- CREATED, APPROVED, PAID, RESET_REQUESTED, RESET_CONFIRMED, VOIDED, MIGRATED
  from_status  text,
  to_status    text,
  employee_id  uuid REFERENCES employees(id),
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON handpay_events (handpay_id);
CREATE TRIGGER handpay_events_immutable BEFORE UPDATE OR DELETE ON handpay_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Backfill (a): jackpots already paid through the Step 1 handpay (legacy cash transaction).
INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, kind, amount_cents, status, paid_by, paid_at, pay_method,
                      cashier_session_id, legacy_cash_transaction_id, approved_at, reset_requested_at, reset_confirmed_at, created_at)
SELECT e.org_id, e.casino_id, e.machine_id, e.event_id, 'JACKPOT', round(e.amount * 100)::bigint,
       CASE WHEN r.occurred_at IS NOT NULL THEN 'MACHINE_RESET' ELSE 'PAID' END,
       ct.employee_id, ct.created_at, 'CASH', ct.session_id, ct.id, ct.created_at, ct.created_at, r.occurred_at, e.occurred_at
FROM cash_transactions ct
JOIN machine_events e ON e.event_id = ct.source_event_id AND e.type = 'JACKPOT' AND e.amount > 0
LEFT JOIN LATERAL (
  SELECT min(x.occurred_at) AS occurred_at FROM machine_events x
  WHERE x.machine_id = e.machine_id AND x.type = 'JACKPOT_RESET' AND x.occurred_at >= e.occurred_at
) r ON true
WHERE ct.type = 'HANDPAY';

-- Backfill (b): the currently pending, unpaid jackpot of each machine.
INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, kind, amount_cents, status, created_at)
SELECT m.org_id, m.casino_id, m.id, jp.event_id, 'JACKPOT', round(jp.amount * 100)::bigint, 'PENDING', jp.occurred_at
FROM machines m
JOIN LATERAL (
  SELECT event_id, amount, occurred_at FROM machine_events WHERE machine_id = m.id AND type = 'JACKPOT' ORDER BY occurred_at DESC, id DESC LIMIT 1
) jp ON true
WHERE m.jackpot_pending AND jp.amount > 0
ON CONFLICT ON CONSTRAINT handpays_one_per_event DO NOTHING;

INSERT INTO handpay_events (org_id, handpay_id, action, to_status, details, created_at)
SELECT org_id, id, 'MIGRATED', status, '{"source": "migration 005"}', created_at FROM handpays;

-- ---------------------------------------------------------------------------------------------
-- Ticket extensions: validation / hold / redemption / expiry / cancellation
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN amount_cents     bigint GENERATED ALWAYS AS (round(amount * 100)::bigint) STORED,
  ADD COLUMN hold_id          uuid,
  ADD COLUMN hold_until       timestamptz,
  ADD COLUMN hold_machine_id  uuid REFERENCES machines(id),
  ADD COLUMN hold_source      text CHECK (hold_source IN ('MACHINE', 'CASHIER')),
  ADD CONSTRAINT tickets_status_check CHECK (status IN ('VALID', 'HELD', 'REDEEMED', 'CANCELLED', 'EXPIRED', 'VOID')),
  ADD CONSTRAINT tickets_hold_shape CHECK ((status = 'HELD') = (hold_id IS NOT NULL AND hold_until IS NOT NULL));
CREATE UNIQUE INDEX tickets_hold_id_key ON tickets (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX tickets_held_until ON tickets (hold_until) WHERE status = 'HELD';

-- ---------------------------------------------------------------------------------------------
-- Machine commands: which handpay / transfer a command belongs to
-- ---------------------------------------------------------------------------------------------
ALTER TABLE machine_commands
  ADD COLUMN handpay_id uuid REFERENCES handpays(id),
  ADD COLUMN transfer_id uuid REFERENCES wallet_transfers(id);

-- ---------------------------------------------------------------------------------------------
-- Foreign keys left open in 004 (ledger -> entity, one direction)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  ADD CONSTRAINT ledger_accounts_vault_fk FOREIGN KEY (vault_id) REFERENCES vaults(id);
ALTER TABLE money_transactions
  ADD CONSTRAINT money_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  ADD CONSTRAINT money_transactions_vault_fk FOREIGN KEY (vault_id) REFERENCES vaults(id),
  ADD CONSTRAINT money_transactions_handpay_fk FOREIGN KEY (handpay_id) REFERENCES handpays(id),
  ADD CONSTRAINT money_transactions_transfer_fk FOREIGN KEY (transfer_id) REFERENCES wallet_transfers(id);
CREATE INDEX ON money_transactions (handpay_id) WHERE handpay_id IS NOT NULL;
CREATE INDEX ON money_transactions (transfer_id) WHERE transfer_id IS NOT NULL;

-- Ledger accounts: wallet / vault owners must belong to the account's organisation / casino.
CREATE OR REPLACE FUNCTION ledger_accounts_owner_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.wallet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'ledger account: wallet belongs to another organisation';
  END IF;
  IF NEW.vault_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'ledger account: vault does not belong to this casino';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_owner_guard BEFORE INSERT ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION ledger_accounts_owner_guard();

-- Money transactions: referenced entities belong to the same organisation.
CREATE OR REPLACE FUNCTION money_transactions_entity_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.wallet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money transaction: wallet belongs to another organisation';
  END IF;
  IF NEW.wallet_id IS NOT NULL AND NEW.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND player_id = NEW.player_id) THEN
    RAISE EXCEPTION 'money transaction: wallet does not belong to the player';
  END IF;
  IF NEW.card_id IS NOT NULL AND (NEW.player_id IS NULL OR NOT EXISTS (SELECT 1 FROM player_cards WHERE id = NEW.card_id AND player_id = NEW.player_id)) THEN
    RAISE EXCEPTION 'money transaction: card does not belong to the player';
  END IF;
  IF NEW.handpay_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM handpays WHERE id = NEW.handpay_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money transaction: handpay belongs to another organisation';
  END IF;
  IF NEW.transfer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallet_transfers WHERE id = NEW.transfer_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money transaction: transfer belongs to another organisation';
  END IF;
  IF NEW.vault_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.vault_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money transaction: vault belongs to another organisation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER money_transactions_entity_guard BEFORE INSERT ON money_transactions FOR EACH ROW EXECUTE FUNCTION money_transactions_entity_guard();

-- ---------------------------------------------------------------------------------------------
-- Wallet balances: a view over the ledger, not a second balance system.
-- ---------------------------------------------------------------------------------------------
CREATE VIEW wallet_balances AS
SELECT w.id AS wallet_id, w.org_id, w.player_id, w.status,
  COALESCE(sum(b.balance_cents * b.normal_sign) FILTER (WHERE a.kind = 'WALLET_AVAILABLE'), 0)::bigint AS available_cents,
  COALESCE(sum(b.balance_cents * b.normal_sign) FILTER (WHERE a.kind = 'WALLET_RESERVED'), 0)::bigint AS reserved_cents
FROM wallets w
LEFT JOIN ledger_accounts a ON a.wallet_id = w.id
LEFT JOIN ledger_balances b ON b.account_id = a.id
GROUP BY w.id;
