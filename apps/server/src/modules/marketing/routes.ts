import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { campaignSchema, segmentSchema, templateSchema, TEMPLATE_KEYS } from '@sofia/shared';
import { camelRows, getDb, q, q1, schema, sql } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { systemContext, type RequestContext } from '../../lib/context.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { defineRoute, idParams } from '../../lib/route.js';
import { logEvent } from '../../lib/system-events.js';
import { queueGuestMessage } from '../notifications/service.js';
import { compileRules, segmentWhere } from './segments.js';

const BASE = sql`g.deleted_at IS NULL AND g.merged_into_id IS NULL AND g.anonymized_at IS NULL`;

/** Materialise recipients (consent-aware) and enqueue messages for a campaign. */
export async function sendCampaign(campaignId: string, ctx: RequestContext): Promise<{ queued: number; skipped: number }> {
  const db = getDb();
  const claimed = await q1<typeof schema.campaigns.$inferSelect & Record<string, unknown>>(
    db,
    sql`UPDATE campaigns SET status = 'sending' WHERE id = ${campaignId} AND status IN ('draft', 'scheduled') RETURNING *`,
  );
  if (!claimed) throw new AppError(409, 'invalid_state', 'Campaign was already sent or cancelled');
  const c = camelRows<typeof schema.campaigns.$inferSelect>([claimed])[0]!;
  let queued = 0;
  let skipped = 0;
  try {
    const where = await segmentWhere(db, c.segmentKey);
    const guests = await db.query.guests.findMany({
      where: (t) => sql`${t.id} IN (SELECT g.id FROM guests g WHERE ${BASE} AND ${where} ${c.branchId ? sql`AND (g.home_branch_id = ${c.branchId} OR EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id = g.id AND r.branch_id = ${c.branchId}))` : sql``})`,
    });
    for (const guest of guests) {
      await db.transaction(async (tx) => {
        const r = await queueGuestMessage(tx, {
          guest,
          key: 'marketing',
          channel: c.channel,
          isMarketing: true,
          campaignId: c.id,
          language: c.language,
          body: c.body,
          subject: c.subject,
          providerTemplateName: c.providerTemplateName,
          dedupeKey: `campaign:${c.id}:${guest.id}`,
          vars: { message: c.body },
        });
        await tx.execute(sql`INSERT INTO campaign_recipients (campaign_id, guest_id, outbox_id, status, skip_reason)
                             VALUES (${c.id}, ${guest.id}, ${r.id ?? null}, ${r.id ? 'queued' : 'skipped'}, ${r.skipped ?? null})
                             ON CONFLICT (campaign_id, guest_id) DO NOTHING`);
        if (r.id) queued++;
        else skipped++;
      });
    }
    await db.execute(sql`UPDATE campaigns SET status = 'sent', sent_at = now(), stats = ${JSON.stringify({ queued, skipped, audience: guests.length })}::jsonb WHERE id = ${c.id}`);
    await audit(db, ctx, { action: 'campaign.send', entityType: 'campaign', entityId: c.id, meta: { queued, skipped } });
    await logEvent('info', 'integration', `Campaign "${c.name}" queued ${queued} message(s), ${skipped} skipped (consent/contact)`);
    return { queued, skipped };
  } catch (err) {
    await db.execute(sql`UPDATE campaigns SET status = 'failed', stats = ${JSON.stringify({ error: (err as Error).message })}::jsonb WHERE id = ${c.id}`);
    throw err;
  }
}

export async function sendDueCampaigns(): Promise<void> {
  const due = await q<{ id: string }>(getDb(), sql`SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now() AND deleted_at IS NULL`);
  for (const c of due) await sendCampaign(c.id, systemContext('campaign-scheduler')).catch(() => undefined);
}

/** Delivery + attribution: guests who visited within the attribution window after the send, and their spend. */
export async function campaignStats(id: string) {
  const db = getDb();
  const c = await q1<{ sent_at: Date | null; attribution_days: number; cost: number; channel: string }>(db, sql`SELECT sent_at, attribution_days, cost, channel FROM campaigns WHERE id = ${id}`);
  if (!c) throw notFound('Campaign');
  const delivery = await q(db, sql`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE campaign_id = ${id} GROUP BY status`);
  const attributed = c.sent_at
    ? await q1<{ guests: number; visits: number; revenue: number }>(
        db,
        sql`SELECT count(DISTINCT cr.guest_id)::int AS guests,
                   count(DISTINCT r.id)::int AS visits,
                   coalesce((SELECT sum(i.total_base) FROM pos_invoices i JOIN campaign_recipients cr2 ON cr2.guest_id = i.guest_id AND cr2.campaign_id = ${id} AND cr2.status = 'sent'
                             WHERE i.status = 'closed' AND i.closed_at BETWEEN ${c.sent_at} AND ${c.sent_at}::timestamptz + make_interval(days => ${c.attribution_days})), 0)::float AS revenue
            FROM campaign_recipients cr
            JOIN reservations r ON r.guest_id = cr.guest_id AND r.status IN ('seated', 'dining', 'completed')
                               AND r.start_at BETWEEN ${c.sent_at} AND ${c.sent_at}::timestamptz + make_interval(days => ${c.attribution_days})
            WHERE cr.campaign_id = ${id} AND cr.status = 'sent'`,
      )
    : null;
  const revenue = attributed?.revenue ?? 0;
  return {
    delivery: Object.fromEntries(delivery.map((d) => [d.status as string, d.n])),
    attributedGuests: attributed?.guests ?? 0,
    attributedVisits: attributed?.visits ?? 0,
    attributedRevenue: revenue,
    cost: c.cost,
    roi: c.cost > 0 ? Math.round(((revenue - c.cost) / c.cost) * 1000) / 10 : null,
  };
}

