import { z } from 'zod';
import {
  AREA_KINDS,
  CHANNELS,
  COMPLAINT_CATEGORIES,
  COMPLAINT_SEVERITIES,
  COMPLAINT_STATUSES,
  CURRENCIES,
  LANGUAGES,
  LOYALTY_RULE_TYPES,
  MANUAL_TABLE_STATUSES,
  OCCASION_TYPES,
  PAYMENT_STATUSES,
  RESERVATION_SOURCES,
  REWARD_TYPES,
  TABLE_SHAPES,
  TEMPLATE_KEYS,
  VIP_LEVELS,
} from './enums.js';
import { isValidTimeZone } from './time.js';

// ---------------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------------

export const zId = z.uuid();
export const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
export const zDateTime = z.iso.datetime({ offset: true });
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const zEmailOrEmpty = z
  .union([z.email().max(200), z.literal('')])
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));
export const zTimeZone = z.string().refine(isValidTimeZone, 'Unknown time zone');
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => !/^(.)\1+$/.test(p), 'Password is too weak')
  .refine(
    (p) => !['password12', 'password123', '1234567890', 'qwertyuiop', 'sofia12345'].includes(p.toLowerCase()),
    'Password is too common',
  );

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

// ---------------------------------------------------------------------------------------------------------
// Auth & users
// ---------------------------------------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
  deviceId: zId.optional(),
});

export const mfaVerifySchema = z.object({
  challenge: z.string().min(10).max(2000),
  code: z.string().trim().min(6).max(20),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only'),
  email: zEmailOrEmpty,
  displayName: z.string().trim().min(1).max(120),
  password: passwordSchema,
  roleKey: z.string().min(2).max(60),
  branchIds: z.array(zId).default([]),
  preferredLanguage: z.enum(LANGUAGES).default('ar'),
  isActive: z.boolean().default(true),
  mfaRequired: z.boolean().default(false),
});

export const userUpdateSchema = userCreateSchema.omit({ password: true, username: true }).partial();

// ---------------------------------------------------------------------------------------------------------
// Branches, areas, tables
// ---------------------------------------------------------------------------------------------------------

export const openingPeriodSchema = z.object({ open: zTime, close: zTime });
export const weeklyHoursSchema = z.array(z.array(openingPeriodSchema).max(4)).length(7);

export const reservationSettingsSchema = z.object({
  slotIntervalMinutes: z.number().int().min(5).max(120),
  defaultDurationMinutes: z.number().int().min(15).max(720),
  durationRules: z
    .array(z.object({ maxPartySize: z.number().int().min(1).max(500), minutes: z.number().int().min(15).max(720) }))
    .max(20),
  bufferMinutes: z.number().int().min(0).max(240),
  maxAdvanceDays: z.number().int().min(1).max(730),
  minNoticeMinutes: z.number().int().min(0).max(10080),
  lastSeatingBeforeCloseMinutes: z.number().int().min(0).max(600),
  maxOnlinePartySize: z.number().int().min(1).max(500),
  onlineBookingEnabled: z.boolean(),
  autoConfirmOnline: z.boolean(),
  requireTableForOnline: z.boolean(),
  deposit: z.object({
    enabled: z.boolean(),
    minPartySize: z.number().int().min(1).max(500),
    amountPerGuest: z.number().min(0),
    currency: z.enum(CURRENCIES),
  }),
  cancellationCutoffHours: z.number().int().min(0).max(720),
  cancellationPolicy: z.object({ en: z.string().max(2000), ar: z.string().max(2000) }),
  noShowGraceMinutes: z.number().int().min(5).max(600),
  lateThresholdMinutes: z.number().int().min(1).max(600),
  reminderHoursBefore: z.number().int().min(0).max(168),
  feedbackDelayMinutes: z.number().int().min(0).max(10080),
  markCleaningAfterComplete: z.boolean(),
  holdVipTablesForVip: z.boolean(),
});

export const branchSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(1).max(120),
  nameAr: optText(120),
  address: optText(500),
  phone: optText(40),
  email: zEmailOrEmpty,
  timezone: zTimeZone.default('Asia/Baghdad'),
  currency: z.enum(CURRENCIES).default('IQD'),
  operatingHours: weeklyHoursSchema,
  reservationSettings: reservationSettingsSchema.optional(),
  capacity: z.number().int().min(0).max(100000).nullable().optional(),
  isActive: z.boolean().default(true),
});
export const branchUpdateSchema = branchSchema.partial();

