import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closeDb, getDb, q, sql } from '../src/db/pool.js';
import { processOutbox } from '../src/modules/notifications/service.js';
import { isAllowedPushEndpoint } from '../src/integrations/push.js';
import { ApiClient, setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

/**
 * Web Push end to end against a local stand-in for a browser push service. The test plays the browser: it owns the
 * subscription's private key, so it can decrypt what the server sent (RFC 8291) and check the VAPID signature
 * (RFC 8292) independently of the library the server uses.
 */

interface Browser {
  ecdh: ECDH;
  auth: Buffer;
  keys: { p256dh: string; auth: string };
}
function newBrowser(): Browser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

function decrypt(body: Buffer, b: Browser): Record<string, string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverKey = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = b.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, b.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2); // last-record padding delimiter
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

function verifyVapid(authorization: string, audience: string, expectedPublicKey: string): Record<string, unknown> {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authorization);
  expect(m).toBeTruthy();
  const [, jwt, k] = m!;
  expect(k).toBe(expectedPublicKey);
  const [h, p, s] = jwt!.split('.');
  const point = Buffer.from(k!, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
  expect(header).toMatchObject({ typ: 'JWT', alg: 'ES256' });
  expect(claims.aud).toBe(audience);
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  expect(String(claims.sub)).toMatch(/^(mailto:|https:)/);
  return claims;
}

let app: FastifyInstance;
let r: Restaurant;
let service: Server;
let origin: string;
const received: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
  service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url?.startsWith('/gone/')) return res.writeHead(410).end();
      if (req.url?.startsWith('/redirect/')) return res.writeHead(302, { location: `${origin}/internal/admin` }).end();
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
});
afterAll(async () => {
  service.close();
  await app.close();
  await closeDb();
});

async function book(pub: ApiClient, firstName: string, phone: string) {
  const avail = await pub.get(`/api/v1/public/availability?branch=${r.branchId}&date=${tomorrow()}&partySize=2`);
  const slot = avail.body.slots.find((s: { available: boolean }) => s.available);
  const res = await pub.post('/api/v1/public/reservations', { branchId: r.branchId, date: tomorrow(), time: slot.time, partySize: 2, firstName, phone, language: 'ar' });
  expect(res.status).toBe(201);
  return res.body as { code: string; token: string };
}

