import { CUTOVER_PREREQUISITES } from './money/cutover';
/**
 * Commercial entitlements: which product modules an organisation (the SaaS customer) has bought.
 *
 * This is the single definition of modules, their dependencies, the features the API and UI check, the
 * commercial limits and the subscription lifecycle. It is deliberately separate from:
 *   - roles / permissions (what an employee may do, rbac.ts),
 *   - money rails (LEGACY / LEDGER, frozen: the operational state of the money infrastructure),
 * so "not purchased", "disabled", "dependency missing", "subscription inactive" and "frozen" never mix.
 */

export const PRODUCT_MODULES = ['CORE', 'TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE', 'REPORTING', 'ADVANCED_RECONCILIATION'] as const;
export type ProductModule = (typeof PRODUCT_MODULES)[number];

/** Money rails whose operational state belongs to a module (rail state shown next to the commercial state). */
export type ModuleRail = 'CASH' | 'VAULT' | 'HANDPAY' | 'TITO' | 'CASHLESS' | 'MACHINE';

export interface ProductModuleDefinition {
  key: ProductModule;
  name: string;
  description: string;
  /** Mandatory modules: this module cannot be enabled while one of them is not enabled. */
  requires: readonly ProductModule[];
  /** Why the dependency exists (shown in the admin UI). */
  requiresWhy?: string;
  rails: readonly ModuleRail[];
  /** CORE is always part of every subscription and cannot be switched off. */
  required?: boolean;
  capabilities: readonly string[];
}

/**
 * Dependencies verified against the Step 7a to 7e implementation:
 *  - CASH needs VAULT: on the ledger a shift opens empty and gets its float as a vault fill; drops and the final
 *    close drop go into the vault (cash-ops.ts).
 *  - MACHINE needs VAULT: a machine collection is settled as MACHINE_DROP into the vault and hopper fills come
 *    from the open vault (machine-ops.ts: readyVaultSession).
 *  - CASHLESS needs MACHINE: a wallet -> machine transfer is confirmed by the machine and booked to the machine's
 *    MACHINE_CREDIT account, so the machine must be on the MACHINE ledger (machine-money.ts, cashless.ts).
 *  - TITO and HANDPAY stand alone; their cage actions additionally need CASH (paid from a drawer) or CASHLESS
 *    (paid to a wallet): those are feature requirements, not module dependencies.
 */
