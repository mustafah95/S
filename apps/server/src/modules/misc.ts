import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zId } from '@sofia/shared';
import { camelRows, getDb, q, sql } from '../db/pool.js';
import { branchScope, can } from '../lib/context.js';
import { defineRoute, idParams } from '../lib/route.js';

/** Audit log viewer, global search and the staff in-app inbox. */
export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(
    app,
    {
      method: 'GET',
      url: '/api/v1/audit',
      summary: 'Audit trail (who changed what, old and new values)',
      tags: ['Audit'],
      permission: 'audit.read',
      query: z.object({
        entityType: z.string().max(40).optional(),
        entityId: z.string().max(100).optional(),
        userId: zId.optional(),
        action: z.string().max(60).optional(),
        from: z.string().max(30).optional(),
        to: z.string().max(30).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ query }) => {
      const conds = [sql`true`];
      if (query.entityType) conds.push(sql`a.entity_type = ${query.entityType}`);
      if (query.entityId) conds.push(sql`a.entity_id = ${query.entityId}`);
      if (query.userId) conds.push(sql`(a.user_id = ${query.userId} OR a.offline_user_id = ${query.userId})`);
      if (query.action) conds.push(sql`a.action LIKE ${query.action + '%'}`);
      if (query.from) conds.push(sql`a.at >= ${query.from}::timestamptz`);
      if (query.to) conds.push(sql`a.at < ${query.to}::timestamptz`);
      const where = sql.join(conds, sql` AND `);
      const rows = await q(
        db,
        sql`SELECT a.*, u.display_name AS user_name, ou.display_name AS offline_user_name
            FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users ou ON ou.id = a.offline_user_id
            WHERE ${where} ORDER BY a.at DESC, a.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      );
      return { items: camelRows(rows) };
    },
  );

  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/search', summary: 'Global search: guests, phone, e-mail, reservation number, table, invoice, loyalty ID', tags: ['Search'], query: z.object({ q: z.string().trim().min(2).max(100) }) },
    async ({ query, ctx }) => {
      const term = query.q;
      const like = `%${term.toLowerCase()}%`;
      const digits = term.replace(/\D/g, '');
      const scope = branchScope(ctx);
      const branchFilter = (col: string) => (scope ? (scope.length ? sql`AND ${sql.identifier(col)} IN ${scope}` : sql`AND false`) : sql``);
      const out: Record<string, unknown[]> = { guests: [], reservations: [], tables: [], invoices: [] };
      if (can(ctx, 'guests.read')) {
        out.guests = camelRows(
          await q(
            db,
            sql`SELECT id, first_name, last_name, phone, email, vip_level, loyalty_number, visit_count, last_visit_at
                FROM guests WHERE deleted_at IS NULL AND merged_into_id IS NULL AND (
                  lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(preferred_name, '')) LIKE ${like}
                  OR lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(preferred_name, '')) % ${term.toLowerCase()}
                  OR email = ${term}::citext OR loyalty_number = ${term.toUpperCase()}
                  ${digits.length >= 4 ? sql`OR phone_normalized LIKE ${'%' + digits.slice(-9) + '%'}` : sql``})
                ORDER BY visit_count DESC LIMIT 10`,
          ),
        );
      }
      if (can(ctx, 'reservations.read')) {
        out.reservations = camelRows(
          await q(
            db,
            sql`SELECT id, code, branch_id, business_date, start_at, party_size, status, guest_name
                FROM reservations WHERE deleted_at IS NULL ${branchFilter('branch_id')}
                  AND (lower(code) LIKE ${like} OR lower(coalesce(guest_name, '')) LIKE ${like})
                ORDER BY start_at DESC LIMIT 10`,
          ),
        );
      }
      if (can(ctx, 'tables.read')) {
        out.tables = camelRows(
          await q(db, sql`SELECT id, label, branch_id, area_id, capacity FROM restaurant_tables WHERE deleted_at IS NULL ${branchFilter('branch_id')} AND lower(label) LIKE ${like} LIMIT 10`),
        );
      }
      if (can(ctx, 'pos.read')) {
        out.invoices = camelRows(
          await q(db, sql`SELECT id, invoice_number, external_id, closed_at, total, currency, guest_id FROM pos_invoices
                          WHERE deleted_at IS NULL ${branchFilter('branch_id')} AND (lower(coalesce(invoice_number, '')) LIKE ${like} OR lower(external_id) LIKE ${like})
                          ORDER BY closed_at DESC LIMIT 10`),
        );
      }
      return out;
    },
  );

  // In-app staff inbox -----------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/inbox', summary: 'Staff notifications for the current user', tags: ['Notifications'], allowInMaintenance: true }, async ({ user }) => {
    const perms = [...user.permissions];
    const rows = await q(
      db,
      sql`SELECT n.*, (r.read_at IS NOT NULL) AS read
          FROM in_app_notifications n
          LEFT JOIN in_app_notification_reads r ON r.notification_id = n.id AND r.user_id = ${user.id}
          WHERE n.created_at > now() - interval '7 days'
            AND (n.expires_at IS NULL OR n.expires_at > now())
            AND (n.user_id = ${user.id} OR (n.user_id IS NULL
                 AND (n.permission IS NULL ${perms.length ? sql`OR n.permission IN ${perms}` : sql``})
                 AND (n.branch_id IS NULL ${user.allBranches ? sql`OR true` : user.branchIds.length ? sql`OR n.branch_id IN ${user.branchIds}` : sql``})))
          ORDER BY n.created_at DESC LIMIT 100`,
    );
    return camelRows(rows);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/inbox/:id/read', summary: 'Mark a notification as read', tags: ['Notifications'], params: idParams, allowInMaintenance: true }, async ({ params, user }) => {
    await db.execute(sql`INSERT INTO in_app_notification_reads (notification_id, user_id) VALUES (${params.id}, ${user.id}) ON CONFLICT DO NOTHING`);
    return { ok: true };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/inbox/read-all', summary: 'Mark all notifications as read', tags: ['Notifications'], allowInMaintenance: true }, async ({ user }) => {
    await db.execute(sql`INSERT INTO in_app_notification_reads (notification_id, user_id)
                         SELECT id, ${user.id} FROM in_app_notifications WHERE created_at > now() - interval '7 days' ON CONFLICT DO NOTHING`);
    return { ok: true };
  });
}
