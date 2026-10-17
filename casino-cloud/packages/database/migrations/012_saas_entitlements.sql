-- =============================================================================================
-- 012: multi-tenant SaaS administration and commercial entitlements
--
--   organizations.status / is_platform    tenant lifecycle; the platform operator's own organisation
--   employees.is_platform_admin           platform administrators (only in a platform organisation)
--   casinos.status                        site lifecycle (an inactive casino is not operable)
--   product_modules / product_limits      registry of module and limit keys (mirrored from code)
--   plans                                 configurable plans (modules, limits, price metadata, version)
--   subscriptions                         one per organisation: plan + lifecycle status + validity
--   entitlement_overrides                 per organisation, beats the plan (both directions)
--   limit_overrides                       per organisation, beats the plan limit
--   org_module_settings                   the customer's own switch for a purchased module
--
-- No money table is touched and no money transaction is created. Existing organisations get a deterministic,
-- safe default: plan CUSTOM (CORE only) plus overrides for exactly the modules they demonstrably use (data or
-- ledger cutovers), each override with its derivation as reason. Nobody receives an unused paid module.
-- =============================================================================================

ALTER TABLE organizations
  ADD COLUMN status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  ADD COLUMN status_reason  text,
  ADD COLUMN is_platform    boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

ALTER TABLE casinos
  ADD COLUMN status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD COLUMN status_reason  text;

ALTER TABLE employees ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION employees_platform_admin_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.is_platform_admin AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND is_platform) THEN
    RAISE EXCEPTION 'employees: platform administrators belong to a platform organisation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER employees_platform_admin_guard BEFORE INSERT OR UPDATE OF is_platform_admin, org_id ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_platform_admin_guard();

-- Login matches lower(email): the address must be unique ignoring case (audit finding H3).
DO $$
BEGIN
  IF EXISTS (SELECT lower(email) FROM employees GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'migration 012: employees with e-mail addresses that differ only in case exist; resolve them before upgrading';
  END IF;
END $$;
CREATE UNIQUE INDEX employees_email_lower_key ON employees (lower(email));

-- ---------------------------------------------------------------------------------------------
-- Registries (rows mirrored from packages/shared/src/entitlements.ts on every start)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE product_modules (
  key   text PRIMARY KEY,
  name  text NOT NULL
);
INSERT INTO product_modules (key, name) VALUES
  ('CORE', 'Core'), ('TITO', 'TITO'), ('HANDPAY', 'Handpay'), ('CASH', 'Cash'), ('VAULT', 'Vault'), ('CASHLESS', 'Cashless'),
  ('MACHINE', 'Machine Money'), ('REPORTING', 'Reporting'), ('ADVANCED_RECONCILIATION', 'Advanced Reconciliation');

CREATE TABLE product_limits (
  key   text PRIMARY KEY,
  label text NOT NULL,
  kind  text NOT NULL CHECK (kind IN ('HARD', 'SOFT'))
);
INSERT INTO product_limits (key, label, kind) VALUES
  ('MAX_CASINOS', 'Casinos / sites', 'HARD'), ('MAX_MACHINES', 'Machines', 'HARD'), ('MAX_USERS', 'Users (active)', 'HARD'),
  ('MAX_PLAYERS', 'Players', 'HARD'), ('MAX_WALLETS', 'Cashless wallets', 'SOFT'), ('MAX_CASHLESS_PLAYERS', 'Cashless players (active this month)', 'SOFT'),
  ('MAX_MONTHLY_TITO_VOLUME', 'TITO tickets this month', 'SOFT'), ('MAX_MONTHLY_HANDPAYS', 'Handpays this month', 'SOFT');

-- ---------------------------------------------------------------------------------------------
-- Plans: configurable, versioned (a change creates a new version; subscriptions keep theirs)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL,
  version           int NOT NULL DEFAULT 1 CHECK (version >= 1),
  name              text NOT NULL,
  description       text,
  active            boolean NOT NULL DEFAULT true,          -- offered for new subscriptions
  modules           text[] NOT NULL,
  limits            jsonb NOT NULL DEFAULT '{}',            -- limit key -> number (absent = unlimited)
  price_cents       bigint CHECK (price_cents >= 0),        -- metadata only: no billing in this phase
  currency          text NOT NULL DEFAULT 'EUR',
  billing_interval  text NOT NULL DEFAULT 'MONTH' CHECK (billing_interval IN ('MONTH', 'YEAR', 'NONE')),
  created_by        uuid REFERENCES employees(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version),
  CHECK ('CORE' = ANY (modules))
);

