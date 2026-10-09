import {
  Smartphone, Landmark,
  Activity, AlertTriangle, BarChart3, Building2, Coins, Cpu, CreditCard, Gift, LayoutDashboard, Map, Monitor,
  Router, ScrollText, Settings, Sparkles, Star, Ticket, Trophy, Users, UserCog,
} from 'lucide-react';
import type { Permission } from '@m1/shared';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  module?: string;
  permission?: Permission;
  /** Visible when the user has at least one of these. */
  anyPermission?: Permission[];
  phase?: number;
}

export const NAV: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
      { href: '/casinos', label: 'Casinos', icon: Building2, permission: 'casino.view' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/floor', label: 'Floor Control', icon: Map, module: 'floor', permission: 'floor.view' },
      { href: '/machines', label: 'Machines', icon: Monitor, module: 'machines', permission: 'machine.view' },
      { href: '/alerts', label: 'Alerts', icon: AlertTriangle, permission: 'alert.view' },
      { href: '/simulation', label: 'Simulation', icon: Activity, permission: 'dashboard.view' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { href: '/accounting', label: 'Accounting', icon: Coins, module: 'accounting', permission: 'accounting.view' },
      { href: '/cashier', label: 'Cashier', icon: CreditCard, module: 'cashier', anyPermission: ['cash.transact', 'cashier.supervise'] },
      { href: '/mobile', label: 'Mobile Cashier', icon: Smartphone, module: 'cashier', permission: 'cash.transact' },
      { href: '/tickets', label: 'Tickets', icon: Ticket, module: 'tickets', permission: 'ticket.view' },
      { href: '/cash', label: 'Cash Management', icon: Landmark, module: 'cash', permission: 'cashier.supervise' },
      { href: '/reports', label: 'Reports', icon: BarChart3, module: 'reporting', permission: 'report.view' },
    ],
  },
  {
    title: 'Players',
    items: [
      { href: '/players', label: 'Players', icon: Users, permission: 'player.view' },
      { href: '/loyalty', label: 'Loyalty', icon: Star, module: 'loyalty', phase: 3 },
      { href: '/promotions', label: 'Promotions', icon: Gift, module: 'promotions', phase: 3 },
      { href: '/jackpots', label: 'Jackpots', icon: Trophy, module: 'jackpots', permission: 'jackpot.view' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/employees', label: 'Employees', icon: UserCog, permission: 'employee.view' },
      { href: '/gateways', label: 'Gateways', icon: Router, permission: 'gateway.view' },
      { href: '/audit', label: 'Audit Log', icon: ScrollText, permission: 'audit.view' },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const PLANNED: Record<string, { title: string; phase: number; icon: React.ComponentType<{ className?: string }>; features: string[] }> = {
  loyalty: { title: 'Loyalty', phase: 3, icon: Star, features: ['Tiers BRONZE to VIP', 'Configurable earning rules (coin in, play time, multipliers)', 'Rewards and point redemption'] },
  promotions: { title: 'Promotions', phase: 3, icon: Sparkles, features: ['Rule engine: IF tier = GOLD AND coin in > 500 THEN award points', 'Free play, bonus, cashback, tournaments', 'Time based promotions'] },
};

export { Cpu };
