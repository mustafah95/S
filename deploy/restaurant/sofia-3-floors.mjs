#!/usr/bin/env node
/**
 * Sofia's Resto-Lounge — first-run setup for the restaurant on three floors:
 *   1st floor main hall (A1–A14), 2nd floor lounge with VIP corner (B1–B10, VIP1), 3rd floor rooftop (R1–R14).
 * Completes the setup wizard, lays out the three floor plans and adds combinations of neighbouring tables.
 *
 * Run on the server right after installation (Node.js is installed by the installer):
 *   "C:\Program Files\nodejs\node.exe" sofia-3-floors.mjs --token <setup token> [--password <owner password>] [--url http://127.0.0.1:8080]
 *
 * The setup token is shown at the end of the installation (and is SOFIA_SETUP_TOKEN in C:\Sofia\config\sofia.env).
 * Without --password a strong owner password is generated and printed once. Only works before the setup wizard
 * has been completed. No dependencies besides Node.js 18+.
 */
import { randomBytes } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = arg('token');
const username = arg('username', 'owner');
const password = arg('password', `Sofia-${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}-26`);
if (!token) {
  console.error('Usage: node sofia-3-floors.mjs --token <setup token> [--password <owner password>] [--url http://127.0.0.1:8080]');
  process.exit(2);
}

