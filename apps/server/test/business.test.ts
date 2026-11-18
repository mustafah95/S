import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { closeDb, getDb, q, sql } from '../src/db/pool.js';
import { processOutbox } from '../src/modules/notifications/service.js';
import { setMessagingFetch } from '../src/integrations/messaging.js';
import { ApiClient, createStaff, setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

let app: FastifyInstance;
let r: Restaurant;

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('POS integration', () => {
  let connId: string;
  const secret = 'pos-webhook-secret-123';

  it('accepts only correctly signed webhook invoices, matches them to the seated table and updates CRM + loyalty', async () => {
    const conn = await r.admin.post('/api/v1/pos/connections', { branchId: r.branchId, name: 'Main POS', provider: 'webhook', config: { webhookSecret: secret, currency: 'IQD' } });
    expect(conn.status).toBe(200);
    expect(conn.body.webhookSecretSet).toBe(true);
    expect(JSON.stringify(conn.body)).not.toContain(secret);
    connId = conn.body.id;

    // walk-in seated at T2 now → the invoice for T2 is matched by table + time
    const walk = await r.admin.post('/api/v1/walk-ins', { branchId: r.branchId, partySize: 3, tableIds: [r.tables.T2], guest: { firstName: 'Hadi', phone: '07709998877' } });
    expect(walk.body.seated).toBe(true);
    const guestId = walk.body.reservation.guestId;

    const invoice = { externalId: 'CHK-1001', invoiceNumber: 'INV-1001', closedAt: new Date().toISOString(), tableLabel: 'T2', subtotal: 150000, discount: 0, tax: 0, serviceCharge: 15000, total: 165000, currency: 'IQD', paymentMethod: 'cash', items: [{ name: 'Lamb Ouzi', quantity: 2, unitPrice: 50000, total: 100000 }, { name: 'Lemon Mint', quantity: 3, unitPrice: 5000, total: 15000 }] };
    const raw = JSON.stringify(invoice);
    const bad = await app.inject({ method: 'POST', url: `/api/v1/pos/webhook/${connId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sofia-signature': 'sha256=deadbeef' } });
    expect(bad.statusCode).toBe(401);
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    const ok = await app.inject({ method: 'POST', url: `/api/v1/pos/webhook/${connId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sofia-signature': `sha256=${sig}` } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ inserted: 1, matched: 1 });

    const g = await q(getDb(), sql`SELECT total_spend, invoice_count, avg_check, loyalty_points FROM guests WHERE id = ${guestId}`);
    expect(g[0]).toMatchObject({ total_spend: 165000, invoice_count: 1, avg_check: 165000 });
    expect(g[0]!.loyalty_points).toBe(165); // 1 point per 1,000 IQD
    // idempotent: the POS re-sends the same invoice
    await app.inject({ method: 'POST', url: `/api/v1/pos/webhook/${connId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sofia-signature': `sha256=${sig}` } });
    const again = await q(getDb(), sql`SELECT total_spend, loyalty_points FROM guests WHERE id = ${guestId}`);
    expect(again[0]).toMatchObject({ total_spend: 165000, loyalty_points: 165 });
    const profile = await r.admin.get(`/api/v1/guests/${guestId}/profile`);
    expect(profile.body.favorites.items[0].name).toBe('Lemon Mint');
    expect(profile.body.invoices[0].items).toHaveLength(2);
  });

  it('imports a CSV export and matches guests by phone', async () => {
    const guest = await r.admin.post('/api/v1/guests', { firstName: 'Rana', phone: '+964 771 222 3344' });
    const conn = await r.admin.post('/api/v1/pos/connections', { branchId: r.branchId, name: 'CSV', provider: 'csv_import', config: {} });
    const csv = 'externalId,closedAt,guestPhone,total,currency,items\nX-1,2026-11-10T19:00:00Z,07712223344,250000,IQD,Mixed Grill|1|200000;Kunafa|2|25000\nX-2,2026-11-11T19:00:00Z,,30,USD,\n';
    const boundary = '----sofia';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pos.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const res = await r.admin.raw('POST', `/api/v1/pos/connections/${conn.body.id}/import`, payload, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 2, matched: 1 });
    const g = await q(getDb(), sql`SELECT total_spend FROM guests WHERE id = ${guest.body.guest.id}`);
    expect(g[0]!.total_spend).toBe(250000);
    const usd = await q(getDb(), sql`SELECT total_base FROM pos_invoices WHERE external_id = 'X-2'`);
    expect(usd[0]!.total_base).toBe(30 * 1310); // converted to the primary currency (IQD)
  });
});

describe('loyalty', () => {
  it('redeems rewards and refuses when the balance is too low', async () => {
    const guest = await r.admin.post('/api/v1/guests', { firstName: 'Loyal' });
    const gid = guest.body.guest.id;
    const cfg = await r.admin.get('/api/v1/loyalty/config');
    const dessert = cfg.body.rewards.find((x: { pointsCost: number }) => x.pointsCost === 300);
    expect((await r.admin.post('/api/v1/loyalty/redeem', { guestId: gid, rewardId: dessert.id })).status).toBe(422);
    await r.admin.post('/api/v1/loyalty/adjust', { guestId: gid, points: 1200, reason: 'Opening bonus' });
    const red = await r.admin.post('/api/v1/loyalty/redeem', { guestId: gid, rewardId: dessert.id });
    expect(red.body.balance).toBe(900);
    const detail = await r.admin.get(`/api/v1/loyalty/guests/${gid}`);
    expect(detail.body.guest.tierName).toBe('Classic'); // manual adjustments do not count towards tier status
    expect(detail.body.transactions.map((t: { type: string }) => t.type)).toEqual(['redeem', 'adjust']);
  });
});

describe('marketing', () => {
  it('only messages guests who consented, and the worker delivers through the configured channel', async () => {
    const yes = await r.admin.post('/api/v1/guests', { firstName: 'Consent', phone: '07701231231', vipLevel: 'gold', marketingConsent: true, consentChannels: { whatsapp: true, sms: true, email: false, push: false } });
    await r.admin.post('/api/v1/guests', { firstName: 'NoConsent', phone: '07701231232', vipLevel: 'gold' });
    const c = await r.admin.post('/api/v1/campaigns', { name: 'VIP night', segmentKey: 'vip', channel: 'whatsapp', body: 'Join our VIP jazz night this Friday!', cost: 50000 });
    const sent = await r.admin.post(`/api/v1/campaigns/${c.body.id}/send`);
    expect(sent.body).toEqual({ queued: 1, skipped: 1 });
    const outbox = await q(getDb(), sql`SELECT recipient, body, is_marketing FROM notification_outbox WHERE campaign_id = ${c.body.id}`);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient).toBe('+9647701231231');
    expect(String(outbox[0]!.body)).toContain('Join our VIP jazz night');

    // Configure WhatsApp Cloud API and deliver with a stubbed HTTP client (no real network in tests).
    await r.admin.put('/api/v1/settings/notifications', { value: { channelsEnabled: { whatsapp: true, sms: false, email: false, push: false } } });
    await r.admin.put('/api/v1/settings/integrations.whatsapp', { value: { enabled: true, phoneNumberId: '123456', apiVersion: 'v21.0' }, secrets: { accessToken: 'EAAG-test-token' } });
    const calls: { url: string; init: RequestInit }[] = [];
    setMessagingFetch(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const stats = await processOutbox(100);
    expect(stats.sent).toBeGreaterThanOrEqual(1);
    const call = calls.find((x) => String(x.init.body).includes('Join our VIP jazz night'))!;
    expect(call.url).toBe('https://graph.facebook.com/v21.0/123456/messages');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer EAAG-test-token');
    expect(JSON.parse(String(call.init.body))).toMatchObject({ messaging_product: 'whatsapp', to: '9647701231231', type: 'text' });
    const stats2 = await r.admin.get(`/api/v1/campaigns/${c.body.id}/stats`);
    expect(stats2.body.delivery.sent).toBe(1);
    expect(yes.status).toBe(200);
  });
});

describe('public booking page', () => {
  it('books online, shows a confirmation with QR code and lets the guest cancel with the token', async () => {
    const pub = new ApiClient(app);
    const branches = await pub.get('/api/v1/public/branches');
    expect(branches.body[0].code).toBe('MAIN');
    const avail = await pub.get(`/api/v1/public/availability?branch=MAIN&date=${tomorrow()}&partySize=2`);
    const slot = avail.body.slots.find((s: { available: boolean; time: string }) => s.available && s.time >= '19:00');
    expect(slot).toBeTruthy();
    const booking = await pub.post('/api/v1/public/reservations', { branchId: r.branchId, date: tomorrow(), time: slot.time, partySize: 2, firstName: 'Mina', phone: '0750 123 4567', email: 'mina@example.com', marketingConsent: true, language: 'ar', specialRequest: 'Anniversary dinner' });
    expect(booking.status).toBe(201);
    expect(booking.body.code).toMatch(/^SR-/);
    expect(booking.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(booking.body.status).toBe('confirmed');
    expect((await pub.get(`/api/v1/public/reservations/${booking.body.code}?t=wrong`)).status).toBe(404);
    const ics = await pub.get(`/api/v1/public/reservations/${booking.body.code}/calendar.ics?t=${booking.body.token}`);
    expect(String(ics.body)).toContain('BEGIN:VCALENDAR');
    const cancel = await pub.post(`/api/v1/public/reservations/${booking.body.code}/cancel`, { t: booking.body.token });
    expect(cancel.body.status).toBe('cancelled');
    const consent = await q(getDb(), sql`SELECT marketing_consent, preferred_language FROM guests WHERE phone_normalized = '+9647501234567'`);
    expect(consent[0]).toMatchObject({ marketing_consent: true, preferred_language: 'ar' });
  });

  it('rejects bots (honeypot) and oversized parties', async () => {
    const pub = new ApiClient(app);
    expect((await pub.post('/api/v1/public/reservations', { branchId: r.branchId, date: tomorrow(), time: '20:00', partySize: 2, firstName: 'Bot', phone: '07501112222', website: 'http://spam' })).status).toBe(422);
    expect((await pub.post('/api/v1/public/reservations', { branchId: r.branchId, date: tomorrow(), time: '20:00', partySize: 40, firstName: 'Big', phone: '07501112223' })).status).toBe(422);
  });
});

describe('feedback, analytics and reports', () => {
  it('turns low ratings into complaints and notifies managers', async () => {
    const res = await r.admin.post('/api/v1/reservations', { branchId: r.branchId, date: tomorrow(), time: '12:30', partySize: 2, guest: { firstName: 'Critic' } });
    const token = (await q<{ feedback_token: string }>(getDb(), sql`SELECT feedback_token FROM reservations WHERE id = ${res.body.reservation.id}`))[0]!.feedback_token;
    const pub = new ApiClient(app);
    const fb = await pub.post(`/api/v1/public/feedback/${token}`, { overallRating: 2, serviceRating: 1, comment: 'Waited 40 minutes' });
    expect(fb.body.complaintCreated).toBe(true);
    expect((await pub.post(`/api/v1/public/feedback/${token}`, { overallRating: 5 })).status).toBe(409);
    const complaints = await r.admin.get('/api/v1/complaints');
    const c = complaints.body.find((x: { description: string }) => x.description === 'Waited 40 minutes');
    expect(c.category).toBe('service');
    const upd = await r.admin.patch(`/api/v1/complaints/${c.id}`, { status: 'resolved', resolution: 'Apologised, dessert on the house', compensation: 'Free dessert' });
    expect(upd.body.resolvedAt).toBeTruthy();
  });

  it('computes owner and host dashboards', async () => {
    const owner = await r.admin.get(`/api/v1/analytics/owner?from=${tomorrow()}&to=${tomorrow()}`);
    expect(owner.status).toBe(200);
    expect(owner.body.reservations).toBeGreaterThan(0);
    expect(owner.body).toHaveProperty('occupancyRate');
    const host = await r.admin.get(`/api/v1/analytics/host?branchId=${r.branchId}`);
    expect(host.body.tables.total).toBe(6);
    const waiter = await createStaff(app, r.admin, 'waiter', [r.branchId]);
    expect((await waiter.client.get(`/api/v1/analytics/owner?from=${tomorrow()}&to=${tomorrow()}`)).status).toBe(403);
  });

  it('runs grouped reports and exports CSV / Excel', async () => {
    const def = { dataset: 'reservations', columns: ['code', 'status'], groupBy: ['status'], aggregates: [{ column: 'partySize', fn: 'sum' }], sort: { column: 'count', dir: 'desc' } };
    const run = await r.admin.post('/api/v1/reports/run', def);
    expect(run.status).toBe(200);
    expect(run.body.headers.map((h: { key: string }) => h.key)).toEqual(['status', 'count', 'sum_partySize']);
    const csv = await r.admin.post('/api/v1/reports/export', { ...def, format: 'csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    const xlsx = await r.admin.post('/api/v1/reports/export', { ...def, format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const injected = await r.admin.post('/api/v1/reports/run', { ...def, columns: ['code; DROP TABLE guests'] , groupBy: [] });
    expect(injected.status).toBe(400);
  });

  it('exports every table for data ownership', async () => {
    const res = await r.admin.raw('GET', '/api/v1/export/full');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
  });
});