export const PRODUCT_MODULE_DEFS: Record<ProductModule, ProductModuleDefinition> = {
  CORE: {
    key: 'CORE', name: 'Core', description: 'Dashboard, machines, floor, players, users, roles, settings, alerts and audit',
    requires: [], rails: [], required: true,
    capabilities: ['Dashboard', 'Machine registry and live status', 'Floor control', 'Players and cards', 'Users and roles', 'Alerts', 'Audit log', 'Gaming statistics'],
  },
  TITO: {
    key: 'TITO', name: 'TITO', description: 'Ticket in / ticket out: issue, hold, validation, redemption, expiry, reconciliation',
    requires: ['CORE'], rails: ['TITO'],
    capabilities: ['Machine ticket in / out', 'Ticket hold and validation', 'Ticket lookup, cancel, void', 'TITO liability and reconciliation', 'Cage redemption (with Cash)'],
  },
  HANDPAY: {
    key: 'HANDPAY', name: 'Handpay', description: 'Jackpots to handpays: approval, payment, machine reset, reconciliation',
    requires: ['CORE'], rails: ['HANDPAY'],
    capabilities: ['Jackpot to handpay', 'Handpay approval (four eyes)', 'Machine reset', 'Payment (with Cash or Cashless)', 'Handpay reconciliation'],
  },
  CASH: {
    key: 'CASH', name: 'Cash', description: 'Cashier shifts, drawers, blind close count, short / over, cash reconciliation',
    requires: ['CORE', 'VAULT'], requiresWhy: 'Cash requires Vault: drawer floats, drops and the final drop of a shift go through the vault.',
    rails: ['CASH'],
    capabilities: ['Cashier workstation', 'Drawers and shifts', 'Blind close count', 'Short / over with approval', 'Cash reconciliation'],
  },
  VAULT: {
    key: 'VAULT', name: 'Vault', description: 'Vault sessions, blind counts, fills and drops, vault reconciliation',
    requires: ['CORE'], rails: ['VAULT'],
    capabilities: ['Vault sessions', 'Blind counts with second count', 'Fills and drops', 'Vault reconciliation'],
  },
  CASHLESS: {
    key: 'CASHLESS', name: 'Cashless', description: 'Player wallets, deposits, withdrawals, wallet to machine transfers',
    requires: ['CORE', 'MACHINE'], requiresWhy: 'Cashless requires Machine Money: wallet transfers are confirmed by the machine and booked to its machine credit.',
    rails: ['CASHLESS'],
    capabilities: ['Player wallet', 'Deposit / withdrawal (with Cash)', 'Wallet to machine transfers', 'Cashless reconciliation'],
  },
  MACHINE: {
    key: 'MACHINE', name: 'Machine Money', description: 'Machine cash in / out, hopper, collections, machine credit, meter reconciliation',
    requires: ['CORE', 'VAULT'], requiresWhy: 'Machine Money requires Vault: collections are dropped into the vault and hopper fills come from it.',
    rails: ['MACHINE'],
    capabilities: ['Machine cash in / out', 'Hopper fills', 'Collections with blind counts', 'Machine credit', 'Machine reconciliation'],
  },
  REPORTING: {
    key: 'REPORTING', name: 'Reporting', description: 'Reports and CSV / Excel / PDF exports for the enabled modules',
    requires: ['CORE'], rails: [],
    capabilities: ['Gaming reports', 'Financial reports of enabled modules', 'Exports'],
  },
  ADVANCED_RECONCILIATION: {
    key: 'ADVANCED_RECONCILIATION', name: 'Advanced Reconciliation', description: 'Ledger to meter analysis and audit chain verification',
    requires: ['CORE'], rails: [],
    capabilities: ['Ledger to meters per machine and period', 'Audit chain verification'],
  },
};

/**
 * Features checked by the API (every route declares one) and the web app. A feature is available when all its
 * modules are effective; `anyOf` additionally needs at least one of those modules.
 */
export const FEATURES = {
  public: { modules: [] },
  core: { modules: ['CORE'] },
  'money.admin': { modules: ['CORE'] }, // rail cutover / counts: infrastructure, independent of purchases
  tito: { modules: ['TITO'] },
  'tito.machine': { modules: ['TITO'] },
  'tito.cashier': { modules: ['TITO', 'CASH'] },
  handpay: { modules: ['HANDPAY'] },
  // payout medium: a drawer, the player's wallet or a TITO voucher (F3)
  'handpay.pay': { modules: ['HANDPAY'], anyOf: ['CASH', 'CASHLESS', 'TITO'] },
  cash: { modules: ['CASH'] },
  vault: { modules: ['VAULT'] },
  cashless: { modules: ['CASHLESS'] },
  'cashless.cashier': { modules: ['CASHLESS', 'CASH'] },
  'cashless.machine': { modules: ['CASHLESS'] },
  machine: { modules: ['MACHINE'] },
  reporting: { modules: ['REPORTING'] },
  /** Basic reconciliation, approvals, freezes and day close: part of every money module. */
  reconciliation: { modules: [], anyOf: ['TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE'] },
  'reconciliation.advanced': { modules: ['ADVANCED_RECONCILIATION'] },
  'reconciliation.meters': { modules: ['ADVANCED_RECONCILIATION', 'MACHINE'] },
} as const satisfies Record<string, { modules: readonly ProductModule[]; anyOf?: readonly ProductModule[] }>;
export type Feature = keyof typeof FEATURES;

export function featureAvailable(feature: Feature, effective: ReadonlySet<ProductModule> | readonly ProductModule[]): boolean {
  const has = (m: ProductModule) => (effective instanceof Set ? effective.has(m) : (effective as readonly ProductModule[]).includes(m));
  const f = FEATURES[feature] as { modules: readonly ProductModule[]; anyOf?: readonly ProductModule[] };
  return f.modules.every(has) && (!f.anyOf || f.anyOf.some(has));
}

