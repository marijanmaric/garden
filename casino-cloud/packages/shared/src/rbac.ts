export const ROLES = [
  'SUPER_ADMIN',
  'CASINO_ADMIN',
  'MANAGER',
  'FLOOR_SUPERVISOR',
  'CASHIER',
  'ATTENDANT',
  'TECHNICIAN',
  'ACCOUNTING',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  'casino.view',
  'casino.manage',
  'machine.view',
  'machine.configure',
  'machine.command',
  'floor.view',
  'floor.edit',
  'accounting.view',
  'alert.view',
  'alert.manage',
  'audit.view',
  'gateway.view',
  'gateway.manage',
  'simulation.control',
  'settings.manage',
  'player.view',
  'ticket.payout',
  'cash.transact',
  'jackpot.view',
  'jackpot.configure',
  'employee.view',
  'user.manage',
  'report.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ALL,
  CASINO_ADMIN: ALL,
  MANAGER: ALL.filter((p) => p !== 'user.manage' && p !== 'gateway.manage'),
  FLOOR_SUPERVISOR: [
    'dashboard.view', 'casino.view', 'machine.view', 'machine.command', 'floor.view', 'floor.edit',
    'alert.view', 'alert.manage', 'player.view', 'jackpot.view', 'gateway.view',
  ],
  CASHIER: ['dashboard.view', 'casino.view', 'ticket.payout', 'cash.transact', 'player.view', 'alert.view'],
  ATTENDANT: ['dashboard.view', 'casino.view', 'machine.view', 'floor.view', 'alert.view', 'alert.manage', 'player.view'],
  TECHNICIAN: [
    'dashboard.view', 'casino.view', 'machine.view', 'machine.configure', 'machine.command', 'floor.view',
    'alert.view', 'alert.manage', 'gateway.view',
  ],
  ACCOUNTING: ['dashboard.view', 'casino.view', 'accounting.view', 'report.view', 'audit.view', 'machine.view', 'jackpot.view'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