export const closureSchema = z.object({
  date: zIsoDate,
  reason: optText(200),
  periods: z.array(openingPeriodSchema).max(4).nullable().default(null),
});

export const floorPlanSchema = z.object({
  width: z.number().int().min(200).max(10000).default(1200),
  height: z.number().int().min(200).max(10000).default(800),
  elements: z
    .array(
      z.object({
        id: z.string().max(64),
        kind: z.enum(['wall', 'bar', 'stage', 'door', 'window', 'plant', 'label', 'zone']),
        x: z.number(),
        y: z.number(),
        width: z.number().min(1),
        height: z.number().min(1),
        rotation: z.number().default(0),
        label: z.string().max(80).optional(),
      }),
    )
    .max(500)
    .default([]),
});

export const areaSchema = z.object({
  id: zId.optional(),
  branchId: zId,
  name: z.string().trim().min(1).max(80),
  nameAr: optText(80),
  kind: z.enum(AREA_KINDS),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  bookableOnline: z.boolean().default(true),
  floorPlan: floorPlanSchema.optional(),
});
export const areaUpdateSchema = areaSchema.omit({ branchId: true, id: true }).partial();

export const tableSchema = z
  .object({
    id: zId.optional(),
    branchId: zId,
    areaId: zId,
    label: z.string().trim().min(1).max(20),
    capacity: z.number().int().min(1).max(100),
    minCapacity: z.number().int().min(1).max(100),
    maxCapacity: z.number().int().min(1).max(100),
    shape: z.enum(TABLE_SHAPES).default('square'),
    posX: z.number().default(40),
    posY: z.number().default(40),
    width: z.number().min(20).max(1000).default(80),
    height: z.number().min(20).max(1000).default(80),
    rotation: z.number().min(-360).max(360).default(0),
    isVip: z.boolean().default(false),
    isActive: z.boolean().default(true),
    bookableOnline: z.boolean().default(true),
    combinable: z.boolean().default(true),
  })
  .refine((t) => t.minCapacity <= t.maxCapacity, 'minCapacity must be ≤ maxCapacity');

export const tableUpdateSchema = z
  .object({
    areaId: zId,
    label: z.string().trim().min(1).max(20),
    capacity: z.number().int().min(1).max(100),
    minCapacity: z.number().int().min(1).max(100),
    maxCapacity: z.number().int().min(1).max(100),
    shape: z.enum(TABLE_SHAPES),
    posX: z.number(),
    posY: z.number(),
    width: z.number().min(20).max(1000),
    height: z.number().min(20).max(1000),
    rotation: z.number().min(-360).max(360),
    isVip: z.boolean(),
    isActive: z.boolean(),
    bookableOnline: z.boolean(),
    combinable: z.boolean(),
  })
  .partial();

export const tableLayoutSchema = z.object({
  tables: z
    .array(
      z.object({
        id: zId,
        posX: z.number(),
        posY: z.number(),
        width: z.number().min(20).max(1000).optional(),
        height: z.number().min(20).max(1000).optional(),
        rotation: z.number().min(-360).max(360).optional(),
        areaId: zId.optional(),
      }),
    )
    .max(1000),
});

export const tableStatusSchema = z.object({
  status: z.enum(MANUAL_TABLE_STATUSES),
  reason: optText(200),
  until: zDateTime.nullable().optional(),
});

export const tableCombinationSchema = z.object({
  branchId: zId,
  name: z.string().trim().min(1).max(60),
  tableIds: z.array(zId).min(2).max(12),
  minCapacity: z.number().int().min(1).max(500),
  maxCapacity: z.number().int().min(1).max(500),
  isActive: z.boolean().default(true),
});

// ---------------------------------------------------------------------------------------------------------
// Guests (CRM)
// ---------------------------------------------------------------------------------------------------------

export const consentChannelsSchema = z.object({
  whatsapp: z.boolean().default(false),
  sms: z.boolean().default(false),
  email: z.boolean().default(false),
  push: z.boolean().default(false),
});

