import { APP_VERSION, SYNC_PROTOCOL_VERSION, uuidv7 } from '@sofia/shared';

/** Error returned by the Sofia API (HTTP status + machine-readable code). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** The request never reached the server (device offline or server down). */
export class NetworkError extends Error {
  constructor(message = 'Network unreachable') {
    super(message);
  }
}

export function deviceId(): string {
  try {
    let id = localStorage.getItem('sofia.deviceId');
    if (!id) {
      id = uuidv7();
      localStorage.setItem('sofia.deviceId', id);
    }
    return id;
  } catch {
    return '00000000-0000-7000-8000-000000000000';
  }
}

function cookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let authLostHandler: (() => void) | null = null;
export function onAuthLost(fn: () => void): void {
  authLostHandler = fn;
}

let refreshing: Promise<boolean> | null = null;
async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await rawFetch('POST', '/api/v1/auth/refresh', undefined, 15_000);
      return res.ok;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function rawFetch(method: string, url: string, body: unknown, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Sofia-Device-Id': deviceId(),
    'X-Sofia-Client-Version': APP_VERSION,
    'X-Sofia-Sync-Protocol': String(SYNC_PROTOCOL_VERSION),
  };
  const csrf = cookie('sofia_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try {
    return await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new NetworkError((err as Error).message);
  }
}

export interface ApiOptions {
  timeoutMs?: number;
  /** Return the raw Response (downloads). */
  raw?: boolean;
  noRefresh?: boolean;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  if (!cookie('sofia_csrf') && method !== 'GET') await rawFetch('GET', '/api/v1/sync/ping', undefined, 5000).catch(() => undefined);
  let res = await rawFetch(method, url, body, opts.timeoutMs ?? 20_000);
  if (res.status === 401 && !opts.noRefresh && !url.includes('/auth/')) {
    if (await refreshSession()) res = await rawFetch(method, url, body, opts.timeoutMs ?? 20_000);
    if (res.status === 401) authLostHandler?.();
  }
  if (res.status === 403) {
    const peek = (await res.clone().json().catch(() => ({}))) as { error?: { code?: string } };
    if (peek.error?.code === 'csrf_failed') {
      await rawFetch('GET', '/api/v1/sync/ping', undefined, 5000).catch(() => undefined);
      res = await rawFetch(method, url, body, opts.timeoutMs ?? 20_000);
    }
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'download_failed', res.statusText);
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

export const get = <T = unknown>(url: string, opts?: ApiOptions) => api<T>('GET', url, undefined, opts);
export const post = <T = unknown>(url: string, body?: unknown, opts?: ApiOptions) => api<T>('POST', url, body ?? {}, opts);
export const patch = <T = unknown>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T = unknown>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T = unknown>(url: string) => api<T>('DELETE', url);

/** Download an API response as a file (CSV, Excel, ZIP, backups). */
export async function download(method: string, url: string, body?: unknown, fallbackName = 'download'): Promise<void> {
  const res = await api<Response>(method, url, body, { raw: true, timeoutMs: 300_000 });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function errorMessage(err: unknown, t?: (k: string) => string): string {
  if (err instanceof NetworkError) return t ? t('common.requiresConnection') : 'No connection to the server';
  if (err instanceof ApiError) {
    const issues = (err.details as { issues?: { path: string; message: string }[] } | undefined)?.issues;
    return issues?.length ? `${err.message}: ${issues.map((i) => `${i.path} ${i.message}`).join(', ')}` : err.message;
  }
  return (err as Error)?.message ?? String(err);
}