CREATE OR REPLACE FUNCTION plans_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.modules) m WHERE m NOT IN (SELECT key FROM product_modules)) THEN
    RAISE EXCEPTION 'plans: unknown module in %', NEW.modules;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.limits) k WHERE k NOT IN (SELECT key FROM product_limits)) THEN
    RAISE EXCEPTION 'plans: unknown limit in %', NEW.limits;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.modules IS DISTINCT FROM OLD.modules OR NEW.limits IS DISTINCT FROM OLD.limits OR NEW.code <> OLD.code OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'plans: a plan version is immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER plans_guard BEFORE INSERT OR UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION plans_guard();

INSERT INTO plans (code, name, description, modules, limits, price_cents, billing_interval) VALUES
  ('CUSTOM', 'Custom', 'Core only; modules are assigned individually', ARRAY['CORE'], '{}', NULL, 'NONE'),
  ('TITO_STARTER', 'TITO Starter', 'Ticket in / ticket out with reporting', ARRAY['CORE', 'TITO', 'REPORTING'], '{"MAX_CASINOS": 1, "MAX_MACHINES": 100, "MAX_USERS": 25}', 49000, 'MONTH'),
  ('TITO_HANDPAY', 'TITO + Handpay', 'Tickets and jackpot handpays', ARRAY['CORE', 'TITO', 'HANDPAY', 'REPORTING'], '{"MAX_CASINOS": 2, "MAX_MACHINES": 250, "MAX_USERS": 50}', 79000, 'MONTH'),
  ('CASH_OPERATIONS', 'Cash Operations', 'Cage, vault, tickets and handpays', ARRAY['CORE', 'CASH', 'VAULT', 'TITO', 'HANDPAY', 'REPORTING'], '{"MAX_CASINOS": 3, "MAX_MACHINES": 500, "MAX_USERS": 100}', 149000, 'MONTH'),
  ('CASHLESS_MACHINE', 'Cashless + Machine Money', 'Player wallets and machine money', ARRAY['CORE', 'CASHLESS', 'MACHINE', 'VAULT', 'REPORTING'], '{"MAX_CASINOS": 3, "MAX_MACHINES": 500, "MAX_USERS": 100, "MAX_WALLETS": 20000}', 129000, 'MONTH'),
  ('ENTERPRISE', 'Enterprise', 'Every module, no limits', ARRAY['CORE', 'TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE', 'REPORTING', 'ADVANCED_RECONCILIATION'], '{}', NULL, 'YEAR');

