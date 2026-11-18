/**
 * Domain enumerations shared by the API, the PWA and the database (CHECK constraints mirror these lists).
 */

export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'seated',
  'dining',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuses in which a reservation still holds its table(s). */
export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'seated',
  'dining',
];

export const RESERVATION_SOURCES = [
  'phone',
  'walk_in',
  'online',
  'widget',
  'whatsapp',
  'instagram',
  'facebook',
  'staff',
  'event',
  'other',
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const PAYMENT_STATUSES = ['not_required', 'pending', 'paid', 'refunded', 'waived', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const OCCASION_TYPES = [
  'birthday',
  'anniversary',
  'engagement',
  'wedding',
  'business_dinner',
  'proposal',
  'graduation',
  'family_event',
  'other',
] as const;
export type OccasionType = (typeof OCCASION_TYPES)[number];

export const TABLE_STATUSES = ['available', 'reserved', 'occupied', 'cleaning', 'blocked', 'maintenance'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];
/** Statuses a person sets manually; reserved/occupied are derived from reservations. */
export const MANUAL_TABLE_STATUSES = ['available', 'cleaning', 'blocked', 'maintenance'] as const;
export type ManualTableStatus = (typeof MANUAL_TABLE_STATUSES)[number];

export const TABLE_SHAPES = ['round', 'square', 'rectangle', 'booth', 'bar_stool', 'sofa'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

export const AREA_KINDS = ['indoor', 'outdoor', 'vip', 'terrace', 'private_room', 'lounge', 'bar'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export const VIP_LEVELS = ['standard', 'silver', 'gold', 'platinum', 'vip', 'vvip'] as const;
export type VipLevel = (typeof VIP_LEVELS)[number];
export const VIP_RANK: Record<VipLevel, number> = { standard: 0, silver: 1, gold: 2, platinum: 3, vip: 4, vvip: 5 };

export const WAITLIST_STATUSES = ['waiting', 'notified', 'seated', 'cancelled', 'expired'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const CURRENCIES = ['IQD', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export const LOYALTY_TXN_TYPES = ['earn', 'redeem', 'adjust', 'expire', 'bonus'] as const;
export type LoyaltyTxnType = (typeof LOYALTY_TXN_TYPES)[number];

export const LOYALTY_RULE_TYPES = [
  'points_per_currency',
  'visit',
  'birthday',
  'spend_threshold',
  'referral',
] as const;
export type LoyaltyRuleType = (typeof LOYALTY_RULE_TYPES)[number];

export const REWARD_TYPES = ['discount_percent', 'discount_amount', 'free_item', 'voucher'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export const COMPLAINT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];
export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_CATEGORIES = [
  'food',
  'service',
  'wait_time',
  'cleanliness',
  'billing',
  'atmosphere',
  'reservation',
  'staff',
  'other',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const TEMPLATE_KEYS = [
  'reservation_confirmation',
  'reservation_reminder',
  'reservation_cancelled',
  'reservation_rescheduled',
  'waitlist_ready',
  'birthday',
  'feedback_request',
  'marketing',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const SYNC_OP_STATUSES = ['pending', 'syncing', 'synced', 'failed', 'conflict', 'requires_review'] as const;
export type SyncOpStatus = (typeof SYNC_OP_STATUSES)[number];

export const CONFLICT_KINDS = [
  'version_conflict',
  'reservation_overlap',
  'invalid_transition',
  'validation',
  'duplicate_guest',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const CONFLICT_STATUSES = ['open', 'resolved_server', 'resolved_client', 'resolved_custom', 'dismissed'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export const BACKUP_KINDS = ['scheduled', 'manual', 'pre_update', 'pre_restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const UPDATE_STATUSES = [
  'pending',
  'downloading',
  'downloaded',
  'verifying',
  'backing_up',
  'migrating',
  'installing',
  'restarting',
  'health_check',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export const ROLE_KEYS = [
  'super_admin',
  'owner',
  'head_office',
  'general_manager',
  'branch_manager',
  'reservation_manager',
  'host',
  'reception',
  'waiter',
  'cashier',
  'marketing',
  'crm_manager',
  'auditor',
  'read_only',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
