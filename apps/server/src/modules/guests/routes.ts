import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  guestCreateSchema,
  guestListQuerySchema,
  guestMergeSchema,
  guestNoteSchema,
  guestOccasionSchema,
  guestUpdateSchema,
  zId,
} from '@sofia/shared';
import { getDb, q, schema, sql, camelRows } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { defineRoute, idParams } from '../../lib/route.js';
import { segmentWhere } from '../marketing/segments.js';
import {
  addGuestNote,
  anonymizeGuest,
  createGuest,
  exportGuestData,
  findDuplicates,
  getGuest,
  guestProfile,
  guestView,
  mergeGuests,
  updateGuest,
} from './service.js';

const SORTS: Record<string, ReturnType<typeof sql>> = {
  name: sql`lower(first_name), lower(coalesce(last_name, ''))`,
  last_visit: sql`last_visit_at DESC NULLS LAST`,
  total_spend: sql`total_spend DESC`,
  visits: sql`visit_count DESC`,
  created: sql`created_at DESC`,
};

export async function registerGuestRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/guests', summary: 'Search and list guests', tags: ['Guests'], permission: 'guests.read', query: guestListQuerySchema }, async ({ query }) => {
    const conds = [sql`g.deleted_at IS NULL`, sql`g.merged_into_id IS NULL`];
    if (query.q) {
      const term = query.q.trim();
      const digits = term.replace(/\D/g, '');
      conds.push(sql`(
        lower(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '') || ' ' || coalesce(g.preferred_name, '')) LIKE ${'%' + term.toLowerCase() + '%'}
        OR lower(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '') || ' ' || coalesce(g.preferred_name, '')) % ${term.toLowerCase()}
        OR g.email = ${term}::citext
        OR g.loyalty_number = ${term.toUpperCase()}
        ${digits.length >= 4 ? sql`OR g.phone_normalized LIKE ${'%' + digits.slice(-9) + '%'}` : sql``})`);
    }
    if (query.vipLevel) conds.push(sql`g.vip_level = ${query.vipLevel}`);
    if (query.tag) conds.push(sql`${query.tag} = ANY (g.tags)`);
    if (query.segment) conds.push(await segmentWhere(db, query.segment));
    const where = sql.join(conds, sql` AND `);
    const offset = (query.page - 1) * query.pageSize;
    const [rows, count] = await Promise.all([
      q(db, sql`SELECT g.* FROM guests g WHERE ${where} ORDER BY ${SORTS[query.sort]!} LIMIT ${query.pageSize} OFFSET ${offset}`),
      q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM guests g WHERE ${where}`),
    ]);
    return {
      items: camelRows(rows).map((g) => {
        const { privacyToken: _p, ...rest } = g as Record<string, unknown>;
        return rest;
      }),
      total: count[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/guests', summary: 'Create a guest (returns possible duplicates)', tags: ['Guests'], permission: 'guests.create', body: guestCreateSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const r = await createGuest(tx, ctx, body);
      return { guest: guestView(r.guest), duplicates: r.duplicates };
    }),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/guests/duplicates', summary: 'Check for existing guests matching phone / email / name', tags: ['Guests'], permission: 'guests.read', query: z.object({ phone: z.string().max(40).optional(), email: z.string().max(200).optional(), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), excludeId: zId.optional() }) }, async ({ query }) =>
    findDuplicates(db, query, query.excludeId),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/guests/duplicate-candidates', summary: 'Scan the database for likely duplicate guest pairs', tags: ['Guests'], permission: 'guests.merge', query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async ({ query }) => {
    const rows = await q(
      db,
      sql`SELECT a.id AS a_id, a.first_name AS a_first_name, a.last_name AS a_last_name, a.phone AS a_phone, a.email AS a_email, a.visit_count AS a_visits,
                 b.id AS b_id, b.first_name AS b_first_name, b.last_name AS b_last_name, b.phone AS b_phone, b.email AS b_email, b.visit_count AS b_visits,
                 CASE WHEN a.phone_normalized = b.phone_normalized THEN 'phone' WHEN a.email = b.email THEN 'email' ELSE 'name' END AS reason
          FROM guests a JOIN guests b ON a.id < b.id
           AND b.deleted_at IS NULL AND b.merged_into_id IS NULL
           AND (a.phone_normalized = b.phone_normalized OR a.email = b.email)
          WHERE a.deleted_at IS NULL AND a.merged_into_id IS NULL
          LIMIT ${query.limit}`,
    );
    return camelRows(rows);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/guests/:id', summary: 'Get a guest', tags: ['Guests'], permission: 'guests.read', params: idParams }, async ({ params }) =>
    guestView(await getGuest(db, params.id, { includeDeleted: true })),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/guests/:id/profile', summary: 'Guest 360° profile: history, spending, favourites, loyalty, feedback', tags: ['Guests'], permission: 'guests.read', params: idParams }, async ({ params, user }) => {
    const profile = await guestProfile(db, params.id);
    if (!user.permissions.has('analytics.owner') && !user.permissions.has('pos.read')) {
      // Front-of-house roles see visit history but not invoice-level financial detail.
      return { ...profile, invoices: [], stats: { ...profile.stats, monthlySpending: [], yearlySpending: [], revenueByBranch: [] } };
    }
    return profile;
  });

  defineRoute(app, { method: 'PATCH', url: '/api/v1/guests/:id', summary: 'Update a guest (optimistic concurrency via expectedVersion)', tags: ['Guests'], permission: 'guests.update', params: idParams, body: guestUpdateSchema.extend({ expectedVersion: z.number().int().optional() }) }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const { expectedVersion, ...patch } = body;
      return guestView(await updateGuest(tx, ctx, params.id, patch, { expectedVersion }));
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/guests/:id/anonymize', summary: 'Anonymise a guest (privacy deletion request)', tags: ['Guests', 'Privacy'], permission: 'guests.delete', params: idParams }, async ({ params, ctx }) =>
    db.transaction(async (tx) => guestView(await anonymizeGuest(tx, ctx, params.id))),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/guests/:id', summary: 'Archive a guest record (soft delete)', tags: ['Guests'], permission: 'guests.delete', params: idParams }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      const before = await getGuest(tx, params.id);
      await tx.update(schema.guests).set({ deletedAt: new Date(), updatedBy: ctx.user?.id ?? null }).where(eq(schema.guests.id, params.id));
      await audit(tx, ctx, { action: 'guest.delete', entityType: 'guest', entityId: params.id, before });
      await publish({ type: 'changes', entities: ['guests'] }, tx);
      return { ok: true };
    }),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/guests/:id/export', summary: 'Export all personal data of a guest (JSON)', tags: ['Guests', 'Privacy'], permission: 'guests.export', params: idParams }, async ({ params, ctx, reply }) => {
    const data = await exportGuestData(db, params.id);
    await audit(db, ctx, { action: 'guest.export', entityType: 'guest', entityId: params.id });
    reply.header('content-disposition', `attachment; filename="guest-${params.id}.json"`);
    return data;
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/guests/:id/merge', summary: 'Merge duplicate guests into this guest', tags: ['Guests'], permission: 'guests.merge', params: idParams, body: guestMergeSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => guestView(await mergeGuests(tx, ctx, params.id, body.sourceIds))),
  );

  // Notes -----------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/guests/:id/notes', summary: 'Guest notes', tags: ['Guests'], permission: 'guests.read', params: idParams }, async ({ params }) =>
    db.select().from(schema.guestNotes).where(and(eq(schema.guestNotes.guestId, params.id), isNull(schema.guestNotes.deletedAt))).orderBy(desc(schema.guestNotes.isPinned), desc(schema.guestNotes.createdAt)),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/guests/:id/notes', summary: 'Add a note to a guest', tags: ['Guests'], permission: 'guests.update', params: idParams, body: guestNoteSchema.omit({ guestId: true }) }, async ({ params, body, ctx }) =>
    db.transaction((tx) => addGuestNote(tx, ctx, { ...body, guestId: params.id })),
  );

  // Occasions -------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/guests/:id/occasions', summary: 'Special occasions of a guest', tags: ['Guests'], permission: 'guests.read', params: idParams }, async ({ params }) =>
    db.select().from(schema.guestOccasions).where(and(eq(schema.guestOccasions.guestId, params.id), isNull(schema.guestOccasions.deletedAt))),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/guests/:id/occasions', summary: 'Add a special occasion (birthday, anniversary, …)', tags: ['Guests'], permission: 'guests.update', params: idParams, body: guestOccasionSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      await getGuest(tx, params.id);
      const [o] = await tx.insert(schema.guestOccasions).values({ ...body, guestId: params.id, createdBy: ctx.user?.id }).returning();
      if (body.type === 'birthday' || body.type === 'anniversary') {
        await tx.update(schema.guests).set({ [body.type]: body.date }).where(eq(schema.guests.id, params.id));
      }
      await audit(tx, ctx, { action: 'guest.occasion_add', entityType: 'guest', entityId: params.id, after: o });
      await publish({ type: 'changes', entities: ['guests'] }, tx);
      return o;
    }),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/guests/:id/occasions/:occasionId', summary: 'Remove an occasion', tags: ['Guests'], permission: 'guests.update', params: z.object({ id: zId, occasionId: zId }) }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      const [o] = await tx
        .update(schema.guestOccasions)
        .set({ deletedAt: new Date(), updatedBy: ctx.user?.id ?? null })
        .where(and(eq(schema.guestOccasions.id, params.occasionId), eq(schema.guestOccasions.guestId, params.id)))
        .returning();
      if (!o) throw notFound('Occasion');
      await audit(tx, ctx, { action: 'guest.occasion_delete', entityType: 'guest', entityId: params.id, before: o });
      return { ok: true };
    }),
  );
}