const guestFields = {
  firstName: z.string().trim().min(1).max(100),
  lastName: optText(100),
  preferredName: optText(100),
  phone: optText(40),
  whatsapp: optText(40),
  email: zEmailOrEmpty,
  birthday: zIsoDate.nullable().optional(),
  anniversary: zIsoDate.nullable().optional(),
  address: optText(500),
  company: optText(150),
  preferredLanguage: z.enum(LANGUAGES).nullable().optional(),
  vipLevel: z.enum(VIP_LEVELS).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
  notes: optText(5000),
  preferences: z.record(z.string().max(60), z.string().max(500)).optional(),
  allergies: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  dietary: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  marketingConsent: z.boolean().optional(),
  consentChannels: consentChannelsSchema.optional(),
  homeBranchId: zId.nullable().optional(),
  source: optText(40),
};

export const guestCreateSchema = z.object({ id: zId.optional(), ...guestFields });
export const guestUpdateSchema = z.object(guestFields).partial();
export type GuestCreateInput = z.infer<typeof guestCreateSchema>;
export type GuestUpdateInput = z.infer<typeof guestUpdateSchema>;

export const guestNoteSchema = z.object({
  id: zId.optional(),
  guestId: zId,
  body: z.string().trim().min(1).max(5000),
  isPinned: z.boolean().default(false),
  branchId: zId.nullable().optional(),
});

export const guestOccasionSchema = z.object({
  type: z.enum(OCCASION_TYPES),
  date: zIsoDate,
  recurring: z.boolean().default(true),
  notes: optText(500),
});

export const guestMergeSchema = z.object({ sourceIds: z.array(zId).min(1).max(20) });

export const guestListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  vipLevel: z.enum(VIP_LEVELS).optional(),
  tag: z.string().max(40).optional(),
  segment: z.string().max(60).optional(),
  sort: z.enum(['name', 'last_visit', 'total_spend', 'visits', 'created']).default('name'),
});

// ---------------------------------------------------------------------------------------------------------
// Reservations, walk-ins, waitlist
// ---------------------------------------------------------------------------------------------------------

export const inlineGuestSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: optText(100),
  phone: optText(40),
  email: zEmailOrEmpty,
});

export const reservationCreateSchema = z.object({
  id: zId.optional(),
  branchId: zId,
  guestId: zId.nullable().optional(),
  guest: inlineGuestSchema.optional(),
  date: zIsoDate,
  time: zTime,
  partySize: z.number().int().min(1).max(500),
  durationMinutes: z.number().int().min(15).max(720).optional(),
  tableIds: z.array(zId).max(12).optional(),
  areaId: zId.nullable().optional(),
  occasion: z.enum(OCCASION_TYPES).nullable().optional(),
  source: z.enum(RESERVATION_SOURCES).default('phone'),
  notes: optText(2000),
  specialRequest: optText(2000),
  depositAmount: z.number().min(0).nullable().optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  status: z.enum(['pending', 'confirmed']).optional(),
  assignedStaffId: zId.nullable().optional(),
  autoAssignTable: z.boolean().default(false),
  overrideHours: z.boolean().default(false),
});
export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;

export const reservationUpdateSchema = z
  .object({
    guestId: zId.nullable(),
    date: zIsoDate,
    time: zTime,
    partySize: z.number().int().min(1).max(500),
    durationMinutes: z.number().int().min(15).max(720),
    tableIds: z.array(zId).max(12),
    areaId: zId.nullable(),
    occasion: z.enum(OCCASION_TYPES).nullable(),
    source: z.enum(RESERVATION_SOURCES),
    notes: optText(2000),
    specialRequest: optText(2000),
    depositAmount: z.number().min(0).nullable(),
    paymentStatus: z.enum(PAYMENT_STATUSES),
    assignedStaffId: zId.nullable(),
    overrideHours: z.boolean(),
    posCheckRef: optText(80),
  })
  .partial();
export type ReservationUpdateInput = z.infer<typeof reservationUpdateSchema>;

export const RESERVATION_ACTIONS = [
  'confirm',
  'check_in',
  'seat',
  'start_dining',
  'complete',
  'cancel',
  'no_show',
  'assign_tables',
] as const;
export type ReservationAction = (typeof RESERVATION_ACTIONS)[number];

export const reservationActionSchema = z.object({
  action: z.enum(RESERVATION_ACTIONS),
  reason: optText(500),
  tableIds: z.array(zId).max(12).optional(),
  at: zDateTime.optional(),
});