/** Modules whose money rail is checked by reconciliation (a rail of a module the customer does not use is advisory). */
export const RAIL_MODULE: Record<ModuleRail, ProductModule> = {
  CASH: 'CASH', VAULT: 'VAULT', HANDPAY: 'HANDPAY', TITO: 'TITO', CASHLESS: 'CASHLESS', MACHINE: 'MACHINE',
};

/**
 * Ledger readiness of a module set (F3): the unconditional cutover order (CUTOVER_PREREQUISITES: CASH needs
 * VAULT, MACHINE needs VAULT and CASHLESS), applied transitively. Workflow prerequisites
 * (CUTOVER_WORKFLOW_PREREQUISITES) apply only to rails in use, so a module set never lacks them. A purchased
 * rail whose needs are not purchased cannot operate on the ledger: its money stays in legacy mode. Reported
 * (plans, onboarding, module cards), never silently granted. The CASHLESS rail is cut over for every
 * organisation at onboarding (it holds no money until wallets exist), so it never counts as missing.
 */
const LEDGER_NEEDS: Record<ModuleRail, readonly ModuleRail[]> = CUTOVER_PREREQUISITES;
const RAIL_ORDER: readonly ModuleRail[] = ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE'];
export function ledgerGaps(modules: Iterable<ProductModule>): Array<{ rail: ModuleRail; needs: ModuleRail[] }> {
  const has = new Set(modules);
  const needsOf = (rail: ModuleRail) => {
    const seen = new Set<ModuleRail>();
    const visit = (r: ModuleRail) => LEDGER_NEEDS[r].forEach((x) => { if (!seen.has(x) && x !== rail) { seen.add(x); visit(x); } });
    visit(rail);
    return RAIL_ORDER.filter((r) => seen.has(r) && r !== 'CASHLESS' && !has.has(RAIL_MODULE[r]));
  };
  return RAIL_ORDER.filter((rail) => has.has(RAIL_MODULE[rail])).map((rail) => ({ rail, needs: needsOf(rail) })).filter((g) => g.needs.length > 0);
}

// ---- limits ----------------------------------------------------------------------------------------

/** HARD limits are enforced when something is created; SOFT limits are measured and reported (never stop money). */
export const LIMIT_DEFS = {
  MAX_CASINOS: { label: 'Casinos / sites', kind: 'HARD', unit: 'count' },
  MAX_MACHINES: { label: 'Machines', kind: 'HARD', unit: 'count' },
  MAX_USERS: { label: 'Users (active)', kind: 'HARD', unit: 'count' },
  MAX_PLAYERS: { label: 'Players', kind: 'HARD', unit: 'count' },
  MAX_WALLETS: { label: 'Cashless wallets', kind: 'SOFT', unit: 'count', module: 'CASHLESS' },
  MAX_CASHLESS_PLAYERS: { label: 'Cashless players (active this month)', kind: 'SOFT', unit: 'count', module: 'CASHLESS' },
  MAX_MONTHLY_TITO_VOLUME: { label: 'TITO tickets this month', kind: 'SOFT', unit: 'count', module: 'TITO' },
  MAX_MONTHLY_HANDPAYS: { label: 'Handpays this month', kind: 'SOFT', unit: 'count', module: 'HANDPAY' },
} as const satisfies Record<string, { label: string; kind: 'HARD' | 'SOFT'; unit: string; module?: ProductModule }>;
export type LimitKey = keyof typeof LIMIT_DEFS;
export const LIMIT_KEYS = Object.keys(LIMIT_DEFS) as LimitKey[];

// ---- subscription lifecycle ------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * TRIAL / ACTIVE (before ends_at): full use of the purchased modules.
 * SUSPENDED / EXPIRED / CANCELLED (or past ends_at): commercial access ends but no data is removed: the purchased
 * modules stay readable (history, reports of what happened), every action that starts new business is refused,
 * physical machine events are still recorded so no money fact is lost.
 */
export function subscriptionUsable(status: SubscriptionStatus | null | undefined, endsAt: string | Date | null | undefined, now = new Date()): boolean {
  if (status !== 'TRIAL' && status !== 'ACTIVE') return false;
  return !endsAt || new Date(endsAt) > now;
}

