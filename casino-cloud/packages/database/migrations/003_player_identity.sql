-- 003: Player identity domain.
--
-- Separation of domains:
--   identity : players (pseudonymous id, player_no, status), player_profiles (personal data),
--              player_cards (identifiers), player_verifications, player_status_history
--   gaming   : player_sessions (+ card_id), machine events, meters            (unchanged)
--   loyalty  : legacy players.tier / points (moves to its own domain later) (unchanged)
--   money    : references player_id / card_id only, never player_profiles   (ledger follows in 004)
--
-- No money or ledger tables are created here.

-- ---------------------------------------------------------------------------------------------
-- players: identity columns
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE player_no_seq;

ALTER TABLE players
  ADD COLUMN player_no            text,
  ADD COLUMN status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXCLUDED', 'CLOSED')),
  ADD COLUMN verification_status  text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  ADD COLUMN home_casino_id       uuid REFERENCES casinos(id),
  ADD COLUMN status_changed_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();

-- Deterministic player numbers for existing players: ordered by creation time, then legacy card, then id.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, card_number, id) AS rn FROM players
)
UPDATE players p SET player_no = 'P' || lpad(n.rn::text, 8, '0') FROM numbered n WHERE n.id = p.id;
SELECT setval('player_no_seq', GREATEST((SELECT count(*) FROM players), 1), (SELECT count(*) FROM players) > 0);

ALTER TABLE players
  ALTER COLUMN player_no SET DEFAULT 'P' || lpad(nextval('player_no_seq')::text, 8, '0'),
  ALTER COLUMN player_no SET NOT NULL,
  ADD CONSTRAINT players_org_player_no_key UNIQUE (org_id, player_no);

-- ---------------------------------------------------------------------------------------------
-- player_profiles: personal data, kept apart so it can be encrypted, anonymised or deleted
-- without touching money, gaming or audit records (which only hold player_id).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE player_profiles (
  player_id      uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations(id),
  first_name     text,
  last_name      text,
  birth_date     date,
  email          text,
  phone          text,
  nationality    text,
  address        jsonb,
  anonymized_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO player_profiles (player_id, org_id, first_name, last_name)
SELECT id, org_id, first_name, last_name FROM players;

-- ---------------------------------------------------------------------------------------------
-- player_cards: the ONLY authoritative card lookup. A card is an identifier, never a money container.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE player_cards (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  player_id            uuid NOT NULL REFERENCES players(id),
  card_number          text NOT NULL,
  card_type            text NOT NULL DEFAULT 'MAGSTRIPE' CHECK (card_type IN ('MAGSTRIPE', 'RFID', 'QR', 'VIRTUAL')),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'LOST', 'REPLACED', 'EXPIRED')),
  status_reason        text,
  issued_at            timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz,
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  replaced_by_card_id  uuid REFERENCES player_cards(id),
  issued_by            uuid REFERENCES employees(id),
  -- A card number belongs to exactly one card (and so one player) per organisation, forever.
  CONSTRAINT player_cards_org_card_number_key UNIQUE (org_id, card_number),
  CONSTRAINT player_cards_not_self_replaced CHECK (replaced_by_card_id IS DISTINCT FROM id)
);
-- At most one usable card per player.
CREATE UNIQUE INDEX player_cards_one_active_per_player ON player_cards (player_id) WHERE status = 'ACTIVE';
CREATE INDEX ON player_cards (player_id);

-- Deterministic backfill: exactly one ACTIVE card per legacy card number, same player.
INSERT INTO player_cards (org_id, player_id, card_number, card_type, status, issued_at, status_changed_at)
SELECT org_id, id, card_number, 'MAGSTRIPE', 'ACTIVE', created_at, created_at FROM players
WHERE card_number IS NOT NULL
ON CONFLICT (org_id, card_number) DO NOTHING;