export const rescheduleSchema = z.object({
  newId: zId.optional(),
  date: zIsoDate,
  time: zTime,
  partySize: z.number().int().min(1).max(500).optional(),
  tableIds: z.array(zId).max(12).optional(),
  autoAssignTable: z.boolean().default(true),
  reason: optText(500),
});

export const reservationListQuerySchema = paginationSchema.extend({
  branchId: zId.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  status: z.string().max(200).optional(),
  guestId: zId.optional(),
  q: z.string().trim().max(100).optional(),
  requiresReview: z.coerce.boolean().optional(),
});

export const walkInSchema = z.object({
  id: zId.optional(),
  branchId: zId,
  guestId: zId.nullable().optional(),
  guest: inlineGuestSchema.optional(),
  partySize: z.number().int().min(1).max(100),
  tableIds: z.array(zId).max(12).optional(),
  areaId: zId.nullable().optional(),
  notes: optText(2000),
  durationMinutes: z.number().int().min(15).max(720).optional(),
  waitIfNoTable: z.boolean().default(true),
  quotedWaitMinutes: z.number().int().min(0).max(600).optional(),
  posCheckRef: optText(80),
});

export const waitlistCreateSchema = z.object({
  id: zId.optional(),
  branchId: zId,
  guestId: zId.nullable().optional(),
  guestName: z.string().trim().min(1).max(150),
  phone: optText(40),
  partySize: z.number().int().min(1).max(100),
  desiredTime: zDateTime.nullable().optional(),
  flexibleMinutes: z.number().int().min(0).max(600).default(30),
  areaId: zId.nullable().optional(),
  priority: z.number().int().min(0).max(100).default(0),
  isVip: z.boolean().default(false),
  quotedWaitMinutes: z.number().int().min(0).max(600).nullable().optional(),
  notes: optText(1000),
});
export const waitlistUpdateSchema = waitlistCreateSchema.omit({ id: true, branchId: true }).partial();

export const waitlistSeatSchema = z.object({
  tableIds: z.array(zId).min(1).max(12),
  reservationId: zId.optional(),
  durationMinutes: z.number().int().min(15).max(720).optional(),
});

// ---------------------------------------------------------------------------------------------------------
// Loyalty, feedback, complaints
// ---------------------------------------------------------------------------------------------------------

export const loyaltyTierSchema = z.object({
  id: zId.optional(),
  name: z.string().trim().min(1).max(60),
  nameAr: optText(60),
  minPoints: z.number().int().min(0),
  multiplier: z.number().min(0).max(10).default(1),
  benefits: optText(1000),
  color: zColor.optional(),
  sortOrder: z.number().int().default(0),
});

export const loyaltyRuleSchema = z.object({
  id: zId.optional(),
  type: z.enum(LOYALTY_RULE_TYPES),
  name: z.string().trim().min(1).max(80),
  isActive: z.boolean().default(true),
  /** points_per_currency: { currencyUnit, points } · visit: { points } · birthday: { points } ·
   *  spend_threshold: { threshold, points } · referral: { points } */
  config: z.record(z.string(), z.number()),
});

export const loyaltyRewardSchema = z.object({
  id: zId.optional(),
  name: z.string().trim().min(1).max(80),
  nameAr: optText(80),
  type: z.enum(REWARD_TYPES),
  pointsCost: z.number().int().min(1),
  value: z.number().min(0).default(0),
  description: optText(500),
  isActive: z.boolean().default(true),
});

export const loyaltyConfigSchema = z.object({
  enabled: z.boolean(),
  pointsExpiryMonths: z.number().int().min(0).max(120),
  tiers: z.array(loyaltyTierSchema).max(20),
  rules: z.array(loyaltyRuleSchema).max(50),
  rewards: z.array(loyaltyRewardSchema).max(100),
});

export const loyaltyAdjustSchema = z.object({
  id: zId.optional(),
  guestId: zId,
  points: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(1).max(300),
  branchId: zId.nullable().optional(),
});

export const loyaltyRedeemSchema = z.object({
  id: zId.optional(),
  guestId: zId,
  rewardId: zId,
  branchId: zId.nullable().optional(),
  reservationId: zId.nullable().optional(),
});

