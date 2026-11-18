import { db, kvGet, kvSet } from './db';

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  role: string;
  permissions: string[];
  allBranches: boolean;
  branches: { id: string; code: string; name: string; nameAr: string | null; timezone: string; currency: string }[];
  preferredLanguage: 'ar' | 'en';
  mfaEnabled: boolean;
}

interface Verifier {
  salt: string;
  hash: string;
  iterations: number;
}

interface CachedSession {
  profile: Profile;
  username: string;
  verifier: Verifier | null;
  lastOnlineAt: string;
}

const ITERATIONS = 310_000;
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // insecure context (plain http): offline unlock unavailable
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return b64(bits);
}

/** After an online sign-in: cache the profile and a password verifier for offline unlock. */
export async function rememberSession(profile: Profile, username: string, password?: string): Promise<void> {
  const existing = await kvGet<CachedSession>('session');
  let verifier: Verifier | null = existing?.username === username ? existing.verifier : null;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(password, salt, ITERATIONS);
    verifier = hash ? { salt: b64(salt), hash, iterations: ITERATIONS } : null;
  }
  await kvSet('session', { profile, username, verifier, lastOnlineAt: new Date().toISOString() } satisfies CachedSession);
}

export async function touchOnline(profile: Profile): Promise<void> {
  const s = await kvGet<CachedSession>('session');
  if (s) await kvSet('session', { ...s, profile, lastOnlineAt: new Date().toISOString() });
}

export async function cachedSession(): Promise<CachedSession | undefined> {
  return kvGet<CachedSession>('session');
}

export type UnlockResult = { ok: true; profile: Profile } | { ok: false; reason: 'no_cache' | 'expired' | 'invalid' | 'unsupported' };

/** Verify the password locally (PBKDF2-SHA-256) — used only when the server is unreachable. */
export async function unlockOffline(username: string, password: string, graceHours: number): Promise<UnlockResult> {
  const s = await cachedSession();
  if (!s) return { ok: false, reason: 'no_cache' };
  if (!s.verifier) return { ok: false, reason: globalThis.crypto?.subtle ? 'no_cache' : 'unsupported' };
  if (Date.now() - new Date(s.lastOnlineAt).getTime() > graceHours * 3600_000) return { ok: false, reason: 'expired' };
  if (s.username.toLowerCase() !== username.trim().toLowerCase()) return { ok: false, reason: 'invalid' };
  const salt = Uint8Array.from(atob(s.verifier.salt), (c) => c.charCodeAt(0));
  const hash = await derive(password, salt, s.verifier.iterations);
  return hash === s.verifier.hash ? { ok: true, profile: s.profile } : { ok: false, reason: 'invalid' };
}

export async function forgetSession(): Promise<void> {
  await db.kv.delete('session');
}
