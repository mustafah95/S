import type { FastifyInstance } from 'fastify';
import { addDays, businessDateOf, uuidv7 } from '@sofia/shared';
import { buildApp } from '../src/app.js';
import { prepareDatabase } from '../src/bootstrap.js';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

export class ApiClient {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly app: FastifyInstance,
    readonly deviceId: string = uuidv7(),
  ) {}

  private store(setCookie: string | string[] | undefined) {
    for (const c of ([] as string[]).concat(setCookie ?? [])) {
      const [pair, ...attrs] = c.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx).trim();
      const value = pair!.slice(idx + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async raw<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await this.app.inject({
      method: method as never,
      url,
      payload: body === undefined ? undefined : (body as never),
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.jar.get('sofia_csrf') ? { 'x-csrf-token': this.jar.get('sofia_csrf')! } : {}),
        'x-sofia-device-id': this.deviceId,
        ...headers,
      },
    });
    this.store(res.headers['set-cookie']);
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      /* non-JSON */
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as never };
  }

  async call<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    if (!this.jar.has('sofia_csrf')) await this.raw('GET', '/api/v1/sync/ping');
    return this.raw<T>(method, url, body, headers);
  }

  get = <T = any>(url: string) => this.call<T>('GET', url);
  post = <T = any>(url: string, body?: unknown) => this.call<T>('POST', url, body ?? {});
  patch = <T = any>(url: string, body: unknown) => this.call<T>('PATCH', url, body);
  put = <T = any>(url: string, body: unknown) => this.call<T>('PUT', url, body);
  del = <T = any>(url: string) => this.call<T>('DELETE', url);

  async login(username: string, password: string): Promise<ApiResponse> {
    const r = await this.post('/api/v1/auth/login', { username, password, deviceId: this.deviceId });
    return r;
  }
}

export async function startTestServer(): Promise<FastifyInstance> {
  await prepareDatabase(() => undefined);
  const app = await buildApp({ logger: false, serveWeb: false });
  await app.ready();
  return app;
}

export const ADMIN = { username: 'owner', password: 'Resto-Lounge-2026!' };
export const TZ = 'Asia/Baghdad';

/** A business date safely in the future (tomorrow in Baghdad). */
export function tomorrow(): string {
  return addDays(businessDateOf(new Date(), TZ), 1);
}

export function setupPayload() {
  const allWeek = Array.from({ length: 7 }, () => [{ open: '12:00', close: '01:00' }]);
  return {
    setupToken: 'test-setup-token',
    restaurant: { name: "Sofia's Resto-Lounge", nameAr: 'صوفيا', phone: '+9647700000000', email: 'info@example.com' },
    branch: { code: 'MAIN', name: 'Main Branch', nameAr: 'الفرع الرئيسي', address: 'Baghdad', phone: '+9647700000000', timezone: TZ },
    currency: 'IQD',
    secondaryCurrency: 'USD',
    language: 'en',
    operatingHours: allWeek,
    areas: [
      { key: 'hall', name: 'Main Hall', nameAr: 'الصالة', kind: 'indoor' },
      { key: 'terrace', name: 'Terrace', nameAr: 'التراس', kind: 'terrace' },
      { key: 'vip', name: 'VIP Lounge', nameAr: 'كبار الشخصيات', kind: 'vip' },
    ],
    tables: [
      { areaKey: 'hall', label: 'T1', capacity: 2, shape: 'round' },
      { areaKey: 'hall', label: 'T2', capacity: 4, shape: 'square' },
      { areaKey: 'hall', label: 'T3', capacity: 4, shape: 'square' },
      { areaKey: 'hall', label: 'T4', capacity: 6, shape: 'rectangle' },
      { areaKey: 'terrace', label: 'P1', capacity: 4, shape: 'round' },
      { areaKey: 'vip', label: 'V1', capacity: 8, shape: 'sofa', isVip: true },
    ],
    admin: { username: ADMIN.username, displayName: 'Sofia Owner', email: 'owner@example.com', password: ADMIN.password },
    reservation: { slotIntervalMinutes: 30, defaultDurationMinutes: 120, bufferMinutes: 15, maxAdvanceDays: 60, onlineBookingEnabled: true, depositEnabled: false },
    pos: { provider: 'none', baseUrl: '' },
    backup: { enabled: true, timeOfDay: '04:00', retentionDays: 30, externalDirectory: '' },
    publicBaseUrl: 'https://sofia.example.com',
  };
}

export interface Restaurant {
  admin: ApiClient;
  branchId: string;
  tables: Record<string, string>;
  areas: Record<string, string>;
}

/** Run the first-run wizard and return an authenticated owner client plus ids of the seeded floor. */
export async function setupRestaurant(app: FastifyInstance): Promise<Restaurant> {
  const admin = new ApiClient(app);
  const r = await admin.post('/api/v1/setup/complete', setupPayload());
  if (r.status !== 200) throw new Error(`Setup failed: ${r.status} ${JSON.stringify(r.body)}`);
  const tables = await admin.get(`/api/v1/tables?branchId=${r.body.branchId}`);
  const areas = await admin.get(`/api/v1/areas?branchId=${r.body.branchId}`);
  return {
    admin,
    branchId: r.body.branchId,
    tables: Object.fromEntries((tables.body as { label: string; id: string }[]).map((t) => [t.label, t.id])),
    areas: Object.fromEntries((areas.body as { name: string; id: string }[]).map((a) => [a.name, a.id])),
  };
}

export async function createStaff(app: FastifyInstance, admin: ApiClient, roleKey: string, branchIds: string[], username = `${roleKey}_${Math.random().toString(36).slice(2, 7)}`) {
  const password = `Staff-Pass-${Math.random().toString(36).slice(2, 8)}!`;
  const r = await admin.post('/api/v1/users', { username, displayName: username, password, roleKey, branchIds, preferredLanguage: 'en' });
  if (r.status !== 200) throw new Error(`Create staff failed: ${JSON.stringify(r.body)}`);
  const client = new ApiClient(app);
  const l = await client.login(username, password);
  if (l.status !== 200) throw new Error(`Staff login failed: ${JSON.stringify(l.body)}`);
  return { client, userId: r.body.id as string, username, password };
}
