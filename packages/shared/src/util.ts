import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** RFC 9562 UUID version 7 (time-ordered) — generated on devices so offline records never collide. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normalise a phone number to E.164 (e.g. +9647701234567). Returns null when it cannot be parsed. */
export function normalizePhone(raw: string | null | undefined, defaultCountry = 'IQ'): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '').replace(/^00/, '+');
  if (cleaned.replace(/\D/g, '').length < 6) return null;
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as CountryCode);
  if (parsed && parsed.isPossible()) return parsed.number;
  return cleaned.startsWith('+') ? cleaned : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v.length ? v : null;
}

export function fullName(g: { firstName?: string | null; lastName?: string | null }): string {
  return [g.firstName, g.lastName].filter(Boolean).join(' ').trim();
}

/** Render `{{ placeholder }}` templates. Unknown placeholders render as empty strings. */
export function renderTemplate(
  body: string,
  vars: Record<string, string | number | null | undefined>,
  escape?: (v: string) => string,
): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    const s = v == null ? '' : String(v);
    return escape ? escape(s) : s;
  });
}

export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CURRENCY_DECIMALS: Record<string, number> = { IQD: 0, USD: 2 };

export function formatMoney(amount: number | string | null | undefined, currency = 'IQD', locale = 'en'): string {
  const n = typeof amount === 'string' ? Number(amount) : (amount ?? 0);
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const loc = locale === 'ar' ? 'ar-IQ' : 'en-US';
  try {
    return new Intl.NumberFormat(loc, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  } catch {
    return `${n.toFixed(decimals)} ${currency}`;
  }
}

/** Compare SemVer strings. Returns negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/);
  const pb = b.replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}
