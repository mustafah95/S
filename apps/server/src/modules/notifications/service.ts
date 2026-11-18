import { and, eq } from 'drizzle-orm';
import { renderTemplate, utcToZoned, type TemplateKey } from '@sofia/shared';
import { config } from '../../config.js';
import { getDb, q, schema, sql, type DbOrTx } from '../../db/pool.js';
import { getSetting } from '../../lib/settings.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { logEvent } from '../../lib/system-events.js';
import { ADAPTERS, PermanentSendError } from '../../integrations/messaging.js';

type Reservation = typeof schema.reservations.$inferSelect;
type Guest = typeof schema.guests.$inferSelect;

export async function publicBaseUrl(): Promise<string> {
  const g = await getSetting('general');
  return (g.publicBaseUrl || config.publicUrl || '').replace(/\/$/, '');
}

export function optOutToken(guestId: string, privacyToken: string): string {
  return `${guestId}.${hmacSha256(config.jwtSecret, `optout:${guestId}:${privacyToken}`).slice(0, 32)}`;
}

function contactFor(guest: Pick<Guest, 'whatsapp' | 'phone' | 'phoneNormalized' | 'email'>, channel: string): string | null {
  if (channel === 'whatsapp') return guest.whatsapp || guest.phoneNormalized || guest.phone || null;
  if (channel === 'sms') return guest.phoneNormalized || guest.phone || null;
  if (channel === 'email') return guest.email || null;
  return null;
}

async function enabledChannels(): Promise<string[]> {
  const n = await getSetting('notifications');
  const order = [n.preferredTransactionalChannel, 'whatsapp', 'sms', 'email'];
  return [...new Set(order)].filter((c) => n.channelsEnabled[c as keyof typeof n.channelsEnabled]);
}

export async function loadTemplate(tx: DbOrTx, key: string, channel: string, language: string) {
  const rows = await tx
    .select()
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.key, key), eq(schema.messageTemplates.channel, channel), eq(schema.messageTemplates.isActive, true)));
  return rows.find((r) => r.language === language) ?? rows.find((r) => r.language === 'en') ?? rows[0];
}

/** Ordered placeholder values for WhatsApp approved templates ({{a}} … {{b}} → [a, b]). */
export function templateParams(body: string, vars: Record<string, string | number | null | undefined>): string[] {
  return [...body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => String(vars[m[1]!] ?? ''));
}

export interface QueueOptions {
  guest: Guest;
  key: TemplateKey;
  vars: Record<string, string | number | null | undefined>;
  channel?: string;
  isMarketing?: boolean;
  campaignId?: string | null;
  reservationId?: string | null;
  branchId?: string | null;
  dedupeKey?: string;
  language?: string;
  /** Override template body/subject (campaigns). */
  body?: string;
  subject?: string | null;
  providerTemplateName?: string | null;
}

/** Render a template for a guest and enqueue it. Returns the outbox id, or a skip reason. */
export async function queueGuestMessage(tx: DbOrTx, o: QueueOptions): Promise<{ id?: string; skipped?: string }> {
  if (o.guest.anonymizedAt) return { skipped: 'anonymised' };
  if (o.isMarketing) {
    const ch = (o.guest.consentChannels ?? {}) as Record<string, boolean>;
    if (!o.guest.marketingConsent || o.guest.optedOutAt) return { skipped: 'no_marketing_consent' };
    if (o.channel && ch[o.channel] === false) return { skipped: `no_consent_${o.channel}` };
  }
  const general = await getSetting('general');
  const branding = await getSetting('branding');
  const language = o.language && o.language !== 'guest' ? o.language : o.guest.preferredLanguage ?? general.defaultLanguage;
  const channels = o.channel ? [o.channel] : await enabledChannels();
  const channel = channels.find((c) => contactFor(o.guest, c));
  if (!channel) return { skipped: o.channel ? `no_${o.channel}_contact` : 'no_channel_or_contact' };
  const to = contactFor(o.guest, channel)!;
  const tpl = o.body ? null : await loadTemplate(tx, o.key, channel, language);
  const body = o.body ?? tpl?.body;
  if (!body) return { skipped: 'no_template' };
  const base = await publicBaseUrl();
  const vars = {
    restaurant: language === 'ar' && branding.restaurantNameAr ? branding.restaurantNameAr : branding.restaurantName,
    guest_name: o.guest.preferredName || o.guest.firstName,
    opt_out_url: base ? `${base}/book/opt-out?t=${optOutToken(o.guest.id, o.guest.privacyToken)}` : '',
    ...o.vars,
  };
  const rendered = renderTemplate(body, vars);
  const subject = o.subject ?? tpl?.subject ?? null;
  const providerTemplateName = o.providerTemplateName ?? tpl?.providerTemplateName ?? null;
  const rows = await q<{ id: string }>(
    tx,
    sql`INSERT INTO notification_outbox (channel, recipient, template_key, language, subject, body, payload, guest_id, reservation_id,
                                         campaign_id, branch_id, is_marketing, dedupe_key)
        VALUES (${channel}, ${to}, ${o.key}, ${language}, ${subject ? renderTemplate(subject, vars) : null}, ${rendered},
                ${JSON.stringify({ providerTemplateName, templateParams: templateParams(body, vars) })}::jsonb,
                ${o.guest.id}, ${o.reservationId ?? null}, ${o.campaignId ?? null}, ${o.branchId ?? null}, ${o.isMarketing ?? false},
                ${o.dedupeKey ?? null})
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`,
  );
  return rows[0] ? { id: rows[0].id } : { skipped: 'duplicate' };
}

