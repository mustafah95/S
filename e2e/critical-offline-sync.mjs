// CRITICAL TEST §80 — end to end in a real browser (Chromium) against a real Sofia server and PostgreSQL.
//
//   STEP 1  Server ON:  create a reservation in the UI → verify it is in PostgreSQL.
//   STEP 2  Server OFF: reload the app (served from the service worker), unlock offline, create a guest,
//                       a reservation and a note → operations are stored locally in the outbox.
//   STEP 3  Server ON:  the app detects the server automatically and the sync queue uploads the records.
//   STEP 4  Verify:     guest, reservation and note exist in PostgreSQL, audit log exists, no duplicates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, freshDatabase, Jar, query, SETUP, startServer } from './lib.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = Number(process.env.E2E_PORT ?? 8094);
const BASE = `http://localhost:${PORT}`;
const shots = process.env.E2E_SCREENSHOTS;
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);

const dbUrl = await freshDatabase('sofia_e2e_offline');
const dataDir = mkdtempSync(join(tmpdir(), 'sofia-e2e-data-'));
let server = startServer({ databaseUrl: dbUrl, port: PORT, dataDir });
await server.ready;
const jar = new Jar();
await api(BASE, '/api/v1/sync/ping', { cookies: jar });
const setup = await api(BASE, '/api/v1/setup/complete', { method: 'POST', body: SETUP, cookies: jar });
assert.equal(setup.status, 200, JSON.stringify(setup.body));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const pill = () => page.locator('.status-pill').innerText();
const snap = async (name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

try {
  step('STEP 1 — server ON: sign in and create a reservation in the UI');
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.setItem('sofia.lang', 'en'));
  await page.reload();
  await page.fill('input[autocomplete=username]', SETUP.admin.username);
  await page.fill('input[type=password]', SETUP.admin.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar');
  // Make sure the service worker controls the page so the app shell is available offline.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForSelector('.sidebar');
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
  ok('signed in; service worker installed and controlling the app');
  await page.waitForFunction(() => document.querySelector('.status-pill')?.className.match(/online|degraded/));

  await page.goto(`${BASE}/reservations?new=1`);
  await page.fill('.modal input[placeholder^="Search guest"]', 'Step One');
  await page.click('.modal button:has-text("New guest")');
  await page.fill('.modal .form-grid input >> nth=0', 'Step');
  await page.fill('.modal .form-grid input >> nth=1', 'One');
  await page.fill('.modal input[type=tel]', '07701110001');
  await page.locator('.modal .slot:not([disabled])').last().click();
  await page.click('.modal footer button:has-text("Save")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.status-pill')?.textContent?.includes('waiting'), null, { timeout: 20_000 });
  const step1 = await query(dbUrl, `SELECT r.code, r.origin, g.first_name FROM reservations r JOIN guests g ON g.id = r.guest_id WHERE g.first_name = 'Step'`);
  assert.equal(step1.length, 1, 'reservation from step 1 is in PostgreSQL');
  ok(`reservation ${step1[0].code} stored in PostgreSQL`);
  await snap('1-online');

  step('STEP 2 — server OFF: the app keeps working from the device');
  await server.stop();
  await page.reload(); // app shell comes from the service worker cache
  await page.waitForSelector('form.panel');
  assert.match(await page.locator('form.panel').innerText(), /unlock offline/i);
  ok('app loaded without the server; offline unlock offered');
  await page.fill('input[autocomplete=username]', SETUP.admin.username);
  await page.fill('input[type=password]', SETUP.admin.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar');
  await page.waitForFunction(() => /server_unavailable|offline/.test(document.querySelector('.status-pill')?.className ?? ''));
  assert.match(await page.locator('.banner.danger').innerText(), /Offline Mode/);
  ok(`status: ${await pill()}`);

  await page.click('a.nav[href="/guests"]');
  await page.click('button:has-text("New guest")');
  await page.fill('.modal .form-grid input >> nth=0', 'Offline');
  await page.fill('.modal .form-grid input >> nth=1', 'Guest');
  await page.fill('.modal input[type=tel] >> nth=0', '07709990099');
  await page.click('.modal footer button:has-text("Save")');
  await page.waitForSelector('h1:has-text("Offline Guest")');
  ok('guest created offline');
  await page.fill('textarea[placeholder="Add note"]', 'Prefers the terrace, allergic to nuts');
  await page.click('button:has-text("Add note")');
  await page.waitForSelector('text=Prefers the terrace, allergic to nuts');
  ok('note added offline');
  await page.click('button:has-text("New reservation")');
  await page.waitForSelector('.modal');
  await page.locator('.modal .slot:not([disabled])').last().click();
  await page.fill('.modal textarea', 'Offline booking — anniversary');
  await page.click('.modal footer button:has-text("Save")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.click('a.nav[href="/reservations"]'); // in-app navigation (a full reload offline asks to unlock again)
  await page.waitForSelector('tr:has-text("Offline Guest")');
  const localCode = await page.locator('tr:has-text("Offline Guest") td.code').innerText();
  assert.match(localCode, /^LOCAL-/, 'offline reservation is marked as not yet confirmed');
  ok(`reservation saved on the device as ${localCode} (not yet confirmed by the server)`);
  const pending = await pill();
  assert.match(pending, /3 change/);
  ok(`outbox: ${pending}`);
  assert.equal((await query(dbUrl.replace(/\/[^/]+$/, '/postgres'), "SELECT 1 FROM pg_database WHERE datname = 'sofia_e2e_offline'")).length, 1);
  await snap('2-offline');

  step('STEP 3 — server ON again: automatic detection and synchronisation');
  server = startServer({ databaseUrl: dbUrl, port: PORT, dataDir });
  await server.ready;
  await page.waitForFunction(() => /online|degraded/.test(document.querySelector('.status-pill')?.className ?? '') && !document.querySelector('.status-pill')?.textContent?.includes('waiting'), null, { timeout: 60_000 });
  ok(`status: ${await pill()}`);
  await page.waitForFunction(() => /SR-/.test(document.querySelector('tr:has(td) td.code')?.textContent ?? '') || [...document.querySelectorAll('td.code')].some((td) => td.textContent?.startsWith('SR-') && td.closest('tr')?.textContent?.includes('Offline Guest')), null, { timeout: 30_000 });
  const serverCode = await page.locator('tr:has-text("Offline Guest") td.code').innerText();
  assert.match(serverCode, /^SR-/);
  ok(`device now shows the server reservation number ${serverCode}`);
  await snap('3-synced');

  step('STEP 4 — verify PostgreSQL');
  const guests = await query(dbUrl, `SELECT id FROM guests WHERE first_name = 'Offline' AND last_name = 'Guest'`);
  assert.equal(guests.length, 1, 'exactly one guest (no duplicate)');
  const gid = guests[0].id;
  const res = await query(dbUrl, `SELECT code, notes, origin, client_created_at FROM reservations WHERE guest_id = $1`, [gid]);
  assert.equal(res.length, 1, 'exactly one reservation (no duplicate)');
  assert.equal(res[0].notes, 'Offline booking — anniversary');
  assert.equal(res[0].origin, 'offline');
  assert.ok(res[0].client_created_at, 'client creation time preserved');
  const notes = await query(dbUrl, `SELECT body FROM guest_notes WHERE guest_id = $1`, [gid]);
  assert.deepEqual(notes.map((n) => n.body), ['Prefers the terrace, allergic to nuts']);
  const audit = await query(dbUrl, `SELECT action, device_id FROM audit_logs WHERE entity_id = $1::text OR entity_id = (SELECT id::text FROM reservations WHERE guest_id = $1::uuid) ORDER BY id`, [gid]);
  const actions = audit.map((a) => a.action);
  for (const a of ['guest.create_offline', 'guest.note_add', 'reservation.create']) assert.ok(actions.includes(a), `audit log contains ${a}`);
  assert.ok(audit.every((a) => a.device_id), 'audit entries carry the device id');
  const ops = await query(dbUrl, `SELECT status, count(*)::int AS n FROM sync_operations GROUP BY status`);
  // step 1: guest + reservation; step 2: guest + note + reservation — every operation applied exactly once
  assert.deepEqual(ops, [{ status: 'applied', n: 5 }]);
  ok(`guest, reservation ${res[0].code}, note and audit log (${actions.join(', ')}) present; 5 operations applied once`);

  step('CRITICAL §81 — two devices reserve the same table at the same moment (over HTTP)');
  const tables = (await api(BASE, `/api/v1/tables?branchId=${setup.body.branchId}`, { cookies: jar })).body;
  const t1 = tables.find((t) => t.label === 'T2');
  const date = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const [a, b] = await Promise.all(
    ['A', 'B'].map((d) => api(BASE, '/api/v1/reservations', { method: 'POST', cookies: jar, body: { branchId: setup.body.branchId, date, time: '20:00', partySize: 2, tableIds: [t1.id], guest: { firstName: `Device ${d}` } } })),
  );
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error.message, 'Table no longer available. Please select another table/time.');
  ok(`one booking accepted, the other refused: "${loser.body.error.message}"`);

  assert.deepEqual(errors, [], `no uncaught page errors (${errors.join('; ')})`);
  console.log('\nALL CRITICAL E2E CHECKS PASSED');
} catch (err) {
  await snap('failure').catch(() => undefined);
  console.error('\nE2E FAILED:', err.message);
  console.error(server.log().slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
