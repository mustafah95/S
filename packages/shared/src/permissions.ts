import type { RoleKey } from './enums.js';

/**
 * Fine-grained permissions (module.action). The server enforces these on every route; the UI uses the same
 * list to hide actions the user cannot perform. Default role grants are seeded into the database and can be
 * customised by a Super Admin afterwards.
 */
export const PERMISSIONS = [
  'branches.read',
  'branches.manage',
  'users.read',
  'users.manage',
  'tables.read',
  'tables.manage',
  'tables.status',
  'reservations.read',
  'reservations.create',
  'reservations.update',
  'reservations.cancel',
  'reservations.override',
  'checkin.manage',
  'waitlist.read',
  'waitlist.manage',
  'guests.read',
  'guests.create',
  'guests.update',
  'guests.vip',
  'guests.merge',
  'guests.delete',
  'guests.export',
  'loyalty.read',
  'loyalty.redeem',
  'loyalty.adjust',
  'loyalty.configure',
  'marketing.read',
  'marketing.manage',
  'marketing.send',
  'feedback.read',
  'complaints.read',
  'complaints.manage',
  'pos.read',
  'pos.manage',
  'analytics.host',
  'analytics.owner',
  'reports.read',
  'reports.export',
  'notifications.manage',
  'settings.read',
  'settings.manage',
  'integrations.manage',
  'audit.read',
  'sync.review',
  'system.health',
  'system.logs',
  'system.backup',
  'system.restore',
  'system.update',
  'data.export',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];
const READS: Permission[] = [
  'branches.read',
  'tables.read',
  'reservations.read',
  'waitlist.read',
  'guests.read',
  'loyalty.read',
  'feedback.read',
  'complaints.read',
  'analytics.host',
  'reports.read',
];

const FRONT_OF_HOUSE: Permission[] = [
  'branches.read',
  'tables.read',
  'tables.status',
  'reservations.read',
  'reservations.create',
  'reservations.update',
  'reservations.cancel',
  'checkin.manage',
  'waitlist.read',
  'waitlist.manage',
  'guests.read',
  'guests.create',
  'guests.update',
  'loyalty.read',
  'feedback.read',
  'complaints.read',
  'analytics.host',
];

const MANAGER: Permission[] = ALL.filter(
  (p) =>
    !['system.restore', 'system.update', 'data.export', 'branches.manage', 'integrations.manage'].includes(p),
);

export interface RoleDefinition {
  key: RoleKey;
  name: { en: string; ar: string };
  /** When true the role sees every branch; otherwise only branches assigned to the user. */
  allBranches: boolean;
  permissions: Permission[];
}

export const DEFAULT_ROLES: RoleDefinition[] = [
  { key: 'super_admin', name: { en: 'Super Admin', ar: 'مدير النظام الأعلى' }, allBranches: true, permissions: ALL },
  { key: 'owner', name: { en: 'Owner', ar: 'المالك' }, allBranches: true, permissions: ALL },
  {
    key: 'head_office',
    name: { en: 'Head Office', ar: 'الإدارة العامة' },
    allBranches: true,
    permissions: ALL.filter((p) => !['system.restore', 'system.update', 'system.backup'].includes(p)),
  },
  {
    key: 'general_manager',
    name: { en: 'General Manager', ar: 'المدير العام' },
    allBranches: false,
    permissions: MANAGER,
  },
  {
    key: 'branch_manager',
    name: { en: 'Branch Manager', ar: 'مدير الفرع' },
    allBranches: false,
    permissions: MANAGER.filter((p) => !['system.backup', 'system.logs', 'marketing.send'].includes(p)),
  },
  {
    key: 'reservation_manager',
    name: { en: 'Reservation Manager', ar: 'مدير الحجوزات' },
    allBranches: false,
    permissions: [...FRONT_OF_HOUSE, 'reservations.override', 'guests.vip', 'reports.read', 'sync.review'],
  },
  { key: 'host', name: { en: 'Host', ar: 'المضيف' }, allBranches: false, permissions: FRONT_OF_HOUSE },
  { key: 'reception', name: { en: 'Reception', ar: 'الاستقبال' }, allBranches: false, permissions: FRONT_OF_HOUSE },
  {
    key: 'waiter',
    name: { en: 'Waiter', ar: 'النادل' },
    allBranches: false,
    permissions: [
      'branches.read',
      'tables.read',
      'tables.status',
      'reservations.read',
      'checkin.manage',
      'waitlist.read',
      'guests.read',
      'analytics.host',
    ],
  },
  {
    key: 'cashier',
    name: { en: 'Cashier', ar: 'أمين الصندوق' },
    allBranches: false,
    permissions: [
      'branches.read',
      'tables.read',
      'reservations.read',
      'guests.read',
      'loyalty.read',
      'loyalty.redeem',
      'pos.read',
      'analytics.host',
    ],
  },
  {
    key: 'marketing',
    name: { en: 'Marketing', ar: 'التسويق' },
    allBranches: true,
    permissions: [
      'branches.read',
      'reservations.read',
      'guests.read',
      'loyalty.read',
      'marketing.read',
      'marketing.manage',
      'marketing.send',
      'feedback.read',
      'complaints.read',
      'analytics.owner',
      'reports.read',
      'reports.export',
    ],
  },
  {
    key: 'crm_manager',
    name: { en: 'CRM Manager', ar: 'مدير علاقات العملاء' },
    allBranches: true,
    permissions: [
      ...READS,
      'guests.create',
      'guests.update',
      'guests.vip',
      'guests.merge',
      'guests.delete',
      'guests.export',
      'loyalty.redeem',
      'loyalty.adjust',
      'loyalty.configure',
      'marketing.read',
      'complaints.manage',
      'analytics.owner',
      'reports.export',
    ],
  },
  {
    key: 'auditor',
    name: { en: 'Auditor', ar: 'المدقق' },
    allBranches: true,
    permissions: [
      ...READS,
      'users.read',
      'marketing.read',
      'pos.read',
      'analytics.owner',
      'reports.export',
      'settings.read',
      'audit.read',
      'system.health',
      'system.logs',
    ],
  },
  { key: 'read_only', name: { en: 'Read Only', ar: 'قراءة فقط' }, allBranches: false, permissions: READS },
];

export function roleDefinition(key: string): RoleDefinition | undefined {
  return DEFAULT_ROLES.find((r) => r.key === key);
}

export function hasPermission(granted: readonly string[] | Set<string>, permission: Permission): boolean {
  return granted instanceof Set ? granted.has(permission) : granted.includes(permission);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