export const feedbackSubmitSchema = z.object({
  foodRating: z.number().int().min(1).max(5).nullable().optional(),
  serviceRating: z.number().int().min(1).max(5).nullable().optional(),
  atmosphereRating: z.number().int().min(1).max(5).nullable().optional(),
  overallRating: z.number().int().min(1).max(5),
  comment: optText(3000),
  suggestion: optText(3000),
  isComplaint: z.boolean().default(false),
});

export const complaintCreateSchema = z.object({
  guestId: zId.nullable().optional(),
  reservationId: zId.nullable().optional(),
  branchId: zId,
  feedbackId: zId.nullable().optional(),
  category: z.enum(COMPLAINT_CATEGORIES),
  severity: z.enum(COMPLAINT_SEVERITIES).default('medium'),
  description: z.string().trim().min(1).max(5000),
  employeeName: optText(120),
  assignedTo: zId.nullable().optional(),
  followUpAt: zDateTime.nullable().optional(),
});
export const complaintUpdateSchema = complaintCreateSchema
  .omit({ branchId: true })
  .partial()
  .extend({
    status: z.enum(COMPLAINT_STATUSES).optional(),
    resolution: optText(5000),
    compensation: optText(500),
    compensationAmount: z.number().min(0).nullable().optional(),
  });

// ---------------------------------------------------------------------------------------------------------
// Marketing & notifications
// ---------------------------------------------------------------------------------------------------------

export const SEGMENT_FIELDS = [
  'vip_level',
  'total_spend',
  'visit_count',
  'avg_check',
  'days_since_last_visit',
  'days_since_first_visit',
  'no_show_count',
  'loyalty_points',
  'tag',
  'birthday_in_days',
  'anniversary_in_days',
  'home_branch_id',
  'preferred_language',
] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const segmentRuleSchema = z.object({
  field: z.enum(SEGMENT_FIELDS),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']),
  value: z.union([z.string().max(100), z.number(), z.array(z.union([z.string().max(100), z.number()])).max(50)]),
});

export const segmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optText(500),
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(segmentRuleSchema).min(1).max(20),
});

export const templateSchema = z.object({
  key: z.enum(TEMPLATE_KEYS),
  channel: z.enum(CHANNELS),
  language: z.enum(LANGUAGES),
  subject: optText(200),
  body: z.string().min(1).max(4000),
  providerTemplateName: optText(120),
  isActive: z.boolean().default(true),
});

export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  segmentKey: z.string().min(1).max(80),
  channel: z.enum(CHANNELS),
  language: z.enum(['ar', 'en', 'guest']).default('guest'),
  subject: optText(200),
  body: z.string().min(1).max(4000),
  providerTemplateName: optText(120),
  scheduledAt: zDateTime.nullable().optional(),
  cost: z.number().min(0).default(0),
  attributionDays: z.number().int().min(1).max(90).default(14),
  branchId: zId.nullable().optional(),
});

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

export const brandingSchema = z.object({
  restaurantName: z.string().trim().min(1).max(120),
  restaurantNameAr: z.string().trim().max(120).default(''),
  tagline: z.string().trim().max(200).default(''),
  logoFileId: zId.nullable().default(null),
  loginBackgroundFileId: zId.nullable().default(null),
  faviconFileId: zId.nullable().default(null),
  colors: z.object({
    primary: zColor,
    primaryDark: zColor,
    secondary: zColor,
    accent: zColor,
    background: zColor,
    surface: zColor,
    text: zColor,
  }),
  contact: z.object({
    phone: z.string().max(40).default(''),
    whatsapp: z.string().max(40).default(''),
    email: z.string().max(200).default(''),
    website: z.string().max(200).default(''),
    instagram: z.string().max(200).default(''),
    address: z.string().max(500).default(''),
  }),
});
export type Branding = z.infer<typeof brandingSchema>;

export const DEFAULT_BRANDING: Branding = {
  restaurantName: "Sofia's Resto-Lounge",
  restaurantNameAr: 'صوفيا ريستو-لاونج',
  tagline: 'Resto-Lounge',
  logoFileId: null,
  loginBackgroundFileId: null,
  faviconFileId: null,
  colors: {
    primary: '#6B1420',
    primaryDark: '#3E0B12',
    secondary: '#F3E6D0',
    accent: '#C9A26B',
    background: '#FBF7F1',
    surface: '#FFFFFF',
    text: '#2A1416',
  },
  contact: { phone: '', whatsapp: '', email: '', website: '', instagram: '', address: '' },
};

