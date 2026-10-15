-- 004: Double-entry money ledger. The financial source of truth.
--
-- Conventions (from the shared money model, packages/shared/src/money):
--   integer cents (bigint), debit = destination = positive, credit = source = negative,
--   every money transaction sums to exactly 0, money transactions and entries are immutable.
-- Account kinds and transaction types are NOT defined here: the reference tables below are filled
-- from the shared model at startup (syncMoneyModel), and everything else references them.
-- Gaming (bets, wins) never enters the ledger; MACHINE_CREDIT is the only bridge.
-- This migration changes no existing table and moves no existing data.

CREATE TABLE ledger_account_kinds (
  code            text PRIMARY KEY,
  class           text NOT NULL CHECK (class IN ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY')),
  scope           text NOT NULL CHECK (scope IN ('ORG', 'CASINO')),
  owner           text NOT NULL CHECK (owner IN ('NONE', 'MACHINE', 'WALLET', 'CASHIER_SESSION', 'VAULT')),
  allow_negative  boolean NOT NULL,
  -- +1: balance shown as summed (assets, expenses); -1: sign-flipped (liabilities, income, equity)
  normal_sign     smallint NOT NULL CHECK (normal_sign IN (1, -1)),
  description     text
);

CREATE TABLE money_transaction_types (
  code    text PRIMARY KEY,
  rail    text NOT NULL,
  label   text NOT NULL,
  signed  boolean NOT NULL,
  CONSTRAINT money_transaction_types_no_coin CHECK (code !~ 'COIN')
);

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  kind                text NOT NULL REFERENCES ledger_account_kinds(code),
  casino_id           uuid REFERENCES casinos(id),            -- NULL for organisation-level kinds (wallets)
  machine_id          uuid REFERENCES machines(id),
  wallet_id           uuid,                                    -- FK added with the wallets table (005)
  cashier_session_id  uuid REFERENCES cashier_sessions(id),
  vault_id            uuid,                                    -- FK added with the vaults table (005)
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_identity UNIQUE NULLS NOT DISTINCT (org_id, kind, casino_id, machine_id, wallet_id, cashier_session_id, vault_id)
);
CREATE INDEX ON ledger_accounts (org_id, casino_id, kind);
CREATE INDEX ON ledger_accounts (wallet_id) WHERE wallet_id IS NOT NULL;

-- Scope and owner must match the account kind; owners must belong to the same org / casino.
CREATE OR REPLACE FUNCTION ledger_accounts_validate() RETURNS trigger AS $$
DECLARE k ledger_account_kinds%ROWTYPE;
BEGIN
  SELECT * INTO k FROM ledger_account_kinds WHERE code = NEW.kind;
  IF k.scope = 'ORG' AND NEW.casino_id IS NOT NULL THEN
    RAISE EXCEPTION 'ledger account %: organisation-level kind must not have a casino', NEW.kind;
  END IF;
  IF k.scope = 'CASINO' AND NEW.casino_id IS NULL THEN
    RAISE EXCEPTION 'ledger account %: casino-level kind needs a casino', NEW.kind;
  END IF;
  IF (k.owner = 'MACHINE') <> (NEW.machine_id IS NOT NULL)
     OR (k.owner = 'WALLET') <> (NEW.wallet_id IS NOT NULL)
     OR (k.owner = 'CASHIER_SESSION') <> (NEW.cashier_session_id IS NOT NULL)
     OR (k.owner = 'VAULT') <> (NEW.vault_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ledger account %: owner reference does not match kind owner %', NEW.kind, k.owner;
  END IF;
  IF NEW.casino_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM casinos WHERE id = NEW.casino_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'ledger account: casino belongs to another organisation';
  END IF;
  IF NEW.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machines WHERE id = NEW.machine_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'ledger account: machine does not belong to this casino';
  END IF;
  IF NEW.cashier_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cashier_sessions WHERE id = NEW.cashier_session_id AND org_id = NEW.org_id AND casino_id = NEW.casino_id) THEN
    RAISE EXCEPTION 'ledger account: cashier session does not belong to this casino';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_validate BEFORE INSERT ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION ledger_accounts_validate();