export async function registerMarketingRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/segments', summary: 'Customer segments with live audience size', tags: ['Marketing'], permission: ['marketing.read', 'guests.read'] }, async () => {
    const segs = await db.select().from(schema.segments).where(isNull(schema.segments.deletedAt)).orderBy(asc(schema.segments.createdAt));
    const out = [];
    for (const s of segs) {
      const where = await segmentWhere(db, s.id);
      const [{ n, consent }] = (await q<{ n: number; consent: number }>(db, sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE g.marketing_consent AND g.opted_out_at IS NULL)::int AS consent FROM guests g WHERE ${BASE} AND ${where}`)) as [{ n: number; consent: number }];
      out.push({ ...s, size: n, consentedSize: consent });
    }
    return out;
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/segments', summary: 'Create a custom segment', tags: ['Marketing'], permission: 'marketing.manage', body: segmentSchema }, async ({ body, ctx }) => {
    await compileRules(body.rules, body.match);
    const key = `custom_${Date.now().toString(36)}`;
    const [s] = await db.insert(schema.segments).values({ key, name: body.name, description: body.description ?? null, match: body.match, rules: body.rules, createdBy: ctx.user?.id }).returning();
    await audit(db, ctx, { action: 'segment.create', entityType: 'segment', entityId: s!.id, after: s });
    return s;
  });

  defineRoute(app, { method: 'PATCH', url: '/api/v1/segments/:id', summary: 'Update a custom segment', tags: ['Marketing'], permission: 'marketing.manage', params: idParams, body: segmentSchema.partial() }, async ({ params, body, ctx }) => {
    const [before] = await db.select().from(schema.segments).where(eq(schema.segments.id, params.id));
    if (!before || before.deletedAt) throw notFound('Segment');
    if (before.isSystem) throw unprocessable('system_segment', 'Built-in segments cannot be edited — create a custom segment');
    const [after] = await db.update(schema.segments).set({ ...body, updatedBy: ctx.user?.id ?? null }).where(eq(schema.segments.id, params.id)).returning();
    await audit(db, ctx, { action: 'segment.update', entityType: 'segment', entityId: params.id, before, after });
    return after;
  });

  defineRoute(app, { method: 'DELETE', url: '/api/v1/segments/:id', summary: 'Delete a custom segment', tags: ['Marketing'], permission: 'marketing.manage', params: idParams }, async ({ params, ctx }) => {
    const [s] = await db.select().from(schema.segments).where(eq(schema.segments.id, params.id));
    if (!s || s.deletedAt) throw notFound('Segment');
    if (s.isSystem) throw unprocessable('system_segment', 'Built-in segments cannot be deleted');
    await db.update(schema.segments).set({ deletedAt: new Date() }).where(eq(schema.segments.id, params.id));
    await audit(db, ctx, { action: 'segment.delete', entityType: 'segment', entityId: params.id, before: s });
    return { ok: true };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/segments/:id/preview', summary: 'Sample of guests in a segment', tags: ['Marketing'], permission: ['marketing.read', 'guests.read'], params: idParams }, async ({ params }) => {
    const where = await segmentWhere(db, params.id);
    const rows = await q(db, sql`SELECT g.id, g.first_name, g.last_name, g.vip_level, g.visit_count, g.total_spend, g.last_visit_at, g.marketing_consent
                                 FROM guests g WHERE ${BASE} AND ${where} ORDER BY g.total_spend DESC LIMIT 50`);
    return camelRows(rows);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/campaigns', summary: 'Marketing campaigns', tags: ['Marketing'], permission: 'marketing.read' }, async () =>
    camelRows(await q(db, sql`SELECT c.*, s.name AS segment_name FROM campaigns c LEFT JOIN segments s ON s.key = c.segment_key WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC`)),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/campaigns', summary: 'Create a campaign (draft)', tags: ['Marketing'], permission: 'marketing.manage', body: campaignSchema }, async ({ body, ctx }) => {
    await segmentWhere(db, body.segmentKey);
    const [c] = await db
      .insert(schema.campaigns)
      .values({ ...body, scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null, status: 'draft', createdBy: ctx.user?.id })
      .returning();
    await audit(db, ctx, { action: 'campaign.create', entityType: 'campaign', entityId: c!.id, after: c });
    return c;
  });

  defineRoute(app, { method: 'PATCH', url: '/api/v1/campaigns/:id', summary: 'Edit a draft campaign', tags: ['Marketing'], permission: 'marketing.manage', params: idParams, body: campaignSchema.partial() }, async ({ params, body, ctx }) => {
    const [before] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, params.id));
    if (!before || before.deletedAt) throw notFound('Campaign');
    if (!['draft', 'scheduled'].includes(before.status)) throw unprocessable('not_editable', 'Only draft or scheduled campaigns can be edited');
    const [after] = await db
      .update(schema.campaigns)
      .set({ ...body, scheduledAt: body.scheduledAt === undefined ? undefined : body.scheduledAt ? new Date(body.scheduledAt) : null, updatedBy: ctx.user?.id ?? null })
      .where(eq(schema.campaigns.id, params.id))
      .returning();
    await audit(db, ctx, { action: 'campaign.update', entityType: 'campaign', entityId: params.id, before, after });
    return after;
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/campaigns/:id/schedule', summary: 'Schedule a campaign', tags: ['Marketing'], permission: 'marketing.send', params: idParams, body: z.object({ scheduledAt: z.iso.datetime({ offset: true }) }) }, async ({ params, body, ctx }) => {
    const [c] = await db.update(schema.campaigns).set({ status: 'scheduled', scheduledAt: new Date(body.scheduledAt) }).where(and(eq(schema.campaigns.id, params.id), eq(schema.campaigns.status, 'draft'))).returning();
    if (!c) throw unprocessable('not_draft', 'Only draft campaigns can be scheduled');
    await audit(db, ctx, { action: 'campaign.schedule', entityType: 'campaign', entityId: params.id, meta: { scheduledAt: body.scheduledAt } });
    return c;
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/campaigns/:id/send', summary: 'Send a campaign now (consent and opt-out respected)', tags: ['Marketing'], permission: 'marketing.send', params: idParams }, async ({ params, ctx }) => sendCampaign(params.id, ctx));

  defineRoute(app, { method: 'POST', url: '/api/v1/campaigns/:id/cancel', summary: 'Cancel a draft or scheduled campaign', tags: ['Marketing'], permission: 'marketing.manage', params: idParams }, async ({ params, ctx }) => {
    const [c] = await db.update(schema.campaigns).set({ status: 'cancelled' }).where(and(eq(schema.campaigns.id, params.id), sql`${schema.campaigns.status} IN ('draft', 'scheduled')`)).returning();
    if (!c) throw unprocessable('not_cancellable', 'Campaign already sent');
    await audit(db, ctx, { action: 'campaign.cancel', entityType: 'campaign', entityId: params.id });
    return c;
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/campaigns/:id/stats', summary: 'Delivery, attributed visits and revenue, ROI', tags: ['Marketing'], permission: 'marketing.read', params: idParams }, async ({ params }) => campaignStats(params.id));

  // Message templates -----------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/notification-templates', summary: 'Message templates (per key, channel and language)', tags: ['Notifications'], permission: ['notifications.manage', 'marketing.read'] }, async () =>
    db.select().from(schema.messageTemplates).where(isNull(schema.messageTemplates.deletedAt)).orderBy(asc(schema.messageTemplates.key), asc(schema.messageTemplates.channel), asc(schema.messageTemplates.language)),
  );

  defineRoute(app, { method: 'PUT', url: '/api/v1/notification-templates', summary: 'Create or update a message template', tags: ['Notifications'], permission: 'notifications.manage', body: templateSchema }, async ({ body, ctx }) => {
    const [row] = await db
      .insert(schema.messageTemplates)
      .values({ ...body, createdBy: ctx.user?.id })
      .onConflictDoUpdate({ target: [schema.messageTemplates.key, schema.messageTemplates.channel, schema.messageTemplates.language], set: { subject: body.subject ?? null, body: body.body, providerTemplateName: body.providerTemplateName ?? null, isActive: body.isActive, updatedBy: ctx.user?.id ?? null } })
      .returning();
    await audit(db, ctx, { action: 'template.update', entityType: 'message_template', entityId: `${body.key}:${body.channel}:${body.language}`, after: row });
    return row;
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/notifications/outbox', summary: 'Outgoing message log', tags: ['Notifications'], permission: ['notifications.manage', 'marketing.read'], query: z.object({ status: z.string().max(20).optional(), key: z.enum(TEMPLATE_KEYS).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async ({ query }) =>
    camelRows(await q(db, sql`SELECT o.id, o.channel, o.recipient, o.template_key, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, o.is_marketing,
                                     g.first_name, g.last_name
                              FROM notification_outbox o LEFT JOIN guests g ON g.id = o.guest_id
                              WHERE (${query.status ?? null}::text IS NULL OR o.status = ${query.status ?? null})
                                AND (${query.key ?? null}::text IS NULL OR o.template_key = ${query.key ?? null})
                              ORDER BY o.created_at DESC LIMIT ${query.limit}`)),
  );
}