export const generalSettingsSchema = z.object({
  defaultLanguage: z.enum(LANGUAGES),
  primaryCurrency: z.enum(CURRENCIES),
  secondaryCurrency: z.enum(CURRENCIES).nullable(),
  usdToIqdRate: z.number().min(0),
  timezone: zTimeZone,
  publicBaseUrl: z.string().max(300),
  offlineGraceHours: z.number().int().min(1).max(720),
  enforceMfaForAdmins: z.boolean(),
  sessionIdleMinutes: z.number().int().min(5).max(1440),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  defaultLanguage: 'ar',
  primaryCurrency: 'IQD',
  secondaryCurrency: 'USD',
  usdToIqdRate: 1310,
  timezone: 'Asia/Baghdad',
  publicBaseUrl: '',
  offlineGraceHours: 72,
  enforceMfaForAdmins: false,
  sessionIdleMinutes: 480,
};

export const guestSettingsSchema = z.object({
  duplicateMatching: z.object({
    phone: z.boolean(),
    email: z.boolean(),
    name: z.boolean(),
    nameSimilarity: z.number().min(0.3).max(1),
  }),
  highSpenderThreshold: z.number().min(0),
  frequentVisitsIn90Days: z.number().int().min(1),
  tags: z.array(z.string().max(40)).max(200),
  dataRetentionMonths: z.number().int().min(0).max(240),
  defaultCountry: z.string().length(2),
});
export type GuestSettings = z.infer<typeof guestSettingsSchema>;
export const DEFAULT_GUEST_SETTINGS: GuestSettings = {
  duplicateMatching: { phone: true, email: true, name: true, nameSimilarity: 0.75 },
  highSpenderThreshold: 1_000_000,
  frequentVisitsIn90Days: 4,
  tags: ['Regular', 'Influencer', 'Corporate', 'Family', 'Celebrity', 'Hookah', 'Window seat'],
  dataRetentionMonths: 0,
  defaultCountry: 'IQ',
};

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'every_6_hours', 'every_12_hours', 'weekly']),
  timeOfDay: zTime,
  retentionDays: z.number().int().min(1).max(3650),
  keepMinimum: z.number().int().min(1).max(1000),
  externalDirectory: z.string().max(500),
  verifyMode: z.enum(['list', 'full']),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: true,
  frequency: 'daily',
  timeOfDay: '04:00',
  retentionDays: 30,
  keepMinimum: 7,
  externalDirectory: '',
  verifyMode: 'list',
};

export const notificationSettingsSchema = z.object({
  channelsEnabled: z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean(), push: z.boolean() }),
  preferredTransactionalChannel: z.enum(CHANNELS),
  sendConfirmation: z.boolean(),
  sendReminder: z.boolean(),
  sendFeedbackRequest: z.boolean(),
  sendBirthday: z.boolean(),
  vipArrivalAlert: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  channelsEnabled: { whatsapp: false, sms: false, email: false, push: false },
  preferredTransactionalChannel: 'whatsapp',
  sendConfirmation: true,
  sendReminder: true,
  sendFeedbackRequest: true,
  sendBirthday: true,
  vipArrivalAlert: true,
};

// ---------------------------------------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------------------------------------