/** Transactional reservation messages (confirmation, cancellation, rescheduling, reminder, feedback request). */
export async function queueReservationMessage(tx: DbOrTx, key: TemplateKey, r: Reservation): Promise<void> {
  const n = await getSetting('notifications');
  if (key === 'reservation_confirmation' && !n.sendConfirmation) return;
  if (key === 'reservation_reminder' && !n.sendReminder) return;
  if (key === 'feedback_request' && !n.sendFeedbackRequest) return;
  if (!r.guestId) return;
  const [guest] = await tx.select().from(schema.guests).where(eq(schema.guests.id, r.guestId));
  if (!guest) return;
  const [branch] = await tx.select().from(schema.branches).where(eq(schema.branches.id, r.branchId));
  const tz = branch?.timezone ?? 'Asia/Baghdad';
  const local = utcToZoned(r.startAt, tz);
  const base = await publicBaseUrl();
  const lang = guest.preferredLanguage ?? 'ar';
  await queueGuestMessage(tx, {
    guest,
    key,
    reservationId: r.id,
    branchId: r.branchId,
    dedupeKey: `${key}:${r.id}`,
    vars: {
      branch: lang === 'ar' && branch?.nameAr ? branch.nameAr : branch?.name,
      date: r.businessDate as unknown as string,
      time: local.time,
      party_size: r.partySize,
      code: r.code,
      manage_url: base ? `${base}/r/${r.code}?t=${r.confirmationToken}` : r.code,
      feedback_url: base ? `${base}/feedback/${r.feedbackToken}` : '',
    },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Dispatcher (worker)
// ---------------------------------------------------------------------------------------------------------

const MAX_ATTEMPTS = 6;

/** Deliver due outbox messages. Safe to run in several processes: rows are claimed with SKIP LOCKED. */
export async function processOutbox(limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
  const db = getDb();
  const claimed = await q<{
    id: string;
    channel: string;
    recipient: string;
    subject: string | null;
    body: string;
    language: string | null;
    payload: { providerTemplateName?: string | null; templateParams?: string[] };
    attempts: number;
    campaign_id: string | null;
    guest_id: string | null;
  }>(
    db,
    sql`UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
        WHERE id IN (SELECT id FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= now()
                     ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id, channel, recipient, subject, body, language, payload, attempts, campaign_id, guest_id`,
  );
  const stats = { sent: 0, failed: 0, skipped: 0 };
  for (const m of claimed) {
    const adapter = ADAPTERS[m.channel];
    const reason = adapter ? await adapter.unavailableReason() : `Unknown channel ${m.channel}`;
    if (reason) {
      await db.execute(sql`UPDATE notification_outbox SET status = 'skipped', last_error = ${reason} WHERE id = ${m.id}`);
      if (m.campaign_id) await db.execute(sql`UPDATE campaign_recipients SET status = 'skipped', skip_reason = ${reason} WHERE outbox_id = ${m.id}`);
      stats.skipped++;
      continue;
    }
    try {
      const r = await adapter!.send({
        to: m.recipient,
        subject: m.subject,
        body: m.body,
        language: m.language ?? 'ar',
        providerTemplateName: m.payload?.providerTemplateName,
        templateParams: m.payload?.templateParams,
      });
      await db.execute(sql`UPDATE notification_outbox SET status = 'sent', sent_at = now(), provider_message_id = ${r.providerMessageId ?? null}, last_error = NULL WHERE id = ${m.id}`);
      if (m.campaign_id) await db.execute(sql`UPDATE campaign_recipients SET status = 'sent' WHERE outbox_id = ${m.id}`);
      stats.sent++;
    } catch (err) {
      const permanent = err instanceof PermanentSendError || m.attempts >= MAX_ATTEMPTS;
      const delayMin = Math.min(2 ** m.attempts, 120);
      await db.execute(sql`UPDATE notification_outbox
                           SET status = ${permanent ? 'failed' : 'pending'}, last_error = ${(err as Error).message.slice(0, 1000)},
                               next_attempt_at = now() + make_interval(mins => ${delayMin})
                           WHERE id = ${m.id}`);
      if (permanent && m.campaign_id) await db.execute(sql`UPDATE campaign_recipients SET status = 'failed', skip_reason = ${(err as Error).message.slice(0, 300)} WHERE outbox_id = ${m.id}`);
      if (permanent) {
        stats.failed++;
        await logEvent('warn', 'integration', `Message delivery failed (${m.channel})`, { outboxId: m.id, error: (err as Error).message });
      }
    }
  }
  return stats;
}
