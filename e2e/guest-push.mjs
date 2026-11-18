// Guest Web Push in a real browser (Chromium): a guest books online, turns notifications on from the confirmation
// page, the subscription reaches PostgreSQL, and the guest service worker displays a pushed reservation update.
//
// Headless Chromium has no connection to a real push service, so two things are simulated: the push service hands
// the browser a subscription (PushManager.subscribe is stubbed with real P-256 keys), and the decrypted message is
// delivered to the service worker through the DevTools protocol — exactly what the browser does after decryption.
// Encryption and VAPID signing are verified separately in apps/server/test/push.test.ts.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { api, freshDatabase, Jar, query, SETUP, startServer } from './lib.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = Number(process.env.E2E_PORT ?? 8095);
const BASE = `http://localhost:${PORT}`;
const shots = process.env.E2E_SCREENSHOTS;
const ok = (s) => console.log(`  ✓ ${s}`);
const BOOK_LABEL = 'تأكيد الحجز';

const dbUrl = await freshDatabase('sofia_e2e_push');
const server = startServer({ databaseUrl: dbUrl, port: PORT });
await server.ready;
const jar = new Jar();
await api(BASE, '/api/v1/sync/ping', { cookies: jar });
const setup = await api(BASE, '/api/v1/setup/complete', { method: 'POST', body: SETUP, cookies: jar });
assert.equal(setup.status, 200, JSON.stringify(setup.body));
await api(BASE, '/api/v1/auth/login', { method: 'POST', body: { username: SETUP.admin.username, password: SETUP.admin.password }, cookies: jar });
const enable = await api(BASE, '/api/v1/settings/notifications', { method: 'PUT', cookies: jar, body: { value: { channelsEnabled: { whatsapp: false, sms: false, email: false, push: true }, preferredTransactionalChannel: 'push' } } });
assert.equal(enable.status, 200, JSON.stringify(enable.body));

// The "push service" subscription the browser would receive.
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const fakeSub = { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${randomBytes(6).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };

// The headless shell reports Notification.permission as "denied"; the full Chromium build supports notifications.
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ar' });
await context.grantPermissions(['notifications'], { origin: BASE });
await context.addInitScript((sub) => {
  let current = null;
  const make = () => ({ endpoint: sub.endpoint, toJSON: () => sub, unsubscribe: async () => ((current = null), true) });
  PushManager.prototype.subscribe = async function () {
    current = make();
    return current;
  };
  PushManager.prototype.getSubscription = async function () {
    return current;
  };
}, fakeSub);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  console.log('\n▶ guest books online and turns notifications on');
  await page.goto(`${BASE}/book/MAIN`);
  await page.waitForSelector('.slot-grid .slot:not([disabled])');
  await page.locator('.slot-grid .slot:not([disabled])').last().click();
  await page.fill('input[autocomplete="given-name"]', 'Zainab');
  await page.fill('input[type=tel]', '07805556677');
  await page.locator('button.btn').filter({ hasText: BOOK_LABEL }).click();
  await page.waitForSelector('.code:has-text("SR-")');
  const code = (await page.locator('.code').first().innerText()).trim();
  ok(`reservation ${code} confirmed`);
  await page.waitForSelector('button:has-text("تفعيل الإشعارات")');
  shots && (await page.screenshot({ path: join(shots, 'push-off.png'), fullPage: true }));
  await page.locator('label.check:has-text("العروض")').click();
  await page.click('button:has-text("تفعيل الإشعارات")');
  await page.waitForSelector('text=الإشعارات مفعّلة على هذا الجهاز');
  shots && (await page.screenshot({ path: join(shots, 'push-on.png'), fullPage: true }));
  const subs = await query(dbUrl, `SELECT s.endpoint, s.language, s.revoked_at, g.first_name, g.marketing_consent, g.consent_channels
                                   FROM guest_push_subscriptions s JOIN guests g ON g.id = s.guest_id`);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, fakeSub.endpoint);
  assert.equal(subs[0].first_name, 'Zainab');
  assert.equal(subs[0].language, 'ar');
  assert.equal(subs[0].marketing_consent, true);
  assert.equal(subs[0].consent_channels.push, true);
  ok('subscription stored for the guest, with consent for offers on the push channel');

  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/r/');
    return r ? { scope: r.scope, active: !!r.active } : null;
  });
  assert.deepEqual(reg, { scope: `${BASE}/r/`, active: true });
  const staff = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
  assert.ok(!staff.includes(`${BASE}/`), 'the staff app service worker is not installed by the guest page');
  ok('guest service worker active with scope /r/ only');

  console.log('\n▶ a reservation update arrives as a notification');
  const cdp = await context.newCDPSession(page);
  const registrations = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; i < 20 && !registrations.some((r) => r.scopeURL === `${BASE}/r/`); i++) await page.waitForTimeout(100);
  const { registrationId } = registrations.find((r) => r.scopeURL === `${BASE}/r/`);
  const message = { title: 'تم تعديل موعد الحجز', body: `الموعد الجديد: 21:00 · 2 أشخاص · ${code}`, url: `/r/${code}?t=x`, tag: code, lang: 'ar', dir: 'rtl', icon: '/brand/sofia-icon-192.png' };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId, data: JSON.stringify(message) });
  let shown = [];
  for (let i = 0; i < 30 && !shown.length; i++) {
    await page.waitForTimeout(100);
    shown = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/r/')).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, dir: n.dir, data: n.data })));
  }
  assert.equal(shown.length, 1, 'notification displayed');
  assert.deepEqual(shown[0], { title: message.title, body: message.body, tag: code, dir: 'rtl', data: { url: message.url } });
  ok(`notification shown: "${shown[0].title}" — ${shown[0].body}`);

  console.log('\n▶ guest turns notifications off');
  await page.click('button:has-text("إيقاف")');
  await page.waitForSelector('button:has-text("تفعيل الإشعارات")');
  const after = await query(dbUrl, `SELECT s.revoke_reason, g.consent_channels FROM guest_push_subscriptions s JOIN guests g ON g.id = s.guest_id`);
  assert.equal(after[0].revoke_reason, 'guest');
  assert.equal(after[0].consent_channels.push, false);
  ok('subscription revoked and push marketing consent withdrawn');

  assert.deepEqual(errors, [], errors.join('; '));
  console.log('\nGUEST PUSH E2E PASSED');
} catch (err) {
  shots && (await page.screenshot({ path: join(shots, 'push-failure.png'), fullPage: true }).catch(() => undefined));
  console.error('\nE2E FAILED:', err.message);
  console.error(server.log().slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
