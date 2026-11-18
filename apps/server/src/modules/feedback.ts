import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { complaintCreateSchema, complaintUpdateSchema, feedbackSubmitSchema, zId } from '@sofia/shared';
import { camelRows, getDb, q, q1, schema, sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertBranchAccess, branchScope, systemContext } from '../lib/context.js';
import { AppError, notFound } from '../lib/errors.js';
import { defineRoute, idParams } from '../lib/route.js';
import { notifyStaff } from '../lib/system-events.js';

/** Public: guest submits feedback via the link sent after the visit. Low ratings open a complaint automatically. */
export async function submitFeedback(token: string, input: z.infer<typeof feedbackSubmitSchema>) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const r = await q1<{ id: string; branch_id: string; guest_id: string | null; code: string }>(tx, sql`SELECT id, branch_id, guest_id, code FROM reservations WHERE feedback_token = ${token}`);
    if (!r) throw notFound('Feedback link');
    const exists = await q1(tx, sql`SELECT 1 FROM feedback WHERE reservation_id = ${r.id}`);
    if (exists) throw new AppError(409, 'already_submitted', 'Thank you — feedback for this visit was already received');
    const ctx = systemContext('feedback');
    const [fb] = await tx
      .insert(schema.feedback)
      .values({ branchId: r.branch_id, guestId: r.guest_id, reservationId: r.id, ...input, channel: 'link' })
      .returning();
    const isComplaint = input.isComplaint || input.overallRating <= 2;
    if (isComplaint) {
      const [c] = await tx
        .insert(schema.complaints)
        .values({
          branchId: r.branch_id,
          guestId: r.guest_id,
          reservationId: r.id,
          feedbackId: fb!.id,
          category: (input.foodRating ?? 5) <= 2 ? 'food' : (input.serviceRating ?? 5) <= 2 ? 'service' : (input.atmosphereRating ?? 5) <= 2 ? 'atmosphere' : 'other',
          severity: input.overallRating === 1 ? 'high' : 'medium',
          description: input.comment || `Low rating (${input.overallRating}/5) for reservation ${r.code}`,
        })
        .returning();
      await notifyStaff({ type: 'complaint', title: `Guest complaint (${input.overallRating}★) — ${r.code}`, body: input.comment ?? undefined, severity: 'warning', branchId: r.branch_id, permission: 'complaints.manage', data: { complaintId: c!.id } }, tx);
    }
    await audit(tx, ctx, { action: 'feedback.submit', entityType: 'feedback', entityId: fb!.id, branchId: r.branch_id, after: fb });
    return { ok: true, complaintCreated: isComplaint };
  });
}

export async function registerFeedbackRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const scopeSql = (ctx: Parameters<typeof branchScope>[0], col: string) => {
    const s = branchScope(ctx);
    return s ? (s.length ? sql`AND ${sql.identifier(col)} IN ${s}` : sql`AND false`) : sql``;
  };

  defineRoute(app, { method: 'GET', url: '/api/v1/feedback', summary: 'Guest feedback with ratings', tags: ['Feedback'], permission: 'feedback.read', query: z.object({ branchId: zId.optional(), maxRating: z.coerce.number().int().min(1).max(5).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    const rows = await q(db, sql`SELECT f.*, g.first_name, g.last_name, r.code AS reservation_code, b.name AS branch_name
                                 FROM feedback f LEFT JOIN guests g ON g.id = f.guest_id LEFT JOIN reservations r ON r.id = f.reservation_id JOIN branches b ON b.id = f.branch_id
                                 WHERE f.deleted_at IS NULL ${scopeSql(ctx, 'f.branch_id')}
                                   AND (${query.branchId ?? null}::uuid IS NULL OR f.branch_id = ${query.branchId ?? null}::uuid)
                                   AND (${query.maxRating ?? null}::int IS NULL OR f.overall_rating <= ${query.maxRating ?? null}::int)
                                 ORDER BY f.submitted_at DESC LIMIT ${query.limit}`);
    const [summary] = await q(db, sql`SELECT count(*)::int AS responses, round(avg(overall_rating), 2)::float AS overall, round(avg(food_rating), 2)::float AS food,
                                             round(avg(service_rating), 2)::float AS service, round(avg(atmosphere_rating), 2)::float AS atmosphere
                                      FROM feedback f WHERE f.deleted_at IS NULL ${scopeSql(ctx, 'f.branch_id')} AND f.submitted_at > now() - interval '90 days'`);
    return { items: camelRows(rows), summary };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/complaints', summary: 'Complaint register', tags: ['Feedback'], permission: 'complaints.read', query: z.object({ status: z.string().max(60).optional(), branchId: zId.optional() }) }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    const statuses = (query.status ?? 'open,in_progress,resolved,closed').split(',');
    const rows = await q(db, sql`SELECT c.*, g.first_name, g.last_name, g.vip_level, r.code AS reservation_code, u.display_name AS assigned_to_name, b.name AS branch_name
                                 FROM complaints c LEFT JOIN guests g ON g.id = c.guest_id LEFT JOIN reservations r ON r.id = c.reservation_id
                                 LEFT JOIN users u ON u.id = c.assigned_to JOIN branches b ON b.id = c.branch_id
                                 WHERE c.deleted_at IS NULL AND c.status IN ${statuses} ${scopeSql(ctx, 'c.branch_id')}
                                   AND (${query.branchId ?? null}::uuid IS NULL OR c.branch_id = ${query.branchId ?? null}::uuid)
                                 ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, c.created_at DESC LIMIT 500`);
    return camelRows(rows);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/complaints', summary: 'Record a complaint', tags: ['Feedback'], permission: 'complaints.manage', body: complaintCreateSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, body.branchId);
      const [c] = await tx.insert(schema.complaints).values({ ...body, followUpAt: body.followUpAt ? new Date(body.followUpAt) : null, createdBy: ctx.user?.id }).returning();
      await audit(tx, ctx, { action: 'complaint.create', entityType: 'complaint', entityId: c!.id, branchId: body.branchId, after: c });
      if (body.severity === 'high' || body.severity === 'critical') {
        await notifyStaff({ type: 'complaint', title: `${body.severity.toUpperCase()} complaint recorded`, body: body.description.slice(0, 200), severity: 'warning', branchId: body.branchId, permission: 'complaints.manage', data: { complaintId: c!.id } }, tx);
      }
      return c;
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/complaints/:id', summary: 'Update a complaint (status, resolution, compensation, follow-up)', tags: ['Feedback'], permission: 'complaints.manage', params: idParams, body: complaintUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.complaints).where(eq(schema.complaints.id, params.id));
      if (!before || before.deletedAt) throw notFound('Complaint');
      assertBranchAccess(ctx, before.branchId);
      const resolving = body.status && ['resolved', 'closed'].includes(body.status) && !before.resolvedAt;
      const [after] = await tx
        .update(schema.complaints)
        .set({
          ...body,
          followUpAt: body.followUpAt === undefined ? undefined : body.followUpAt ? new Date(body.followUpAt) : null,
          resolvedAt: resolving ? new Date() : undefined,
          resolvedBy: resolving ? ctx.user!.id : undefined,
          updatedBy: ctx.user!.id,
        })
        .where(eq(schema.complaints.id, params.id))
        .returning();
      await audit(tx, ctx, { action: 'complaint.update', entityType: 'complaint', entityId: params.id, branchId: before.branchId, before, after });
      return after;
    }),
  );
}
