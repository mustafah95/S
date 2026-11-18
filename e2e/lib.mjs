// Shared helpers for end-to-end runs: a real Sofia server process on a fresh PostgreSQL database.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from '../apps/server/node_modules/pg/lib/index.js';

export const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_URL = process.env.SOFIA_TEST_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';

export async function freshDatabase(name) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function query(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export function startServer({ databaseUrl, port, dataDir = mkdtempSync(join(tmpdir(), 'sofia-e2e-')) }) {
  const child = spawn(join(ROOT, 'apps/server/node_modules/.bin/tsx'), [join(ROOT, 'apps/server/src/main.ts'), 'api'], {
    cwd: join(ROOT, 'apps/server'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      DATABASE_OWNER_URL: databaseUrl,
      SOFIA_SETUP_TOKEN: 'e2e-setup-token',
      SOFIA_DATA_DIR: dataDir,
      SOFIA_LOG_LEVEL: 'warn',
      SOFIA_EMBEDDED_WORKER: 'false',
      SOFIA_LOGIN_RATE_LIMIT: '1000',
      SOFIA_RATE_LIMIT_MAX: '100000',
      SOFIA_WEB_DIR: join(ROOT, 'apps/web/dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health/ready`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null) throw new Error(`Server exited:\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Server did not start:\n${log}`);
  })();
  return {
    child,
    ready,
    log: () => log,
    stop: () =>
      new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once('exit', () => res());
        child.kill('SIGKILL');
      }),
  };
}

export async function api(base, path, { method = 'GET', body, cookies } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies ? { cookie: cookies.header(), 'x-csrf-token': cookies.get('sofia_csrf') ?? '' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (cookies) for (const c of res.headers.getSetCookie()) cookies.set(c);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export class Jar {
  map = new Map();
  set(raw) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    this.map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  get(k) {
    return this.map.get(k);
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export const SETUP = {
  setupToken: 'e2e-setup-token',
  restaurant: { name: "Sofia's Resto-Lounge", nameAr: 'صوفيا ريستو-لاونج', phone: '+9647700000000', email: '' },
  branch: { code: 'MAIN', name: 'Main Branch', nameAr: 'الفرع الرئيسي', address: 'Baghdad, Al-Mansour', phone: '+9647700000000', timezone: 'Asia/Baghdad' },
  currency: 'IQD',
  secondaryCurrency: 'USD',
  language: 'en',
  operatingHours: Array.from({ length: 7 }, () => [{ open: '00:00', close: '23:59' }]),
  areas: [
    { key: 'hall', name: 'Main Hall', nameAr: 'الصالة الرئيسية', kind: 'indoor' },
    { key: 'lounge', name: 'Lounge', nameAr: 'اللاونج', kind: 'lounge' },
    { key: 'vip', name: 'VIP Room', nameAr: 'غرفة كبار الشخصيات', kind: 'vip' },
  ],
  tables: [
    ...Array.from({ length: 8 }, (_, i) => ({ areaKey: 'hall', label: `T${i + 1}`, capacity: i % 3 === 0 ? 2 : 4, shape: i % 3 === 0 ? 'round' : 'square' })),
    ...Array.from({ length: 4 }, (_, i) => ({ areaKey: 'lounge', label: `L${i + 1}`, capacity: 6, shape: 'sofa' })),
    { areaKey: 'vip', label: 'V1', capacity: 10, shape: 'rectangle', isVip: true },
  ],
  admin: { username: 'owner', displayName: 'Sofia Owner', email: null, password: 'Resto-Lounge-2026!' },
  reservation: { slotIntervalMinutes: 30, defaultDurationMinutes: 120, bufferMinutes: 15, maxAdvanceDays: 60, onlineBookingEnabled: true, depositEnabled: false },
  pos: { provider: 'none', baseUrl: '' },
  backup: { enabled: false, timeOfDay: '04:00', retentionDays: 30, externalDirectory: '' },
  publicBaseUrl: '',
};