/** Module states as the admin UI shows them (commercial, never operational). */
export type ModuleState = 'ENABLED' | 'DISABLED' | 'NOT_PURCHASED' | 'DEPENDENCY_MISSING' | 'SUBSCRIPTION_INACTIVE';

export interface ModuleStatus {
  module: ProductModule;
  purchased: boolean;
  /** Where the purchase comes from. */
  source: 'REQUIRED' | 'PLAN' | 'OVERRIDE' | 'NONE';
  /** Switched on by the customer (only meaningful when purchased). */
  enabled: boolean;
  missing: ProductModule[];
  effective: boolean;
  state: ModuleState;
}

/**
 * Pure evaluation (shared by API and UI tests): purchased = plan or platform override (CORE always), enabled =
 * customer switch (default on), effective = purchased + enabled + all dependencies effective + usable subscription.
 */
export function evaluateModules(input: {
  planModules: readonly string[];
  overrides: Readonly<Record<string, boolean>>;
  disabled: readonly string[];
  subscriptionUsable: boolean;
}): ModuleStatus[] {
  const purchased = (m: ProductModule) => m === 'CORE' || (input.overrides[m] ?? input.planModules.includes(m));
  const enabled = (m: ProductModule) => m === 'CORE' || (purchased(m) && !input.disabled.includes(m));
  const memo = new Map<ProductModule, boolean>();
  const effectiveRaw = (m: ProductModule, seen: Set<ProductModule> = new Set()): boolean => {
    if (memo.has(m)) return memo.get(m)!;
    if (seen.has(m)) return false;
    seen.add(m);
    const v = enabled(m) && PRODUCT_MODULE_DEFS[m].requires.every((d) => effectiveRaw(d, seen));
    memo.set(m, v);
    return v;
  };
  return PRODUCT_MODULES.map((m) => {
    const p = purchased(m);
    const e = enabled(m);
    const missing = PRODUCT_MODULE_DEFS[m].requires.filter((d) => !effectiveRaw(d));
    const ok = effectiveRaw(m) && (m === 'CORE' || input.subscriptionUsable);
    const source = m === 'CORE' ? 'REQUIRED' : input.overrides[m] !== undefined ? (input.overrides[m] ? 'OVERRIDE' : 'NONE') : p ? 'PLAN' : 'NONE';
    const state: ModuleState = !p ? 'NOT_PURCHASED' : !e ? 'DISABLED' : missing.length ? 'DEPENDENCY_MISSING' : !ok ? 'SUBSCRIPTION_INACTIVE' : 'ENABLED';
    return { module: m, purchased: p, source, enabled: e, missing, effective: ok, state };
  });
}

/** Modules that depend (directly or not) on `m`. */
export function dependentsOf(m: ProductModule): ProductModule[] {
  return PRODUCT_MODULES.filter((x) => x !== m && closure([x]).includes(m));
}

/** A module set plus everything it requires. */
export function closure(modules: readonly ProductModule[]): ProductModule[] {
  const out = new Set<ProductModule>(['CORE']);
  const add = (m: ProductModule) => {
    if (out.has(m) && m !== 'CORE') return;
    out.add(m);
    PRODUCT_MODULE_DEFS[m].requires.forEach(add);
  };
  modules.forEach(add);
  return PRODUCT_MODULES.filter((m) => out.has(m));
}

/** Machine-readable error codes of the entitlement layer (safe user-facing messages). */
export const ENTITLEMENT_ERRORS = {
  MODULE_NOT_ENTITLED: 'This feature is not included in your current plan.',
  MODULE_DISABLED: 'This module is switched off for your organisation.',
  SUBSCRIPTION_INACTIVE: 'Your subscription is not active: existing data stays readable, new actions are not possible.',
  ORGANIZATION_DISABLED: 'This organisation is disabled.',
  LIMIT_REACHED: 'The limit of your plan is reached.',
  MODULE_ENABLE_BLOCKED: 'The module cannot be enabled yet.',
  MODULE_DISABLE_BLOCKED: 'The module cannot be disabled while other enabled modules depend on it.',
} as const;