CREATE TRIGGER ledger_accounts_immutable BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Balances: derived from entries, maintained only by the posting trigger.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ledger_balances (
  account_id      uuid PRIMARY KEY REFERENCES ledger_accounts(id),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  balance_cents   bigint NOT NULL DEFAULT 0,      -- signed sum of entries (debit +, credit -)
  allow_negative  boolean NOT NULL,
  normal_sign     smallint NOT NULL,
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Insufficient balance protection: e.g. a wallet or drawer can never go below zero.
  CONSTRAINT ledger_balances_sufficient CHECK (allow_negative OR balance_cents * normal_sign >= 0)
);

CREATE OR REPLACE FUNCTION ledger_accounts_open_balance() RETURNS trigger AS $$
BEGIN
  INSERT INTO ledger_balances (account_id, org_id, allow_negative, normal_sign)
  SELECT NEW.id, NEW.org_id, k.allow_negative, k.normal_sign FROM ledger_account_kinds k WHERE k.code = NEW.kind;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_open_balance AFTER INSERT ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION ledger_accounts_open_balance();

CREATE OR REPLACE FUNCTION ledger_balances_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_balances cannot be deleted';
  END IF;
  IF current_setting('m1.ledger_posting', true) IS DISTINCT FROM 'on'
     OR NEW.account_id <> OLD.account_id OR NEW.allow_negative <> OLD.allow_negative OR NEW.normal_sign <> OLD.normal_sign THEN
    RAISE EXCEPTION 'ledger_balances can only be changed by posting ledger entries';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_balances_guard BEFORE UPDATE OR DELETE ON ledger_balances FOR EACH ROW EXECUTE FUNCTION ledger_balances_guard();

