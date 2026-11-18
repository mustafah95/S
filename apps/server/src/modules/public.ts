import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  CURRENCIES,
  OCCASION_TYPES,
  addDays,
  businessDateOf,
  feedbackSubmitSchema,
  normalizePhone,
  utcToZoned,
  zId,
  zIsoDate,
  zTime,
} from '@sofia/shared';
import { getDb, q1, schema, sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { systemContext } from '../lib/context.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import { AppError, notFound, unauthorized, unprocessable } from '../lib/errors.js';
import { defineRoute } from '../lib/route.js';
import { getSecrets, getSetting } from '../lib/settings.js';
import { logEvent } from '../lib/system-events.js';
import { submitFeedback } from './feedback.js';
import { createGuest, updateGuest } from './guests/service.js';
import { optOutToken, publicBaseUrl } from './notifications/service.js';
import { computeAvailability } from './reservations/routes.js';
import { createReservation, transitionReservation } from './reservations/service.js';
import { reservationSettingsOf } from './venue.js';

const PUBLIC_LIMIT = { max: 30, timeWindow: '1 minute' };

async function resolveBranch(ref: string) {
  const isId = /^[0-9a-f-]{36}$/i.test(ref);
  const [b] = await getDb()
    .select()
    .from(schema.branches)
    .where(and(isId ? eq(schema.branches.id, ref) : sql`lower(${schema.branches.code}) = lower(${ref})`, isNull(schema.branches.deletedAt), eq(schema.branches.isActive, true)));
  if (!b) throw notFound('Branch');
  return b;
}

async function confirmationView(code: string) {
  const r = await q1<Record<string, any>>(
    getDb(),
    sql`SELECT r.*, b.name AS branch_name, b.name_ar AS branch_name_ar, b.address AS branch_address, b.phone AS branch_phone, b.timezone,
               b.reservation_settings, a.name AS area_name
        FROM reservations r JOIN branches b ON b.id = r.branch_id LEFT JOIN areas a ON a.id = r.area_id WHERE r.code = ${code}`,
  );
  if (!r) throw notFound('Reservation');
  const settings = reservationSettingsOf({ reservationSettings: r.reservation_settings });
  const base = await publicBaseUrl();
  const manageUrl = `${base}/r/${r.code}?t=${r.confirmation_token}`;
  const payment = await getSetting('integrations.payment');
  return {
    code: r.code,
    status: r.status,
    guestName: r.guest_name,
    branch: { name: r.branch_name, nameAr: r.branch_name_ar, address: r.branch_address, phone: r.branch_phone },
    date: r.business_date,
    time: utcToZoned(new Date(r.start_at), r.timezone).time,
    startAt: r.start_at,
    endAt: r.end_at,
    partySize: r.party_size,
    area: r.area_name,
    occasion: r.occasion,
    specialRequest: r.special_request,
    deposit: r.deposit_amount ? { amount: Number(r.deposit_amount), currency: r.deposit_currency, status: r.payment_status, instructions: payment.instructions } : null,
    policy: settings.cancellationPolicy,
    cancellable: ['pending', 'confirmed'].includes(r.status) && new Date(r.start_at).getTime() - Date.now() > settings.cancellationCutoffHours * 3600_000,
    manageUrl,
    qr: await QRCode.toDataURL(manageUrl, { margin: 1, width: 240, color: { dark: '#3E0B12', light: '#FFFFFF' } }),
    token: r.confirmation_token as string,
  };
}

async function requireToken(code: string, token: string | undefined) {
  const r = await q1<{ confirmation_token: string }>(getDb(), sql`SELECT confirmation_token FROM reservations WHERE code = ${code}`);
  if (!r || !token || !safeEqual(r.confirmation_token, token)) throw notFound('Reservation');
}

function ics(v: Awaited<ReturnType<typeof confirmationView>>, restaurant: string): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    "PRODID:-//Sofia's Resto-Lounge//Reservations//EN",
    'BEGIN:VEVENT',
    `UID:${v.code}@sofia`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(new Date(v.startAt))}`,
    `DTEND:${fmt(new Date(v.endAt))}`,
    `SUMMARY:${esc(`${restaurant} — ${v.partySize} guests`)}`,
    `LOCATION:${esc(`${v.branch.name}${v.branch.address ? `, ${v.branch.address}` : ''}`)}`,
    `DESCRIPTION:${esc(`Reservation ${v.code}\n${v.manageUrl}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

const publicBookingSchema = z.object({
  branchId: zId,
  date: zIsoDate,
  time: zTime,
  partySize: z.number().int().min(1).max(100),
  areaId: zId.nullable().optional(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional(),
  phone: z.string().trim().min(6).max(40),
  email: z.union([z.email().max(200), z.literal('')]).optional(),
  occasion: z.enum(OCCASION_TYPES).nullable().optional(),
  specialRequest: z.string().trim().max(1000).optional(),
  marketingConsent: z.boolean().default(false),
  language: z.enum(['ar', 'en']).default('ar'),
  source: z.enum(['online', 'widget']).default('online'),
  /** Honeypot: must stay empty (bots fill every field). */
  website: z.string().max(0).optional(),
});

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/public/branding', summary: 'Restaurant identity for login and booking pages', tags: ['Public'], auth: 'none', allowInMaintenance: true }, async () => {
    const b = await getSetting('branding');
    const g = await getSetting('general');
    const setup = await getSetting('system.setup');
    return { ...b, logoUrl: b.logoFileId ? `/api/v1/files/${b.logoFileId}` : null, loginBackgroundUrl: b.loginBackgroundFileId ? `/api/v1/files/${b.loginBackgroundFileId}` : null, faviconUrl: b.faviconFileId ? `/api/v1/files/${b.faviconFileId}` : null, defaultLanguage: g.defaultLanguage, currencies: CURRENCIES, setupCompleted: setup.completed };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/public/branches', summary: 'Branches accepting online reservations', tags: ['Public'], auth: 'none' }, async () => {
    const branches = await db.select().from(schema.branches).where(and(isNull(schema.branches.deletedAt), eq(schema.branches.isActive, true)));
    const out = [];
    for (const b of branches) {
      const s = reservationSettingsOf(b);
      if (!s.onlineBookingEnabled) continue;
      const areas = await db.select({ id: schema.areas.id, name: schema.areas.name, nameAr: schema.areas.nameAr, kind: schema.areas.kind }).from(schema.areas).where(and(eq(schema.areas.branchId, b.id), eq(schema.areas.isActive, true), eq(schema.areas.bookableOnline, true), isNull(schema.areas.deletedAt)));
      out.push({
        id: b.id,
        code: b.code,
        name: b.name,
        nameAr: b.nameAr,
        address: b.address,
        phone: b.phone,
        timezone: b.timezone,
        today: businessDateOf(new Date(), b.timezone),
        maxDate: addDays(businessDateOf(new Date(), b.timezone), s.maxAdvanceDays),
        maxPartySize: s.maxOnlinePartySize,
        cancellationPolicy: s.cancellationPolicy,
        deposit: s.deposit.enabled ? { minPartySize: s.deposit.minPartySize, amountPerGuest: s.deposit.amountPerGuest, currency: s.deposit.currency } : null,
        areas,
      });
    }
    return out;
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/public/availability', summary: 'Available times for online booking', tags: ['Public'], auth: 'none', rateLimit: { max: 120, timeWindow: '1 minute' }, query: z.object({ branch: z.string().max(40), date: zIsoDate, partySize: z.coerce.number().int().min(1).max(100), areaId: zId.optional() }) }, async ({ query }) => {
    const b = await resolveBranch(query.branch);
    const s = reservationSettingsOf(b);
    const today = businessDateOf(new Date(), b.timezone);
    if (!s.onlineBookingEnabled) throw unprocessable('online_disabled', 'Online booking is not available for this branch');
    if (query.partySize > s.maxOnlinePartySize) throw unprocessable('party_too_large', `For parties above ${s.maxOnlinePartySize} please call us`);
    if (query.date < today || query.date > addDays(today, s.maxAdvanceDays)) return { date: query.date, slots: [] };
    const a = await computeAvailability(b.id, query.date, query.partySize, { areaId: query.areaId, publicMode: true });
    return { date: a.date, slots: a.slots.map((x) => ({ time: x.time, available: x.available })) };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/public/reservations', summary: 'Book a table online', tags: ['Public'], auth: 'none', skipCsrf: true, rateLimit: { max: 10, timeWindow: '1 minute' }, body: publicBookingSchema }, async ({ body, req, reply }) => {
    if (body.website) throw unprocessable('rejected', 'Request rejected');
    const b = await resolveBranch(body.branchId);
    const s = reservationSettingsOf(b);
    const today = businessDateOf(new Date(), b.timezone);
    if (!s.onlineBookingEnabled) throw unprocessable('online_disabled', 'Online booking is not available for this branch');
    if (body.partySize > s.maxOnlinePartySize) throw unprocessable('party_too_large', `For parties above ${s.maxOnlinePartySize} please call us`);
    if (body.date < today || body.date > addDays(today, s.maxAdvanceDays)) throw unprocessable('date_out_of_range', 'Please choose another date');
    const phone = normalizePhone(body.phone);
    if (!phone) throw unprocessable('invalid_phone', 'Please enter a valid phone number');
    const ctx = { ...systemContext('public-booking'), ip: req.ip, userAgent: req.headers['user-agent'] };
    const result = await db.transaction(async (tx) => {
      const minNotice = Date.now() + s.minNoticeMinutes * 60_000;
      let [guest] = await tx.select().from(schema.guests).where(and(eq(schema.guests.phoneNormalized, phone), isNull(schema.guests.deletedAt), isNull(schema.guests.mergedIntoId)));
      if (!guest) {
        guest = (await createGuest(tx, ctx, { firstName: body.firstName, lastName: body.lastName ?? null, phone: body.phone, email: body.email || null, preferredLanguage: body.language, marketingConsent: body.marketingConsent, consentChannels: body.marketingConsent ? { whatsapp: true, sms: true, email: !!body.email, push: false } : undefined, source: 'online' })).guest;
      } else {
        const patch: Record<string, unknown> = {};
        if (body.email && !guest.email) patch.email = body.email;
        if (!guest.preferredLanguage) patch.preferredLanguage = body.language;
        if (body.marketingConsent && !guest.marketingConsent) {
          patch.marketingConsent = true;
          patch.consentChannels = { whatsapp: true, sms: true, email: !!(body.email || guest.email), push: false };
        }
        if (Object.keys(patch).length) guest = await updateGuest(tx, ctx, guest.id, patch);
      }
      const r = await createReservation(
        tx,
        ctx,
        { branchId: b.id, guestId: guest!.id, date: body.date, time: body.time, partySize: body.partySize, areaId: body.areaId ?? null, occasion: body.occasion ?? null, specialRequest: body.specialRequest ?? null, source: body.source, autoAssignTable: true, overrideHours: false },
        { origin: 'public' },
      );
      if (r.reservation.startAt.getTime() < minNotice) throw unprocessable('too_soon', 'Please choose a later time');
      return r;
    });
    await logEvent('info', 'app', `Online reservation ${result.reservation.code} (${body.partySize} pax)`, { branch: b.code });
    reply.code(201);
    return confirmationView(result.reservation.code);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/public/reservations/:code', summary: 'Reservation confirmation (requires the confirmation token)', tags: ['Public'], auth: 'none', rateLimit: PUBLIC_LIMIT, params: z.object({ code: z.string().max(20) }), query: z.object({ t: z.string().max(80).optional() }) }, async ({ params, query }) => {
    await requireToken(params.code.toUpperCase(), query.t);
    return confirmationView(params.code.toUpperCase());
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/public/reservations/:code/cancel', summary: 'Guest self-cancellation (within the cancellation policy)', tags: ['Public'], auth: 'none', skipCsrf: true, rateLimit: PUBLIC_LIMIT, params: z.object({ code: z.string().max(20) }), body: z.object({ t: z.string().max(80), reason: z.string().max(300).optional() }) }, async ({ params, body }) => {
    const code = params.code.toUpperCase();
    await requireToken(code, body.t);
    const view = await confirmationView(code);
    if (!view.cancellable) throw unprocessable('too_late', 'This reservation can no longer be cancelled online. Please call the restaurant.');
    const r = await q1<{ id: string }>(db, sql`SELECT id FROM reservations WHERE code = ${code}`);
    await db.transaction((tx) => transitionReservation(tx, systemContext('guest-self-service'), r!.id, 'cancel', { reason: body.reason ?? 'Cancelled by guest online' }));
    return confirmationView(code);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/public/reservations/:code/calendar.ics', summary: 'Add the reservation to a calendar', tags: ['Public'], auth: 'none', rateLimit: PUBLIC_LIMIT, params: z.object({ code: z.string().max(20) }), query: z.object({ t: z.string().max(80) }) }, async ({ params, query, reply }) => {
    await requireToken(params.code.toUpperCase(), query.t);
    const v = await confirmationView(params.code.toUpperCase());
    const b = await getSetting('branding');
    return reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', `attachment; filename="${v.code}.ics"`).send(ics(v, b.restaurantName));
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/public/feedback/:token', summary: 'Feedback form context', tags: ['Public'], auth: 'none', rateLimit: PUBLIC_LIMIT, params: z.object({ token: z.uuid() }) }, async ({ params }) => {
    const r = await q1<Record<string, unknown>>(db, sql`SELECT r.code, r.business_date, r.guest_name, b.name AS branch_name, b.name_ar AS branch_name_ar,
                                                             EXISTS (SELECT 1 FROM feedback f WHERE f.reservation_id = r.id) AS submitted
                                                      FROM reservations r JOIN branches b ON b.id = r.branch_id WHERE r.feedback_token = ${params.token}`);
    if (!r) throw notFound('Feedback link');
    return { code: r.code, date: r.business_date, guestName: String(r.guest_name ?? '').split(' ')[0], branchName: r.branch_name, branchNameAr: r.branch_name_ar, submitted: r.submitted };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/public/feedback/:token', summary: 'Submit post-visit feedback', tags: ['Public'], auth: 'none', skipCsrf: true, rateLimit: PUBLIC_LIMIT, params: z.object({ token: z.uuid() }), body: feedbackSubmitSchema }, async ({ params, body }) => submitFeedback(params.token, body));

  defineRoute(app, { method: 'POST', url: '/api/v1/public/opt-out', summary: 'Unsubscribe from marketing messages', tags: ['Public', 'Privacy'], auth: 'none', skipCsrf: true, rateLimit: PUBLIC_LIMIT, body: z.object({ t: z.string().max(120) }) }, async ({ body }) => {
    const [guestId] = body.t.split('.');
    if (!guestId || !/^[0-9a-f-]{36}$/i.test(guestId)) throw unauthorized('Invalid link');
    const g = await q1<{ id: string; privacy_token: string }>(db, sql`SELECT id, privacy_token FROM guests WHERE id = ${guestId}`);
    if (!g || !safeEqual(optOutToken(g.id, g.privacy_token), body.t)) throw unauthorized('Invalid link');
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE guests SET marketing_consent = false, opted_out_at = now(), consent_updated_at = now() WHERE id = ${g.id}`);
      await audit(tx, systemContext('opt-out'), { action: 'guest.opt_out', entityType: 'guest', entityId: g.id, meta: { via: 'link' } });
    });
    return { ok: true };
  });

  // WhatsApp Business webhook (Meta): verification handshake + signed inbound events -------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/webhooks/whatsapp', summary: 'WhatsApp webhook verification', tags: ['Webhooks'], auth: 'none', query: z.object({ 'hub.mode': z.string().optional(), 'hub.verify_token': z.string().optional(), 'hub.challenge': z.string().optional() }) }, async ({ query, reply }) => {
    const secrets = await getSecrets<{ verifyToken?: string }>('whatsapp');
    if (query['hub.mode'] === 'subscribe' && secrets?.verifyToken && query['hub.verify_token'] && safeEqual(query['hub.verify_token'], secrets.verifyToken)) {
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    throw unauthorized('Verification failed');
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/webhooks/whatsapp', summary: 'WhatsApp inbound messages and delivery statuses (signature verified)', tags: ['Webhooks'], auth: 'none', rateLimit: { max: 1000, timeWindow: '1 minute' } }, async ({ req }) => {
    const secrets = await getSecrets<{ appSecret?: string }>('whatsapp');
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const sig = String(req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, '');
    if (!secrets?.appSecret || !raw || !sig || !safeEqual(sig, hmacSha256(secrets.appSecret, raw))) {
      await logEvent('warn', 'security', 'WhatsApp webhook signature rejected', { ip: req.ip });
      throw new AppError(401, 'invalid_signature', 'Invalid signature');
    }
    const body = req.body as { entry?: { changes?: { value?: { messages?: { from: string; text?: { body?: string } }[]; statuses?: { id: string; status: string }[] } }[] }[] };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          const text = (m.text?.body ?? '').trim().toUpperCase();
          if (['STOP', 'UNSUBSCRIBE', 'إيقاف', 'الغاء الاشتراك'].includes(text)) {
            const phone = normalizePhone(`+${m.from}`);
            await db.execute(sql`UPDATE guests SET marketing_consent = false, opted_out_at = now(), consent_updated_at = now()
                                 WHERE phone_normalized = ${phone} OR whatsapp = ${phone}`);
            await logEvent('info', 'integration', 'Guest opted out via WhatsApp', { phone: phone?.slice(0, 6) + '…' });
          }
        }
        for (const st of change.value?.statuses ?? []) {
          if (st.status === 'failed') await db.execute(sql`UPDATE notification_outbox SET status = 'failed', last_error = 'Reported failed by WhatsApp' WHERE provider_message_id = ${st.id}`);
        }
      }
    }
    return { ok: true };
  });
}
