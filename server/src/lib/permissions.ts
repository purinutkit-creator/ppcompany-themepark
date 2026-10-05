export const PERMISSIONS = [
  ['dashboard.view', 'View dashboard', 'Dashboard', false],
  ['orders.view', 'View orders', 'Orders', false],
  ['orders.manage', 'Update order status / pickup', 'Orders', false],
  ['orders.cancel', 'Cancel unpaid orders', 'Orders', false],
  ['orders.cancel_paid', 'Cancel paid orders', 'Orders', true],
  ['orders.void', 'Void orders', 'Orders', true],
  ['orders.discount', 'Apply manual discount', 'Orders', true],
  ['orders.reprint', 'Reprint receipts / tickets', 'Orders', true],
  ['payments.verify', 'Payment / slip verification', 'Payments', false],
  ['payments.cash', 'Accept cash payment', 'Payments', false],
  ['payments.manual_approve', 'Manual payment approval', 'Payments', true],
  ['payments.refund', 'Refund', 'Payments', true],
  ['payments.view', 'View payments', 'Payments', false],
  ['products.manage', 'Manage products', 'Menu', false],
  ['categories.manage', 'Manage categories', 'Menu', false],
  ['modifiers.manage', 'Manage modifiers', 'Menu', false],
  ['promotions.manage', 'Manage promotions', 'Menu', false],
  ['stock.view', 'View stock', 'Stock', false],
  ['stock.manage', 'Adjust stock', 'Stock', false],
  ['kitchen.view', 'View kitchen display', 'Kitchen', false],
  ['kitchen.manage', 'Update kitchen orders', 'Kitchen', false],
  ['kitchen.stations', 'Manage kitchen stations', 'Kitchen', false],
  ['queue.manage', 'Manage queue / call numbers', 'Queue', false],
  ['printers.manage', 'Manage printers & print queue', 'Printers', false],
  ['kiosks.manage', 'Manage kiosks', 'Devices', false],
  ['branches.manage', 'Manage branches', 'Devices', false],
  ['reports.view', 'View reports', 'Reports', false],
  ['reports.export', 'Export reports', 'Reports', false],
  ['staff.manage', 'Manage staff', 'Staff', false],
  ['roles.manage', 'Manage roles & permissions', 'Staff', true],
  ['settings.manage', 'System settings', 'Settings', true],
  ['theme.manage', 'Theme settings', 'Settings', false],
  ['fonts.manage', 'Font management', 'Settings', false],
  ['languages.manage', 'Language management', 'Settings', false],
  ['audit.view', 'View audit logs', 'Settings', false],
] as const;

export type Permission = (typeof PERMISSIONS)[number][0];
const ALL = PERMISSIONS.map((p) => p[0]) as Permission[];

export const DEFAULT_ROLES: { code: string; name: string; level: number; permissions: Permission[] }[] = [
  { code: 'OWNER', name: 'Owner', level: 100, permissions: ALL },
  { code: 'ADMIN', name: 'Admin', level: 90, permissions: ALL },
  {
    code: 'MANAGER',
    name: 'Manager',
    level: 70,
    permissions: ALL.filter((p) => !['roles.manage', 'settings.manage', 'branches.manage'].includes(p)),
  },
  {
    code: 'CASHIER',
    name: 'Cashier',
    level: 40,
    permissions: [
      'dashboard.view', 'orders.view', 'orders.manage', 'orders.cancel', 'payments.verify', 'payments.cash',
      'payments.view', 'stock.view', 'queue.manage', 'kitchen.view',
    ],
  },
  { code: 'KITCHEN', name: 'Kitchen', level: 30, permissions: ['kitchen.view', 'kitchen.manage', 'orders.view', 'stock.view'] },
  { code: 'STAFF', name: 'Staff', level: 10, permissions: ['orders.view', 'kitchen.view', 'queue.manage'] },
];

/** Actions that may require a manager PIN (configured in settings.security.managerPinActions). */
export const MANAGER_PIN_ACTIONS = ['REFUND', 'VOID', 'MANUAL_PAYMENT_APPROVAL', 'REPRINT', 'CANCEL_PAID_ORDER', 'DISCOUNT'] as const;
export type ManagerPinAction = (typeof MANAGER_PIN_ACTIONS)[number];
export const MANAGER_LEVEL = 70;