-- Cards: identity columns are immutable, terminal states stay terminal, replacement link set once.
CREATE OR REPLACE FUNCTION player_cards_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.player_id <> OLD.player_id OR NEW.card_number <> OLD.card_number THEN
    RAISE EXCEPTION 'player_cards: org_id, player_id and card_number are immutable';
  END IF;
  IF OLD.status IN ('LOST', 'REPLACED', 'EXPIRED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'player_cards: % is a terminal status', OLD.status;
  END IF;
  IF OLD.replaced_by_card_id IS NOT NULL AND NEW.replaced_by_card_id IS DISTINCT FROM OLD.replaced_by_card_id THEN
    RAISE EXCEPTION 'player_cards: replacement link cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER player_cards_guard BEFORE UPDATE ON player_cards FOR EACH ROW EXECUTE FUNCTION player_cards_guard();
CREATE TRIGGER player_cards_no_delete BEFORE DELETE ON player_cards FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Card history (append-only).
CREATE TABLE player_card_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  card_id      uuid NOT NULL REFERENCES player_cards(id),
  player_id    uuid NOT NULL REFERENCES players(id),
  action       text NOT NULL,   -- ISSUED, BLOCKED, UNBLOCKED, LOST, REPLACED, EXPIRED
  reason       text,
  employee_id  uuid REFERENCES employees(id),
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_card_events (card_id);
CREATE TRIGGER player_card_events_immutable BEFORE UPDATE OR DELETE ON player_card_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
INSERT INTO player_card_events (org_id, card_id, player_id, action, details, created_at)
SELECT org_id, id, player_id, 'ISSUED', '{"source": "migration 003 from players.card_number"}', issued_at FROM player_cards;

-- ---------------------------------------------------------------------------------------------
-- Verification (KYC) history. Only masked numbers and keyed hashes are stored, never raw numbers.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE player_verifications (
  id                  bigserial PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id),
  player_id           uuid NOT NULL REFERENCES players(id),
  status              text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  method              text,
  document_type       text,
  document_country    text,
  document_number_masked text,
  document_number_hash   text,
  valid_until         date,
  note                text,
  decided_by          uuid REFERENCES employees(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_verifications (player_id, id DESC);
CREATE INDEX ON player_verifications (org_id, document_number_hash);
CREATE TRIGGER player_verifications_immutable BEFORE UPDATE OR DELETE ON player_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Player status history (append-only).
CREATE TABLE player_status_history (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  player_id    uuid NOT NULL REFERENCES players(id),
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  changed_by   uuid REFERENCES employees(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_status_history (player_id, id DESC);
CREATE TRIGGER player_status_history_immutable BEFORE UPDATE OR DELETE ON player_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
INSERT INTO player_status_history (org_id, player_id, from_status, to_status, reason, created_at)
SELECT org_id, id, NULL, status, 'migration 003', created_at FROM players;

-- CLOSED is terminal.
CREATE OR REPLACE FUNCTION players_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'players: CLOSED is a terminal status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER players_status_guard BEFORE UPDATE OF status ON players FOR EACH ROW EXECUTE FUNCTION players_status_guard();

-- Verification threshold concept: configurable per organisation, no amount built in (NULL = none).
ALTER TABLE organizations ADD COLUMN verification_threshold_cents bigint CHECK (verification_threshold_cents IS NULL OR verification_threshold_cents >= 0);

-- ---------------------------------------------------------------------------------------------
-- Gaming: record which card started a carded session. Historical sessions are left untouched (NULL).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE player_sessions ADD COLUMN card_id uuid REFERENCES player_cards(id);

-- ---------------------------------------------------------------------------------------------
-- Legacy columns: players.card_number, first_name, last_name are kept for compatibility but are
-- read-only. Authoritative sources: player_cards and player_profiles. They may only be cleared
-- (set to NULL, e.g. for anonymisation), never written with a value.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE players
  ALTER COLUMN card_number DROP NOT NULL,
  ALTER COLUMN first_name DROP NOT NULL,
  ALTER COLUMN last_name DROP NOT NULL;

CREATE OR REPLACE FUNCTION players_legacy_readonly() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.card_number IS NOT NULL OR NEW.first_name IS NOT NULL OR NEW.last_name IS NOT NULL THEN
      RAISE EXCEPTION 'players.card_number/first_name/last_name are legacy read-only columns: use player_cards and player_profiles';
    END IF;
  ELSIF (NEW.card_number IS DISTINCT FROM OLD.card_number AND NEW.card_number IS NOT NULL)
     OR (NEW.first_name IS DISTINCT FROM OLD.first_name AND NEW.first_name IS NOT NULL)
     OR (NEW.last_name IS DISTINCT FROM OLD.last_name AND NEW.last_name IS NOT NULL) THEN
    RAISE EXCEPTION 'players.card_number/first_name/last_name are legacy read-only columns: use player_cards and player_profiles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER players_legacy_readonly BEFORE INSERT OR UPDATE OF card_number, first_name, last_name ON players
  FOR EACH ROW EXECUTE FUNCTION players_legacy_readonly();

COMMENT ON COLUMN players.card_number IS 'LEGACY, read-only. Authoritative card lookup: player_cards.';
COMMENT ON COLUMN players.first_name IS 'LEGACY, read-only. Authoritative: player_profiles.';
COMMENT ON COLUMN players.last_name IS 'LEGACY, read-only. Authoritative: player_profiles.';
COMMENT ON TABLE player_cards IS 'Card identifiers. A card is never a wallet or money container.';