export const setupSchema = z.object({
  setupToken: z.string().min(8).max(200),
  restaurant: z.object({
    name: z.string().trim().min(1).max(120),
    nameAr: z.string().trim().max(120).default(''),
    phone: z.string().max(40).default(''),
    email: z.string().max(200).default(''),
    logoDataUrl: z
      .string()
      .max(3_000_000)
      .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,/)
      .nullable()
      .optional(),
  }),
  branch: z.object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/),
    name: z.string().trim().min(1).max(120),
    nameAr: z.string().trim().max(120).default(''),
    address: z.string().max(500).default(''),
    phone: z.string().max(40).default(''),
    timezone: zTimeZone.default('Asia/Baghdad'),
  }),
  currency: z.enum(CURRENCIES).default('IQD'),
  secondaryCurrency: z.enum(CURRENCIES).nullable().default('USD'),
  language: z.enum(LANGUAGES).default('ar'),
  operatingHours: weeklyHoursSchema,
  areas: z
    .array(
      z.object({
        key: z.string().max(40),
        name: z.string().trim().min(1).max(80),
        nameAr: z.string().max(80).default(''),
        kind: z.enum(AREA_KINDS),
      }),
    )
    .min(1)
    .max(30),
  tables: z
    .array(
      z.object({
        areaKey: z.string().max(40),
        label: z.string().trim().min(1).max(20),
        capacity: z.number().int().min(1).max(100),
        minCapacity: z.number().int().min(1).max(100).optional(),
        maxCapacity: z.number().int().min(1).max(100).optional(),
        shape: z.enum(TABLE_SHAPES).default('square'),
        isVip: z.boolean().default(false),
      }),
    )
    .max(500),
  admin: z.object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(120),
    email: zEmailOrEmpty,
    password: passwordSchema,
  }),
  reservation: z.object({
    slotIntervalMinutes: z.number().int().min(5).max(120).default(30),
    defaultDurationMinutes: z.number().int().min(15).max(720).default(120),
    bufferMinutes: z.number().int().min(0).max(240).default(15),
    maxAdvanceDays: z.number().int().min(1).max(730).default(60),
    onlineBookingEnabled: z.boolean().default(true),
    depositEnabled: z.boolean().default(false),
  }),
  pos: z
    .object({
      provider: z.enum(['none', 'generic_rest', 'webhook', 'csv_import']).default('none'),
      baseUrl: z.string().max(300).default(''),
    })
    .default({ provider: 'none', baseUrl: '' }),
  backup: z.object({
    enabled: z.boolean().default(true),
    timeOfDay: zTime.default('04:00'),
    retentionDays: z.number().int().min(1).max(3650).default(30),
    externalDirectory: z.string().max(500).default(''),
  }),
  publicBaseUrl: z.string().max(300).default(''),
});
export type SetupInput = z.infer<typeof setupSchema>;

// ---------------------------------------------------------------------------------------------------------
// POS
// ---------------------------------------------------------------------------------------------------------

export const POS_PROVIDERS = ['generic_rest', 'webhook', 'csv_import'] as const;
export type PosProvider = (typeof POS_PROVIDERS)[number];

export const posConnectionSchema = z.object({
  branchId: zId,
  name: z.string().trim().min(1).max(80),
  provider: z.enum(POS_PROVIDERS),
  isActive: z.boolean().default(true),
  pollIntervalMinutes: z.number().int().min(1).max(1440).default(5),
  config: z
    .object({
      baseUrl: z.string().max(500).optional(),
      invoicesPath: z.string().max(200).optional(),
      apiKey: z.string().max(500).optional(),
      authHeader: z.string().max(100).optional(),
      webhookSecret: z.string().max(200).optional(),
      fieldMap: z.record(z.string().max(60), z.string().max(120)).optional(),
      currency: z.enum(CURRENCIES).optional(),
    })
    .default({}),
});

export const posInvoiceSchema = z.object({
  externalId: z.string().min(1).max(120),
  invoiceNumber: z.string().max(120).optional(),
  openedAt: zDateTime.optional(),
  closedAt: zDateTime,
  tableLabel: z.string().max(40).nullable().optional(),
  reservationCode: z.string().max(40).nullable().optional(),
  guestPhone: z.string().max(40).nullable().optional(),
  loyaltyNumber: z.string().max(40).nullable().optional(),
  covers: z.number().int().min(0).max(500).nullable().optional(),
  subtotal: z.number(),
  discount: z.number().default(0),
  tax: z.number().default(0),
  serviceCharge: z.number().default(0),
  total: z.number(),
  currency: z.enum(CURRENCIES).default('IQD'),
  paymentMethod: z.string().max(60).nullable().optional(),
  status: z.enum(['closed', 'void', 'refunded']).default('closed'),
  items: z
    .array(
      z.object({
        externalItemId: z.string().max(120).nullable().optional(),
        name: z.string().min(1).max(200),
        category: z.string().max(120).nullable().optional(),
        quantity: z.number(),
        unitPrice: z.number(),
        discount: z.number().default(0),
        total: z.number(),
      }),
    )
    .max(500)
    .default([]),
});
export type PosInvoiceInput = z.infer<typeof posInvoiceSchema>;