-- ---------------------------------------------------------------------------------------------
-- Subscriptions, overrides, customer switches
-- ---------------------------------------------------------------------------------------------
CREATE TABLE subscriptions (
  org_id      uuid PRIMARY KEY REFERENCES organizations(id),
  plan_id     uuid NOT NULL REFERENCES plans(id),
  status      text NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED')),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  note        text,
  updated_by  uuid REFERENCES employees(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE entitlement_overrides (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  module_key  text NOT NULL REFERENCES product_modules(key),
  entitled    boolean NOT NULL,
  reason      text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by  uuid REFERENCES employees(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, module_key),
  CHECK (module_key <> 'CORE')
);

CREATE TABLE limit_overrides (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  limit_key   text NOT NULL REFERENCES product_limits(key),
  value       bigint CHECK (value IS NULL OR value >= 0),    -- NULL = unlimited
  reason      text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by  uuid REFERENCES employees(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, limit_key)
);

CREATE TABLE org_module_settings (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  module_key  text NOT NULL REFERENCES product_modules(key),
  enabled     boolean NOT NULL,
  updated_by  uuid REFERENCES employees(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, module_key),
  CHECK (module_key <> 'CORE')
);

-- ---------------------------------------------------------------------------------------------
-- Safe defaults for existing organisations (upgrade): CUSTOM plan + modules derived from real use
-- ---------------------------------------------------------------------------------------------
INSERT INTO subscriptions (org_id, plan_id, status, note)
SELECT o.id, (SELECT id FROM plans WHERE code = 'CUSTOM'), 'ACTIVE', 'migration 012: existing customer, modules derived from use'
FROM organizations o;

WITH usage AS (
  SELECT o.id AS org_id,
    (EXISTS (SELECT 1 FROM tickets t WHERE t.org_id = o.id)
      OR EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'TITO')
      OR EXISTS (SELECT 1 FROM casino_modules cm WHERE cm.org_id = o.id AND cm.module_key = 'tickets' AND cm.enabled)) AS tito,
    (EXISTS (SELECT 1 FROM handpays h WHERE h.org_id = o.id)
      OR EXISTS (SELECT 1 FROM cash_transactions ct WHERE ct.org_id = o.id AND ct.type = 'HANDPAY')
      OR EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'HANDPAY')) AS handpay,
    (EXISTS (SELECT 1 FROM cashier_sessions s WHERE s.org_id = o.id)
      OR EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'CASH')
      OR EXISTS (SELECT 1 FROM casino_modules cm WHERE cm.org_id = o.id AND cm.module_key IN ('cash', 'cashier') AND cm.enabled)) AS cash,
    (EXISTS (SELECT 1 FROM vault_sessions v WHERE v.org_id = o.id)
      OR EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'VAULT')) AS vault,
    (EXISTS (SELECT 1 FROM cash_collections cc WHERE cc.org_id = o.id)
      OR EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'MACHINE')) AS machine,
    (EXISTS (SELECT 1 FROM wallet_transfers w WHERE w.org_id = o.id)
      OR EXISTS (SELECT 1 FROM money_transactions mt WHERE mt.org_id = o.id AND mt.wallet_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM casino_modules cm WHERE cm.org_id = o.id AND cm.module_key = 'cashless' AND cm.enabled)) AS cashless,
    EXISTS (SELECT 1 FROM casino_modules cm WHERE cm.org_id = o.id AND cm.module_key = 'reporting' AND cm.enabled) AS reporting,
    EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = o.id AND c.rail = 'MACHINE') AS advanced
  FROM organizations o
), derived AS (
  -- dependencies are closed here: CASH and MACHINE need VAULT, CASHLESS needs MACHINE
  SELECT org_id, 'TITO' AS m, 'migration 012: tickets / TITO in use' AS why FROM usage WHERE tito
  UNION ALL SELECT org_id, 'HANDPAY', 'migration 012: handpays in use' FROM usage WHERE handpay
  UNION ALL SELECT org_id, 'CASH', 'migration 012: cashier shifts in use' FROM usage WHERE cash
  UNION ALL SELECT org_id, 'VAULT', 'migration 012: vault in use or required by Cash / Machine Money / Cashless' FROM usage WHERE vault OR cash OR machine OR cashless
  UNION ALL SELECT org_id, 'MACHINE', 'migration 012: machine collections in use or required by Cashless' FROM usage WHERE machine OR cashless
  UNION ALL SELECT org_id, 'CASHLESS', 'migration 012: wallet money in use' FROM usage WHERE cashless
  UNION ALL SELECT org_id, 'REPORTING', 'migration 012: reporting module was enabled' FROM usage WHERE reporting
  UNION ALL SELECT org_id, 'ADVANCED_RECONCILIATION', 'migration 012: machine money reconciliation in use' FROM usage WHERE advanced
)
INSERT INTO entitlement_overrides (org_id, module_key, entitled, reason)
SELECT org_id, m, true, why FROM derived;