-- ---------------------------------------------------------------------------------------------
-- Money transactions (header)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE money_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  casino_id           uuid REFERENCES casinos(id),
  type                text NOT NULL REFERENCES money_transaction_types(code),
  amount_cents        bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 10000000000000),
  -- Exactly-once: one money movement per dedupe key and organisation, whatever the code path.
  dedupe_key          text NOT NULL,
  request_hash        text NOT NULL,
  -- References / context only (no personal data).
  player_id           uuid REFERENCES players(id),
  wallet_id           uuid,                                    -- FK added in 005
  card_id             uuid REFERENCES player_cards(id),
  machine_id          uuid REFERENCES machines(id),
  cashier_session_id  uuid REFERENCES cashier_sessions(id),
  vault_id            uuid,                                    -- FK added in 005
  ticket_id           uuid REFERENCES tickets(id),
  handpay_id          uuid,                                    -- FK added in 005
  transfer_id         uuid,                                    -- FK added in 005
  source_event_id     uuid REFERENCES machine_events(event_id),
  options             jsonb NOT NULL DEFAULT '{}',              -- payTo / payFrom / source / feeCents
  reversal_of         uuid REFERENCES money_transactions(id),
  reason              text,
  actor_type          text NOT NULL CHECK (actor_type IN ('EMPLOYEE', 'GATEWAY', 'SYSTEM')),
  actor_id            uuid REFERENCES employees(id),
  approved_by         uuid REFERENCES employees(id),
  business_date       date NOT NULL,
  created_txid        xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_transactions_dedupe UNIQUE (org_id, dedupe_key),
  CONSTRAINT money_transactions_one_reversal UNIQUE (reversal_of),
  CONSTRAINT money_transactions_reversal_shape CHECK ((type = 'REVERSAL') = (reversal_of IS NOT NULL)),
  CONSTRAINT money_transactions_approver_differs CHECK (approved_by IS NULL OR actor_id IS NULL OR approved_by <> actor_id)
);
CREATE INDEX ON money_transactions (org_id, casino_id, created_at DESC);
CREATE INDEX ON money_transactions (wallet_id) WHERE wallet_id IS NOT NULL;
CREATE INDEX ON money_transactions (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX ON money_transactions (machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX ON money_transactions (ticket_id) WHERE ticket_id IS NOT NULL;

CREATE OR REPLACE FUNCTION money_transactions_validate() RETURNS trigger AS $$
DECLARE t money_transaction_types%ROWTYPE;
BEGIN
  SELECT * INTO t FROM money_transaction_types WHERE code = NEW.type;
  IF NOT t.signed AND NEW.amount_cents <= 0 THEN
    RAISE EXCEPTION 'money transaction %: amount must be positive', NEW.type;
  END IF;
  IF NEW.casino_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM casinos WHERE id = NEW.casino_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'money transaction: casino belongs to another organisation';
  END IF;
  IF NEW.reversal_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM money_transactions WHERE id = NEW.reversal_of AND org_id = NEW.org_id AND type <> 'REVERSAL') THEN
    RAISE EXCEPTION 'money transaction: invalid reversal target';
  END IF;
  NEW.created_txid := pg_current_xact_id();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER money_transactions_validate BEFORE INSERT ON money_transactions FOR EACH ROW EXECUTE FUNCTION money_transactions_validate();
CREATE TRIGGER money_transactions_immutable BEFORE UPDATE OR DELETE ON money_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Ledger entries
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  transaction_id  uuid NOT NULL REFERENCES money_transactions(id),
  account_id      uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_cents    bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 10000000000000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (transaction_id);
CREATE INDEX ON ledger_entries (account_id, id);

-- Entries belong to a transaction created in the same database transaction, same organisation,
-- and casino-level accounts must belong to the transaction's casino.
CREATE OR REPLACE FUNCTION ledger_entries_validate() RETURNS trigger AS $$
DECLARE tx money_transactions%ROWTYPE; acc ledger_accounts%ROWTYPE;
BEGIN
  SELECT * INTO tx FROM money_transactions WHERE id = NEW.transaction_id;
  IF tx.created_txid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger entries can only be added in the transaction that created the money transaction';
  END IF;
  SELECT * INTO acc FROM ledger_accounts WHERE id = NEW.account_id;
  IF acc.org_id <> tx.org_id THEN
    RAISE EXCEPTION 'ledger entry: account belongs to another organisation';
  END IF;
  IF acc.casino_id IS NOT NULL AND acc.casino_id IS DISTINCT FROM tx.casino_id THEN
    RAISE EXCEPTION 'ledger entry: casino account % belongs to another casino than the transaction', acc.kind;
  END IF;
  NEW.org_id := tx.org_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_validate BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_validate();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Posting: every entry moves the account balance. The balance CHECK rejects overdrafts.
CREATE OR REPLACE FUNCTION ledger_entries_post() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('m1.ledger_posting', 'on', true);
  UPDATE ledger_balances SET balance_cents = balance_cents + NEW.amount_cents, version = version + 1, updated_at = now()
  WHERE account_id = NEW.account_id;
  PERFORM set_config('m1.ledger_posting', 'off', true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_post AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_post();

-- At COMMIT: every money transaction has at least two entries that sum to exactly zero.
CREATE OR REPLACE FUNCTION money_transactions_balanced() RETURNS trigger AS $$
DECLARE n int; s bigint;
BEGIN
  SELECT count(*), COALESCE(sum(amount_cents), 0) INTO n, s FROM ledger_entries WHERE transaction_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'money transaction % (%) has % ledger entries, at least 2 required', NEW.id, NEW.type, n;
  END IF;
  IF s <> 0 THEN
    RAISE EXCEPTION 'money transaction % (%) is unbalanced: entries sum to %', NEW.id, NEW.type, s;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER money_transactions_balanced AFTER INSERT ON money_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION money_transactions_balanced();

COMMENT ON TABLE money_transactions IS 'Immutable money transactions. Corrections are new transactions (REVERSAL / ADJUSTMENT).';
COMMENT ON TABLE ledger_balances IS 'Derived cache of ledger_entries per account, maintained only by the posting trigger.';