// ---- minimal HTTP client with cookies + CSRF (the API's browser protections) ----------------------------------
const cookies = new Map();
async function call(method, path, body) {
  const headers = { 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (cookies.has('sofia_csrf')) headers['x-csrf-token'] = cookies.get('sofia_csrf');
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error?.message ?? text.slice(0, 300)}`);
  return data;
}

// ---- floors, tables and floor-plan positions ---------------------------------------------------------------------
const T = (areaKey, label, capacity, minCapacity, maxCapacity, shape, posX, posY, width, height, isVip = false) => ({ areaKey, label, capacity, minCapacity, maxCapacity, shape, isVip, layout: { posX, posY, width, height, rotation: 0 } });
const TABLES = [
  // 1st floor — main hall (60 seats)
  T('floor1', 'A1', 2, 1, 2, 'round', 80, 50, 70, 70), T('floor1', 'A2', 2, 1, 2, 'round', 250, 50, 70, 70),
  T('floor1', 'A3', 2, 1, 2, 'round', 420, 50, 70, 70), T('floor1', 'A4', 2, 1, 2, 'round', 590, 50, 70, 70),
  T('floor1', 'A5', 4, 2, 4, 'square', 80, 200, 90, 90), T('floor1', 'A6', 4, 2, 4, 'square', 270, 200, 90, 90),
  T('floor1', 'A7', 4, 2, 4, 'square', 460, 200, 90, 90), T('floor1', 'A8', 4, 2, 4, 'square', 80, 370, 90, 90),
  T('floor1', 'A9', 4, 2, 4, 'square', 270, 370, 90, 90), T('floor1', 'A10', 4, 2, 4, 'square', 460, 370, 90, 90),
  T('floor1', 'A11', 6, 3, 6, 'rectangle', 720, 200, 160, 80), T('floor1', 'A12', 6, 3, 6, 'rectangle', 720, 370, 160, 80),
  T('floor1', 'A13', 8, 5, 8, 'rectangle', 940, 200, 200, 90), T('floor1', 'A14', 8, 5, 8, 'rectangle', 940, 370, 200, 90),
  // 2nd floor — lounge (58 seats incl. VIP corner)
  T('floor2', 'B1', 4, 2, 4, 'sofa', 140, 180, 130, 80), T('floor2', 'B2', 4, 2, 4, 'sofa', 320, 180, 130, 80),
  T('floor2', 'B3', 4, 2, 4, 'sofa', 500, 180, 130, 80), T('floor2', 'B4', 4, 2, 4, 'sofa', 140, 330, 130, 80),
  T('floor2', 'B5', 4, 2, 4, 'sofa', 320, 330, 130, 80), T('floor2', 'B6', 4, 2, 4, 'sofa', 500, 330, 130, 80),
  T('floor2', 'B7', 6, 3, 6, 'booth', 720, 200, 140, 90), T('floor2', 'B8', 6, 3, 6, 'booth', 900, 200, 140, 90),
  T('floor2', 'B9', 6, 3, 6, 'booth', 720, 360, 140, 90), T('floor2', 'B10', 6, 3, 6, 'booth', 900, 360, 140, 90),
  T('floor2', 'VIP1', 10, 6, 12, 'rectangle', 170, 570, 240, 100, true),
  // 3rd floor — rooftop (48 seats)
  T('roof', 'R1', 2, 1, 2, 'round', 80, 50, 70, 70), T('roof', 'R2', 2, 1, 2, 'round', 230, 50, 70, 70),
  T('roof', 'R3', 2, 1, 2, 'round', 380, 50, 70, 70), T('roof', 'R4', 2, 1, 2, 'round', 530, 50, 70, 70),
  T('roof', 'R5', 2, 1, 2, 'round', 680, 50, 70, 70), T('roof', 'R6', 2, 1, 2, 'round', 830, 50, 70, 70),
  T('roof', 'R7', 4, 2, 4, 'sofa', 100, 200, 130, 80), T('roof', 'R8', 4, 2, 4, 'sofa', 300, 200, 130, 80),
  T('roof', 'R9', 4, 2, 4, 'sofa', 500, 200, 130, 80), T('roof', 'R10', 4, 2, 4, 'sofa', 100, 360, 130, 80),
  T('roof', 'R11', 4, 2, 4, 'sofa', 300, 360, 130, 80), T('roof', 'R12', 4, 2, 4, 'sofa', 500, 360, 130, 80),
  T('roof', 'R13', 6, 3, 6, 'sofa', 720, 220, 170, 100), T('roof', 'R14', 6, 3, 6, 'sofa', 720, 380, 170, 100),
];
const E = (id, kind, x, y, width, height, label) => ({ id, kind, x, y, width, height, rotation: 0, ...(label ? { label } : {}) });
const PLANS = {
  floor1: [
    E('window', 'window', 30, 8, 1140, 14, 'واجهة زجاجية'), E('coffee', 'bar', 20, 690, 260, 60, 'ركن القهوة والعصائر'),
    E('reception', 'zone', 500, 680, 180, 70, 'الاستقبال'), E('door', 'door', 540, 780, 100, 16, 'المدخل الرئيسي'),
    E('stairs', 'zone', 1000, 560, 180, 210, 'الدرج ↑ الطابق الثاني'), E('plant1', 'plant', 760, 60, 40, 40), E('plant2', 'plant', 1120, 60, 40, 40),
  ],
  floor2: [
    E('window', 'window', 30, 8, 1140, 14, 'واجهة زجاجية'), E('bar', 'bar', 20, 140, 70, 360, 'البار'),
    E('music', 'stage', 720, 40, 320, 110, 'ركن الموسيقى'), E('vipzone', 'zone', 120, 530, 340, 180, 'ركن كبار الضيوف VIP'),
    E('stairs', 'zone', 1000, 560, 180, 210, 'الدرج ↑ الروف توب'), E('plant1', 'plant', 1100, 200, 40, 40),
  ],
  roof: [
    E('railing-top', 'wall', 20, 8, 1160, 10, 'سياج — إطلالة على المدينة'), E('railing-left', 'wall', 20, 18, 10, 760),
    E('rooftop-bar', 'bar', 1060, 200, 100, 340, 'بار الروف'), E('dj', 'stage', 60, 640, 240, 120, 'منصة الموسيقى'),
    E('stairs', 'zone', 1000, 580, 180, 190, 'الدرج ↓'), E('plant1', 'plant', 960, 40, 40, 40), E('plant2', 'plant', 1100, 40, 40, 40), E('plant3', 'plant', 640, 520, 40, 40),
  ],
};
const AREAS = [
  { key: 'floor1', name: '1st Floor — Main Hall', nameAr: 'الطابق الأول — الصالة الرئيسية', kind: 'indoor' },
  { key: 'floor2', name: '2nd Floor — Lounge', nameAr: 'الطابق الثاني — اللاونج', kind: 'lounge' },
  { key: 'roof', name: '3rd Floor — Rooftop', nameAr: 'الطابق الثالث — روف توب', kind: 'terrace' },
];
const COMBOS = [['A5', 'A6'], ['A8', 'A9'], ['A11', 'A12'], ['A13', 'A14'], ['B1', 'B2'], ['B4', 'B5'], ['B7', 'B8'], ['B9', 'B10'], ['R7', 'R8'], ['R10', 'R11'], ['R13', 'R14']];

// ---- run -----------------------------------------------------------------------------------------------------------
async function main() {
  await call('GET', '/api/v1/sync/ping');
  const status = await call('GET', '/api/v1/setup/status');
  if (status.completed) {
    console.error('The setup wizard was already completed on this server; nothing was changed.');
    process.exit(1);
  }
  const setup = await call('POST', '/api/v1/setup/complete', {
    setupToken: token,
    restaurant: { name: "Sofia's Resto-Lounge", nameAr: 'صوفيا ريستو-لاونج', phone: '', email: '' },
    branch: { code: 'MAIN', name: "Sofia's Resto-Lounge", nameAr: 'صوفيا ريستو-لاونج', address: '', phone: '', timezone: 'Asia/Baghdad' },
    currency: 'IQD',
    secondaryCurrency: 'USD',
    language: 'ar',
    operatingHours: Array.from({ length: 7 }, () => [{ open: '12:00', close: '01:00' }]),
    areas: AREAS,
    tables: TABLES.map(({ layout, ...t }) => t),
    admin: { username, displayName: 'مالك المطعم', email: '', password },
    reservation: { slotIntervalMinutes: 30, defaultDurationMinutes: 120, bufferMinutes: 15, maxAdvanceDays: 60, onlineBookingEnabled: true, depositEnabled: false },
    pos: { provider: 'none', baseUrl: '' },
    backup: { enabled: true, timeOfDay: '04:00', retentionDays: 30, externalDirectory: '' },
    publicBaseUrl: '',
  });
  const branchId = setup.branchId;
  console.log('✓ setup wizard completed');
  await call('POST', '/api/v1/auth/login', { username, password });

  const areas = await call('GET', `/api/v1/areas?branchId=${branchId}`);
  for (const a of areas) {
    const def = AREAS.find((x) => x.nameAr === a.nameAr || x.name === a.name);
    if (def) await call('PATCH', `/api/v1/areas/${a.id}`, { sortOrder: AREAS.indexOf(def), floorPlan: { width: 1200, height: 800, elements: PLANS[def.key] } });
  }
  const tables = await call('GET', `/api/v1/tables?branchId=${branchId}`);
  const layout = Object.fromEntries(TABLES.map((t) => [t.label, t.layout]));
  await call('PUT', '/api/v1/tables/layout', { tables: tables.filter((t) => layout[t.label]).map((t) => ({ id: t.id, ...layout[t.label] })) });
  console.log('✓ floor plans laid out');
  const byLabel = Object.fromEntries(tables.map((t) => [t.label, t]));
  for (const labels of COMBOS) {
    const ts = labels.map((l) => byLabel[l]);
    await call('POST', '/api/v1/table-combinations', {
      branchId,
      name: labels.join(' + '),
      tableIds: ts.map((t) => t.id),
      minCapacity: Math.max(...ts.map((t) => t.maxCapacity)) + 1,
      maxCapacity: ts.reduce((s, t) => s + t.maxCapacity, 0),
    });
  }
  console.log(`✓ ${COMBOS.length} table combinations for larger groups`);
  const seats = tables.reduce((s, t) => s + t.capacity, 0);
  console.log(`\nSofia's Resto-Lounge is ready: 3 floors, ${tables.length} tables, ${seats} seats.`);
  console.log(`Sign in at ${BASE}  —  username: ${username}${arg('password') ? '' : `  password: ${password}  (change it after the first sign-in)`}`);
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
