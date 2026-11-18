import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_VERSION, SYNC_PROTOCOL_VERSION, syncPushSchema, zId } from '@sofia/shared';
import { camelRows, getDb, q, sql } from '../../db/pool.js';
import { branchScope } from '../../lib/context.js';
import { upgradeRequired } from '../../lib/errors.js';
import { defineRoute, idParams } from '../../lib/route.js';
import { getSetting } from '../../lib/settings.js';
import { internetStatus } from '../system/internet.js';
import { processPull, processPush, resolveConflict, syncStatus, touchDevice } from './service.js';

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/sync/ping', summary: 'Connectivity probe: server reachability, internet status, maintenance', tags: ['Sync'], auth: 'optional', allowInMaintenance: true, rateLimit: { max: 600, timeWindow: '1 minute' } },
    async ({ ctx }) => {
      const m = await getSetting('system.maintenance');
      return {
        ok: true,
        serverTime: new Date().toISOString(),
        version: APP_VERSION,
        protocol: SYNC_PROTOCOL_VERSION,
        internet: internetStatus(),
        maintenance: m.enabled,
        authenticated: !!ctx.user,
      };
    },
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/sync/push', summary: 'Upload offline operations (idempotent, ordered, conflict-aware)', tags: ['Sync'], body: syncPushSchema, bodyLimit: 5 * 1024 * 1024 },
    async ({ body, ctx }) => {
      if (body.protocol > SYNC_PROTOCOL_VERSION) throw upgradeRequired('The server is older than this app. Please contact the administrator.');
      const results = await processPush(ctx, body.deviceId, body.ops);
      return { serverTime: new Date().toISOString(), results };
    },
  );

  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/sync/pull', summary: 'Download changes since a cursor (gap-free change feed)', tags: ['Sync'], query: z.object({ cursor: z.string().max(30).optional(), deviceId: zId.optional() }), allowInMaintenance: true },
    async ({ query, ctx, req }) => {
      if (query.deviceId) await touchDevice(ctx, query.deviceId, false, String(req.headers['x-sofia-client-version'] ?? '') || undefined);
      return processPull(ctx, query.cursor);
    },
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/sync/status', summary: 'Sync dashboard data', tags: ['Sync'], query: z.object({ deviceId: zId.optional() }), allowInMaintenance: true }, async ({ ctx, query }) =>
    syncStatus(ctx, query.deviceId),
  );

  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/sync/conflicts', summary: 'Synchronisation conflicts for review', tags: ['Sync'], permission: ['sync.review', 'guests.merge'], query: z.object({ status: z.string().max(40).default('open'), deviceId: zId.optional() }) },
    async ({ query, ctx }) => {
      const scope = branchScope(ctx);
      const rows = await q(
        getDb(),
        sql`SELECT c.*, u.display_name AS user_name, r.display_name AS resolved_by_name
            FROM sync_conflicts c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users r ON r.id = c.resolved_by
            WHERE (${query.status} = 'all' OR c.status = ${query.status})
              AND (${query.deviceId ?? null}::uuid IS NULL OR c.device_id = ${query.deviceId ?? null}::uuid)
              ${scope ? (scope.length ? sql`AND (c.branch_id IS NULL OR c.branch_id IN ${scope})` : sql`AND c.branch_id IS NULL`) : sql``}
            ORDER BY c.created_at DESC LIMIT 200`,
      );
      return camelRows(rows);
    },
  );

  defineRoute(
    app,
    {
      method: 'POST',
      url: '/api/v1/sync/conflicts/:id/resolve',
      summary: 'Resolve a conflict: keep server value, take device value, custom values, or dismiss',
      tags: ['Sync'],
      permission: ['sync.review', 'guests.merge'],
      params: idParams,
      body: z.object({ resolution: z.enum(['keep_server', 'take_client', 'custom', 'dismiss']), values: z.record(z.string(), z.unknown()).optional() }),
    },
    async ({ params, body, ctx }) => resolveConflict(ctx, params.id, body.resolution, body.values),
  );
}
