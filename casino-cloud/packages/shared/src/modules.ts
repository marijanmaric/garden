/** Feature modules a casino can enable or disable independently ("configure instead of code"). */
export interface ModuleDefinition {
  key: string;
  name: string;
  description: string;
  phase: number;
  /** Core modules cannot be disabled. */
  core?: boolean;
}

export const MODULES: ModuleDefinition[] = [
  { key: 'machines', name: 'Machine Management', description: 'Machine registry, meters and live status', phase: 1, core: true },
  { key: 'floor', name: 'Floor Control', description: 'Graphical floor plan with live status', phase: 1 },
  { key: 'accounting', name: 'Accounting', description: 'Immutable ledger, Coin In / Coin Out / GGR', phase: 1 },
  { key: 'tickets', name: 'Ticket System (TITO)', description: 'Ticket in / out, validation, expiration', phase: 2 },
  { key: 'cash', name: 'Cash Management', description: 'Cash desks, drops, collections', phase: 2 },
  { key: 'cashier', name: 'Cashier & Mobile Cashier', description: 'Cashier sessions and tablet cashier', phase: 2 },
  { key: 'reporting', name: 'Reporting', description: 'Reports and CSV / Excel / PDF exports', phase: 2 },
  { key: 'loyalty', name: 'Loyalty', description: 'Points, tiers and configurable earning rules', phase: 3 },
  { key: 'player_app', name: 'Player App', description: 'Player web app / PWA', phase: 3 },
  { key: 'promotions', name: 'Promotions', description: 'Rule based promotions engine', phase: 3 },
  { key: 'cashless', name: 'Cashless (Sandbox)', description: 'Player wallet, simulation only', phase: 3 },
  { key: 'jackpots', name: 'Jackpots', description: 'Local, linked, mystery, time and wide area jackpots', phase: 4 },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);
