import {
  Smartphone, Landmark,
  Activity, AlertTriangle, BarChart3, Building2, Coins, Cpu, CreditCard, Gift, LayoutDashboard, Map, Monitor,
  Package, Router, ScrollText, Settings, Sparkles, Star, Ticket, Trophy, Users, UserCog, Vault, ShieldCheck, Scale, SlidersHorizontal,
} from 'lucide-react';
import type { Feature, Permission } from '@m1/shared';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Commercial feature the page belongs to (the API enforces the same feature on its routes). */
  feature: Feature;
  permission?: Permission;
  /** Visible when the user has at least one of these. */
  anyPermission?: Permission[];
}

export const NAV: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, feature: 'core', permission: 'dashboard.view' },
      { href: '/casinos', label: 'Casinos', icon: Building2, feature: 'core', permission: 'casino.view' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/floor', label: 'Floor Control', icon: Map, feature: 'core', permission: 'floor.view' },
      { href: '/machines', label: 'Machines', icon: Monitor, feature: 'core', permission: 'machine.view' },
      { href: '/alerts', label: 'Alerts', icon: AlertTriangle, feature: 'core', permission: 'alert.view' },
      { href: '/simulation', label: 'Simulation', icon: Activity, feature: 'core', permission: 'dashboard.view' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { href: '/accounting', label: 'Accounting', icon: Coins, feature: 'core', permission: 'accounting.view' },
      { href: '/cashier', label: 'Cashier', icon: CreditCard, feature: 'cash', anyPermission: ['cash.transact', 'cashier.supervise'] },
      { href: '/mobile', label: 'Mobile Cashier', icon: Smartphone, feature: 'cash', permission: 'cash.transact' },
      { href: '/tickets', label: 'Tickets', icon: Ticket, feature: 'tito', permission: 'ticket.view' },
      { href: '/handpays', label: 'Handpays', icon: Trophy, feature: 'handpay.pay', permission: 'cash.transact' },
      { href: '/vault', label: 'Vault', icon: Vault, feature: 'vault', permission: 'cash.manage' },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck, feature: 'reconciliation', permission: 'cashier.supervise' },
      { href: '/reconciliation', label: 'Reconciliation', icon: Scale, feature: 'reconciliation', permission: 'cashier.supervise' },
      { href: '/cash', label: 'Cash Management', icon: Landmark, feature: 'cash', permission: 'cashier.supervise' },
      { href: '/reports', label: 'Reports', icon: BarChart3, feature: 'reporting', permission: 'report.view' },
    ],
  },
  {
    title: 'Players',
    items: [
      { href: '/players', label: 'Players', icon: Users, feature: 'core', permission: 'player.view' },
      { href: '/jackpots', label: 'Jackpots', icon: Trophy, feature: 'core', permission: 'jackpot.view' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/organization', label: 'Organization', icon: Package, feature: 'core', permission: 'org.manage' },
      { href: '/employees', label: 'Employees', icon: UserCog, feature: 'core', permission: 'employee.view' },
      { href: '/money', label: 'Money control', icon: SlidersHorizontal, feature: 'money.admin', anyPermission: ['money.cutover', 'cashier.supervise'] },
      { href: '/gateways', label: 'Gateways', icon: Router, feature: 'core', permission: 'gateway.view' },
      { href: '/audit', label: 'Audit Log', icon: ScrollText, feature: 'core', permission: 'audit.view' },
      { href: '/settings', label: 'Settings', icon: Settings, feature: 'core' },
    ],
  },
];

export const PLANNED: Record<string, { title: string; phase: number; icon: React.ComponentType<{ className?: string }>; features: string[] }> = {
  loyalty: { title: 'Loyalty', phase: 3, icon: Star, features: ['Tiers BRONZE to VIP', 'Configurable earning rules (bets, play time, multipliers)', 'Rewards and point redemption'] },
  promotions: { title: 'Promotions', phase: 3, icon: Sparkles, features: ['Rule engine: IF tier = GOLD AND bets > 500 THEN award points', 'Free play, bonus, cashback, tournaments', 'Time based promotions'] },
};

export { Cpu, Gift };

/** The navigation item a path belongs to (longest prefix), for the page guard. */
export function navItemFor(pathname: string): NavItem | undefined {
  const all = NAV.flatMap((g) => g.items);
  return all.filter((i) => (i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
