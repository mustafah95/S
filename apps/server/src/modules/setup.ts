import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_RESERVATION_SETTINGS, setupSchema, type SetupInput } from '@sofia/shared';
import { config } from '../config.js';
import { getDb, schema } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { defineRoute } from '../lib/route.js';
import { getSetting, putSetting } from '../lib/settings.js';
import { logEvent } from '../lib/system-events.js';
import { createSession } from './auth/service.js';
import { setSessionCookies } from './auth/routes.js';
import { storeFile } from './settings.js';
import { createUser } from './users.js';

/** Lay new tables out in a tidy grid per area so the floor plan is usable immediately. */
function gridPosition(index: number) {
  const perRow = 6;
  return { posX: 60 + (index % perRow) * 160, posY: 60 + Math.floor(index / perRow) * 150 };
}

export async function completeSetup(input: SetupInput, ctx: RequestContext) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const state = await getSetting('system.setup', tx);
    if (state.completed) throw new AppError(409, 'already_configured', 'Sofia is already configured');
    const sysCtx: RequestContext = { ...ctx, system: 'setup-wizard' };

    let logoFileId: string | null = null;
    if (input.restaurant.logoDataUrl) {
      const [, mime, b64] = /^data:([^;]+);base64,(.*)$/.exec(input.restaurant.logoDataUrl) ?? [];
      if (mime && b64) logoFileId = await storeFile({ fileName: 'logo', mimeType: mime, data: Buffer.from(b64, 'base64'), purpose: 'logo' });
    }
    await putSetting(tx, sysCtx, 'branding', {
      restaurantName: input.restaurant.name,
      restaurantNameAr: input.restaurant.nameAr,
      logoFileId,
      contact: { phone: input.restaurant.phone, email: input.restaurant.email, whatsapp: input.restaurant.phone },
    });
    await putSetting(tx, sysCtx, 'general', {
      defaultLanguage: input.language,
      primaryCurrency: input.currency,
      secondaryCurrency: input.secondaryCurrency,
      timezone: input.branch.timezone,
      publicBaseUrl: input.publicBaseUrl,
    });
    await putSetting(tx, sysCtx, 'backup', {
      enabled: input.backup.enabled,
      timeOfDay: input.backup.timeOfDay,
      retentionDays: input.backup.retentionDays,
      externalDirectory: input.backup.externalDirectory,
    });

    const [branch] = await tx
      .insert(schema.branches)
      .values({
        code: input.branch.code.toUpperCase(),
        name: input.branch.name,
        nameAr: input.branch.nameAr || null,
        address: input.branch.address || null,
        phone: input.branch.phone || null,
        timezone: input.branch.timezone,
        currency: input.currency,
        operatingHours: input.operatingHours,
        reservationSettings: {
          ...DEFAULT_RESERVATION_SETTINGS,
          slotIntervalMinutes: input.reservation.slotIntervalMinutes,
          defaultDurationMinutes: input.reservation.defaultDurationMinutes,
          bufferMinutes: input.reservation.bufferMinutes,
          maxAdvanceDays: input.reservation.maxAdvanceDays,
          onlineBookingEnabled: input.reservation.onlineBookingEnabled,
          deposit: { ...DEFAULT_RESERVATION_SETTINGS.deposit, enabled: input.reservation.depositEnabled, currency: input.currency },
        },
        capacity: input.tables.reduce((s, t) => s + t.capacity, 0),
      })
      .returning();

    const areaIds = new Map<string, string>();
    let order = 0;
    for (const a of input.areas) {
      const [row] = await tx
        .insert(schema.areas)
        .values({ branchId: branch!.id, name: a.name, nameAr: a.nameAr || null, kind: a.kind, sortOrder: order++ })
        .returning();
      areaIds.set(a.key, row!.id);
    }
    const perArea = new Map<string, number>();
    for (const t of input.tables) {
      const areaId = areaIds.get(t.areaKey) ?? [...areaIds.values()][0]!;
      const i = perArea.get(areaId) ?? 0;
      perArea.set(areaId, i + 1);
      await tx.insert(schema.restaurantTables).values({
        branchId: branch!.id,
        areaId,
        label: t.label,
        capacity: t.capacity,
        minCapacity: t.minCapacity ?? 1,
        maxCapacity: t.maxCapacity ?? t.capacity,
        shape: t.shape,
        isVip: t.isVip,
        width: t.shape === 'rectangle' || t.capacity > 4 ? 120 : 80,
        height: 80,
        ...gridPosition(i),
      });
    }

    const admin = await createUser(tx, sysCtx, {
      username: input.admin.username,
      email: input.admin.email ?? null,
      displayName: input.admin.displayName,
      password: input.admin.password,
      roleKey: 'super_admin',
      branchIds: [branch!.id],
      preferredLanguage: input.language,
      isActive: true,
      mfaRequired: false,
    });

    if (input.pos.provider !== 'none') {
      await tx.insert(schema.posConnections).values({
        branchId: branch!.id,
        name: 'Main POS',
        provider: input.pos.provider,
        config: input.pos.baseUrl ? { baseUrl: input.pos.baseUrl } : {},
        isActive: input.pos.provider === 'csv_import',
      });
    }

    await putSetting(tx, sysCtx, 'system.setup', { completed: true, completedAt: new Date().toISOString() });
    await audit(tx, { ...sysCtx, user: { id: admin.id } as never }, { action: 'system.setup_complete', entityType: 'system', entityId: 'setup', meta: { branch: branch!.code, tables: input.tables.length } });
    const session = await createSession(tx, admin.id, ctx, ctx.deviceId);
    await logEvent('info', 'app', 'First-run setup completed', { branch: branch!.code }, tx);
    return { session, branchId: branch!.id, adminId: admin.id };
  });
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, { method: 'GET', url: '/api/v1/setup/status', summary: 'Whether the first-run wizard has been completed', tags: ['Setup'], auth: 'none', allowInMaintenance: true }, async () => {
    const s = await getSetting('system.setup');
    return { completed: s.completed, setupTokenConfigured: !!config.setupToken };
  });

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/setup/complete', summary: 'Complete the first-run wizard (requires the installer setup token)', tags: ['Setup'], auth: 'none', skipCsrf: false, body: setupSchema, rateLimit: { max: 10, timeWindow: '1 minute' }, bodyLimit: 4 * 1024 * 1024 },
    async ({ body, ctx, req, reply }) => {
      if (!config.setupToken || !safeEqual(body.setupToken, config.setupToken)) {
        await logEvent('warn', 'security', 'Setup attempted with an invalid setup token', { ip: ctx.ip });
        throw unauthorized('Invalid setup token. It is shown by the installer and stored in the server configuration.', 'invalid_setup_token');
      }
      const result = await completeSetup(body, ctx);
      setSessionCookies(req, reply, result.session);
      const general = await getSetting('general');
      const [branch] = await getDb().select().from(schema.branches).where(eq(schema.branches.id, result.branchId));
      return { ok: true, branchId: result.branchId, publicBookingUrl: `${general.publicBaseUrl || ''}/book/${branch?.code ?? ''}` };
    },
  );
}