describe('guest Web Push notifications', () => {
  const a = newBrowser();
  const b = newBrowser();
  let booking: { code: string; token: string };
  let guestId: string;
  let publicKey: string;

  it('only accepts browser push services (no requests into the restaurant network)', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QAbc')).toBe(true);
    expect(isAllowedPushEndpoint('https://db5p.notify.windows.com/w/?token=abc')).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com:8443/x', 'https://evil-fcm.googleapis.com.example.com/x', 'https://192.168.1.10/x', 'http://10.0.0.5/x', 'https://user:pw@fcm.googleapis.com/x', 'file:///etc/passwd', 'not a url']) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });

  it('is off until the restaurant enables the push channel', async () => {
    const pub = new ApiClient(app);
    expect((await pub.get('/api/v1/public/push/config')).body).toEqual({ enabled: false, publicKey: null });
    booking = await book(pub, 'Rana', '07801112233');
    const res = await pub.post('/api/v1/public/push/subscribe', { code: booking.code, t: booking.token, subscription: { endpoint: `${origin}/ok/a`, keys: a.keys } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('push_disabled');
  });

  it('lets a guest subscribe from the confirmation page with the reservation token', async () => {
    await r.admin.put('/api/v1/settings/notifications', { value: { channelsEnabled: { whatsapp: false, sms: false, email: false, push: true }, preferredTransactionalChannel: 'push' } });
    const pub = new ApiClient(app);
    const cfg = await pub.get('/api/v1/public/push/config');
    expect(cfg.body.enabled).toBe(true);
    publicKey = cfg.body.publicKey;
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    expect((await pub.get('/api/v1/public/push/config')).body.publicKey).toBe(publicKey); // generated once

    const sub = (endpoint: string, keys = a.keys, t = booking.token, offers = false) =>
      pub.post('/api/v1/public/push/subscribe', { code: booking.code, t, subscription: { endpoint, keys }, offers, language: 'ar' });
    expect((await sub(`${origin}/ok/a`, a.keys, 'wrong-token')).status).toBe(404);
    expect((await sub('https://evil.example.com/push')).body.error.code).toBe('push_endpoint_not_allowed');
    expect((await sub('http://10.0.0.5:5432/')).body.error.code).toBe('push_endpoint_not_allowed');
    expect((await sub(`${origin}/ok/a`, { p256dh: randomBytes(65).toString('base64url'), auth: a.keys.auth })).body.error.code).toBe('push_keys_invalid');

    expect((await sub(`${origin}/ok/a`, a.keys, booking.token, true)).body).toEqual({ subscribed: true, offers: true });
    expect((await sub(`${origin}/gone/b`, b.keys)).status).toBe(200);

    const [g] = await q<{ id: string; marketing_consent: boolean; consent_channels: Record<string, boolean> }>(getDb(), sql`SELECT g.id, g.marketing_consent, g.consent_channels FROM guests g JOIN reservations r ON r.guest_id = g.id WHERE r.code = ${booking.code}`);
    guestId = g!.id;
    expect(g!.marketing_consent).toBe(true);
    expect(g!.consent_channels.push).toBe(true);
    const audit = await q<{ action: string }>(getDb(), sql`SELECT action FROM audit_logs WHERE entity_id = ${guestId} ORDER BY id`);
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['guest.push_subscribe', 'guest.consent_push_marketing']));
    const profile = await r.admin.get(`/api/v1/guests/${guestId}/profile`);
    expect(profile.body.push.devices).toBe(2);
    expect(JSON.stringify(profile.body)).not.toContain('/ok/a'); // staff never see endpoints
  });

  it('delivers reservation messages encrypted and signed, and forgets browsers that unsubscribed', async () => {
    const pub = new ApiClient(app);
    const cancel = await pub.post(`/api/v1/public/reservations/${booking.code}/cancel`, { t: booking.token });
    expect(cancel.body.status).toBe('cancelled');
    const [row] = await q<{ channel: string; recipient: string; payload: { push: { url: string } } }>(getDb(), sql`SELECT channel, recipient, payload FROM notification_outbox WHERE template_key = 'reservation_cancelled' AND guest_id = ${guestId}`);
    expect(row).toMatchObject({ channel: 'push', recipient: guestId });
    expect(row!.payload.push.url).toBe(`/r/${booking.code}?t=${booking.token}`);

    received.length = 0;
    const stats = await processOutbox(50);
    expect(stats.sent).toBeGreaterThanOrEqual(1);
    const toA = received.find((x) => x.path === '/ok/a')!;
    expect(received.some((x) => x.path === '/gone/b')).toBe(true);
    expect(toA.headers['content-encoding']).toBe('aes128gcm');
    expect(toA.headers.ttl).toBe('86400');
    verifyVapid(String(toA.headers.authorization), origin, publicKey);
    expect(toA.body.toString('utf8')).not.toContain(booking.code); // encrypted on the wire
    const msg = decrypt(toA.body, a);
    expect(msg).toMatchObject({ title: 'تم إلغاء الحجز', url: `/r/${booking.code}?t=${booking.token}`, lang: 'ar', dir: 'rtl' });
    expect(msg.body).toContain(booking.code);

    const subs = await q<{ endpoint: string; revoked_at: Date | null; revoke_reason: string | null; last_success_at: Date | null }>(getDb(), sql`SELECT endpoint, revoked_at, revoke_reason, last_success_at FROM guest_push_subscriptions WHERE guest_id = ${guestId} ORDER BY endpoint DESC`);
    expect(subs.find((s) => s.endpoint.endsWith('/ok/a'))).toMatchObject({ revoked_at: null });
    expect(subs.find((s) => s.endpoint.endsWith('/ok/a'))!.last_success_at).toBeTruthy();
    expect(subs.find((s) => s.endpoint.endsWith('/gone/b'))).toMatchObject({ revoke_reason: 'gone_410' });
    const [out] = await q<{ status: string; provider_message_id: string }>(getDb(), sql`SELECT status, provider_message_id FROM notification_outbox WHERE template_key = 'reservation_cancelled' AND guest_id = ${guestId}`);
    expect(out).toEqual({ status: 'sent', provider_message_id: 'web-push 1/2' });
  });

  it('sends push campaigns only to guests who opted in to offers on that channel', async () => {
    const pub = new ApiClient(app);
    const other = await book(pub, 'Sami', '07801112244');
    const c = newBrowser();
    expect((await pub.post('/api/v1/public/push/subscribe', { code: other.code, t: other.token, subscription: { endpoint: `${origin}/ok/c`, keys: c.keys }, offers: false })).status).toBe(200);
    await getDb().execute(sql`UPDATE guests SET vip_level = 'gold' WHERE id IN (SELECT guest_id FROM reservations WHERE code IN (${booking.code}, ${other.code}))`);
    const campaign = await r.admin.post('/api/v1/campaigns', { name: 'Jazz night', segmentKey: 'vip', channel: 'push', body: 'Live jazz this Friday — book your table!' });
    expect((await r.admin.post(`/api/v1/campaigns/${campaign.body.id}/send`)).body).toEqual({ queued: 1, skipped: 1 });
    received.length = 0;
    await processOutbox(50);
    expect(received.map((x) => x.path)).toEqual(['/ok/a']);
    expect(decrypt(received[0]!.body, a).body).toContain('Live jazz this Friday');
  });

  it('never follows redirects from a push service', async () => {
    const pub = new ApiClient(app);
    const d = newBrowser();
    const other = await book(pub, 'Laith', '07801112255');
    await pub.post('/api/v1/public/push/subscribe', { code: other.code, t: other.token, subscription: { endpoint: `${origin}/redirect/d`, keys: d.keys } });
    await pub.post(`/api/v1/public/reservations/${other.code}/cancel`, { t: other.token });
    received.length = 0;
    await processOutbox(50);
    expect(received.map((x) => x.path)).toEqual(['/redirect/d']);
    const [out] = await q<{ status: string; last_error: string }>(getDb(), sql`SELECT o.status, o.last_error FROM notification_outbox o JOIN reservations r ON r.id = o.reservation_id WHERE r.code = ${other.code} AND o.template_key = 'reservation_cancelled'`);
    expect(out!.status).toBe('pending'); // retried later, never redirected
    expect(out!.last_error).toContain('302');
  });

  it('renews, unsubscribes and removes subscriptions when the guest is anonymised', async () => {
    const pub = new ApiClient(app);
    const e = newBrowser();
    expect((await pub.post('/api/v1/public/push/renew', { oldEndpoint: `${origin}/ok/a`, subscription: { endpoint: `${origin}/ok/a2`, keys: e.keys } })).body).toEqual({ renewed: true });
    expect((await pub.post('/api/v1/public/push/renew', { oldEndpoint: `${origin}/unknown`, subscription: { endpoint: `${origin}/ok/x`, keys: e.keys } })).body).toEqual({ renewed: false });
    expect((await pub.post('/api/v1/public/push/unsubscribe', { endpoint: `${origin}/ok/a2` })).body).toEqual({ ok: true });
    const [g] = await q<{ consent_channels: Record<string, boolean> }>(getDb(), sql`SELECT consent_channels FROM guests WHERE id = ${guestId}`);
    expect(g!.consent_channels.push).toBe(false); // last browser gone → no push marketing
    expect((await r.admin.get(`/api/v1/guests/${guestId}/profile`)).body.push.devices).toBe(0);

    const again = await book(pub, 'Rana', '07801112233');
    await pub.post('/api/v1/public/push/subscribe', { code: again.code, t: again.token, subscription: { endpoint: `${origin}/ok/a3`, keys: a.keys } });
    const gid = (await q<{ guest_id: string }>(getDb(), sql`SELECT guest_id FROM reservations WHERE code = ${again.code}`))[0]!.guest_id;
    expect((await r.admin.post(`/api/v1/guests/${gid}/anonymize`)).status).toBe(200);
    expect(await q(getDb(), sql`SELECT 1 FROM guest_push_subscriptions WHERE guest_id = ${gid}`)).toHaveLength(0);
  });
});
