import { and, eq, isNull } from 'drizzle-orm';
import { z, type ZodType } from 'zod';
import {
  DEFAULT_BACKUP_SETTINGS,
  DEFAULT_BRANDING,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_GUEST_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  backupSettingsSchema,
  brandingSchema,
  generalSettingsSchema,
  guestSettingsSchema,
  notificationSettingsSchema,
} from '@sofia/shared';
import { getDb, schema, type DbOrTx } from '../db/pool.js';
import type { RequestContext } from './context.js';
import { audit } from './audit.js';
import { badRequest } from './errors.js';
import { encryptJson, decryptJson } from './crypto.js';

/** Integration settings: non-secret part is readable by admins; secrets are encrypted and never returned. */
const whatsappSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['meta_cloud']).default('meta_cloud'),
  phoneNumberId: z.string().max(80).default(''),
  businessAccountId: z.string().max(80).default(''),
  apiVersion: z.string().max(10).default('v21.0'),
  defaultLanguage: z.enum(['ar', 'en']).default('ar'),
  secretsSet: z.boolean().default(false),
});
const emailSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().max(200).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().max(200).default(''),
  fromAddress: z.string().max(200).default(''),
  fromName: z.string().max(200).default("Sofia's Resto-Lounge"),
  secretsSet: z.boolean().default(false),
});
const smsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['twilio', 'generic_http']).default('generic_http'),
  accountSid: z.string().max(100).default(''),
  fromNumber: z.string().max(40).default(''),
  url: z.string().max(500).default(''),
  method: z.enum(['GET', 'POST']).default('POST'),
  toParam: z.string().max(40).default('to'),
  textParam: z.string().max(40).default('text'),
  extraParams: z.record(z.string(), z.string()).default({}),
  secretsSet: z.boolean().default(false),
});
const paymentSchema = z.object({
  provider: z.enum(['manual']).default('manual'),
  instructions: z.object({ en: z.string().max(1000), ar: z.string().max(1000) }).default({
    en: 'Our team will contact you to arrange the deposit.',
    ar: 'سيتواصل معك فريقنا لترتيب دفع العربون.',
  }),
});
const setupStateSchema = z.object({ completed: z.boolean().default(false), completedAt: z.string().nullable().default(null) });
const maintenanceSchema = z.object({
  enabled: z.boolean().default(false),
  reason: z.string().default(''),
  since: z.string().nullable().default(null),
});
const updateStateSchema = z.object({
  lastCheckAt: z.string().nullable().default(null),
  latest: z.record(z.string(), z.unknown()).nullable().default(null),
  downloaded: z
    .object({ version: z.string(), path: z.string(), sha256: z.string(), verifiedAt: z.string() })
    .nullable()
    .default(null),
  pendingJobId: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

const epochSchema = z.object({ epoch: z.string().default('') });

export const SETTINGS = {
  branding: { schema: brandingSchema, defaults: DEFAULT_BRANDING, permission: 'settings.manage' },
  general: { schema: generalSettingsSchema, defaults: DEFAULT_GENERAL_SETTINGS, permission: 'settings.manage' },
  guests: { schema: guestSettingsSchema, defaults: DEFAULT_GUEST_SETTINGS, permission: 'settings.manage' },
  backup: { schema: backupSettingsSchema, defaults: DEFAULT_BACKUP_SETTINGS, permission: 'system.backup' },
  notifications: {
    schema: notificationSettingsSchema,
    defaults: DEFAULT_NOTIFICATION_SETTINGS,
    permission: 'notifications.manage',
  },
  'integrations.whatsapp': { schema: whatsappSchema, defaults: whatsappSchema.parse({}), permission: 'integrations.manage' },
  'integrations.email': { schema: emailSchema, defaults: emailSchema.parse({}), permission: 'integrations.manage' },
  'integrations.sms': { schema: smsSchema, defaults: smsSchema.parse({}), permission: 'integrations.manage' },
  'integrations.payment': { schema: paymentSchema, defaults: paymentSchema.parse({}), permission: 'integrations.manage' },
  'system.setup': { schema: setupStateSchema, defaults: setupStateSchema.parse({}), permission: null },
  'system.maintenance': { schema: maintenanceSchema, defaults: maintenanceSchema.parse({}), permission: null },
  'system.update': { schema: updateStateSchema, defaults: updateStateSchema.parse({}), permission: null },
  /** Changes when the database is restored from a backup: devices then rebuild their local copy. */
  'system.epoch': { schema: epochSchema, defaults: epochSchema.parse({}), permission: null },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
/** Settings any signed-in user may read (needed by the PWA, also offline). */
export const CLIENT_READABLE: SettingKey[] = ['branding', 'general', 'guests', 'notifications'];

const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 5_000;

export function invalidateSettingsCache(): void {
  cache.clear();
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over === undefined ? base : over;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

export async function getSetting<K extends SettingKey>(key: K, tx: DbOrTx = getDb()): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && tx === getDb()) return hit.value as SettingValue<K>;
  const def = SETTINGS[key];
  const rows = await tx
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(and(eq(schema.appSettings.key, key), isNull(schema.appSettings.branchId)));
  const merged = deepMerge(def.defaults, rows[0]?.value ?? {});
  const parsed = (def.schema as ZodType).safeParse(merged);
  const value = (parsed.success ? parsed.data : def.defaults) as SettingValue<K>;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function putSetting<K extends SettingKey>(
  tx: DbOrTx,
  ctx: RequestContext,
  key: K,
  value: unknown,
): Promise<SettingValue<K>> {
  const def = SETTINGS[key];
  const current = await getSetting(key, tx);
  const parsed = (def.schema as ZodType).safeParse(deepMerge(current, value));
  if (!parsed.success) throw badRequest(`Invalid settings for ${key}`, parsed.error.issues);
  const next = parsed.data as SettingValue<K>;
  const existing = await tx
    .select({ id: schema.appSettings.id })
    .from(schema.appSettings)
    .where(and(eq(schema.appSettings.key, key), isNull(schema.appSettings.branchId)));
  if (existing[0]) {
    await tx
      .update(schema.appSettings)
      .set({ value: next, updatedBy: ctx.user?.id ?? null })
      .where(eq(schema.appSettings.id, existing[0].id));
  } else {
    await tx.insert(schema.appSettings).values({ key, value: next, createdBy: ctx.user?.id ?? null });
  }
  if (!key.startsWith('system.')) {
    await audit(tx, ctx, {
      action: 'settings.update',
      entityType: 'settings',
      entityId: key,
      before: current as Record<string, unknown>,
      after: next as Record<string, unknown>,
    });
  }
  cache.delete(key);
  return next;
}

// --- integration secrets ----------------------------------------------------------------------------------

export async function getSecrets<T extends Record<string, string>>(key: string, tx: DbOrTx = getDb()): Promise<T | undefined> {
  const rows = await tx
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(and(eq(schema.appSettings.key, `secrets.${key}`), isNull(schema.appSettings.branchId)));
  const enc = (rows[0]?.value as { enc?: string } | undefined)?.enc;
  return decryptJson<T>(enc);
}

export async function putSecrets(tx: DbOrTx, ctx: RequestContext, key: string, secrets: Record<string, string>): Promise<void> {
  const value = { enc: encryptJson(secrets) };
  const existing = await tx
    .select({ id: schema.appSettings.id })
    .from(schema.appSettings)
    .where(and(eq(schema.appSettings.key, `secrets.${key}`), isNull(schema.appSettings.branchId)));
  if (existing[0]) await tx.update(schema.appSettings).set({ value, updatedBy: ctx.user?.id ?? null }).where(eq(schema.appSettings.id, existing[0].id));
  else await tx.insert(schema.appSettings).values({ key: `secrets.${key}`, value, createdBy: ctx.user?.id ?? null });
  await audit(tx, ctx, { action: 'settings.secrets_update', entityType: 'settings', entityId: key, meta: { fields: Object.keys(secrets) } });
}
