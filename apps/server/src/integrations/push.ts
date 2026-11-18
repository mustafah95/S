import webpush from 'web-push';
import { config } from '../config.js';
import { getDb, q, sql, type DbOrTx } from '../db/pool.js';
import { systemContext } from '../lib/context.js';
import { getSecrets, getSetting, putSecrets } from '../lib/settings.js';

/**
 * Web Push (RFC 8030 / 8291 / 8292) for guests: the browser's push service receives an encrypted message signed
 * with the restaurant's VAPID key. No third-party account is needed — the browser vendors run the push services.
 *
 * Endpoints come from guests' browsers, so they are untrusted input: only the push services of the browser vendors
 * (plus SOFIA_PUSH_EXTRA_HOSTS) are accepted, over HTTPS on the default port, and redirects are never followed —
 * otherwise a subscription could make the server send requests into the restaurant's own network (SSRF).
 */

export const PUSH_SERVICE_DOMAINS = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Samsung Internet, Opera
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari (macOS, iOS home-screen apps)
  'notify.windows.com', // Edge (Windows)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (config.pushExtraHosts.includes(host) || config.pushExtraHosts.includes(u.host.toLowerCase())) {
    return u.protocol === 'https:' || (config.isTest && u.protocol === 'http:');
  }
  return u.protocol === 'https:' && u.port === '' && PUSH_SERVICE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** base64url-decoded length check for subscription keys (P-256 public key: 65 bytes, auth secret: 16 bytes). */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return false;
  const pub = Buffer.from(p256dh, 'base64url');
  return pub.length === 65 && pub[0] === 0x04 && Buffer.from(auth, 'base64url').length === 16;
}

const VAPID_LOCK = 73010005;

/** The restaurant's VAPID key pair, generated once and stored encrypted with the other integration secrets. */
export async function vapidKeys(tx: DbOrTx = getDb()): Promise<{ publicKey: string; privateKey: string }> {
  const existing = await getSecrets<{ publicKey: string; privateKey: string }>('push', tx);
  if (existing?.publicKey && existing.privateKey) return existing;
  return getDb().transaction(async (t) => {
    await t.execute(sql`SELECT pg_advisory_xact_lock(${VAPID_LOCK})`);
    const again = await getSecrets<{ publicKey: string; privateKey: string }>('push', t);
    if (again?.publicKey && again.privateKey) return again;
    const keys = webpush.generateVAPIDKeys();
    await putSecrets(t, systemContext('web-push'), 'push', { publicKey: keys.publicKey, privateKey: keys.privateKey });
    return keys;
  });
}

/** Contact for the push services (RFC 8292 "sub"): the public HTTPS address, else the restaurant's e-mail. */
async function vapidSubject(): Promise<string> {
  const general = await getSetting('general');
  const base = (general.publicBaseUrl || config.publicUrl || '').replace(/\/$/, '');
  if (/^https:\/\//.test(base) && !/^https:\/\/(localhost|127\.|\[::1\])/.test(base)) return base;
  const email = (await getSetting('integrations.email')).fromAddress;
  return email ? `mailto:${email}` : 'mailto:reservations@sofia-resto-lounge.invalid';
}

export interface PushContent {
  title: string;
  body: string;
  /** Path or same-origin URL opened when the guest taps the notification. */
  url?: string;
  tag?: string;
  lang?: string;
}

export interface PushDelivery {
  delivered: number;
  total: number;
  revoked: number;
  transientErrors: string[];
  permanentErrors: string[];
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Test seam: replace the HTTP client used to reach push services. */
export function setPushFetch(f: FetchLike): void {
  fetchImpl = f;
}

async function revoke(id: string, reason: string): Promise<void> {
  await getDb().execute(sql`UPDATE guest_push_subscriptions SET revoked_at = now(), revoke_reason = ${reason}, updated_at = now()
                            WHERE id = ${id} AND revoked_at IS NULL`);
}

/** Sends one notification to every active browser subscription of a guest. */
export async function sendGuestPush(guestId: string, content: PushContent): Promise<PushDelivery> {
  const db = getDb();
  const subs = await q<{ id: string; endpoint: string; public_key: string; auth_secret: string; failure_count: number }>(
    db,
    sql`SELECT id, endpoint, public_key, auth_secret, failure_count FROM guest_push_subscriptions WHERE guest_id = ${guestId} AND revoked_at IS NULL`,
  );
  const result: PushDelivery = { delivered: 0, total: subs.length, revoked: 0, transientErrors: [], permanentErrors: [] };
  if (!subs.length) return result;
  const keys = await vapidKeys();
  const subject = await vapidSubject();
  const payload = JSON.stringify({
    title: content.title.slice(0, 120),
    body: content.body.slice(0, 700),
    url: content.url ?? '/',
    tag: content.tag,
    lang: content.lang,
    dir: content.lang === 'ar' ? 'rtl' : 'ltr',
    icon: '/brand/sofia-icon-192.png',
  });
  for (const s of subs) {
    if (!isAllowedPushEndpoint(s.endpoint)) {
      await revoke(s.id, 'endpoint_not_allowed');
      result.revoked++;
      continue;
    }
    let status = 0;
    let error = '';
    try {
      const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.public_key, auth: s.auth_secret } }, payload, {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 24 * 3600,
        urgency: 'normal',
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() !== 'content-length') headers[k] = String(v);
      const res = await fetchImpl(req.endpoint, {
        method: 'POST',
        headers,
        body: req.body as unknown as BodyInit,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim();
    } catch (err) {
      error = (err as Error).message;
    }
    if (status >= 200 && status < 300) {
      result.delivered++;
      await db.execute(sql`UPDATE guest_push_subscriptions SET last_success_at = now(), failure_count = 0, last_error = NULL, updated_at = now() WHERE id = ${s.id}`);
    } else if (status === 404 || status === 410) {
      // The guest blocked notifications or the browser dropped the subscription.
      await revoke(s.id, `gone_${status}`);
      result.revoked++;
    } else if (status === 400 || status === 401 || status === 403 || status === 413) {
      result.permanentErrors.push(error);
      const failures = s.failure_count + 1;
      await db.execute(sql`UPDATE guest_push_subscriptions SET failure_count = ${failures}, last_failure_at = now(), last_error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${s.id}`);
      if (failures >= 3) {
        await revoke(s.id, 'rejected_by_push_service');
        result.revoked++;
      }
    } else {
      result.transientErrors.push(error || `HTTP ${status}`);
      await db.execute(sql`UPDATE guest_push_subscriptions SET last_failure_at = now(), last_error = ${(error || `HTTP ${status}`).slice(0, 500)}, updated_at = now() WHERE id = ${s.id}`);
    }
  }
  return result;
}
