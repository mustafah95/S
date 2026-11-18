import type { FastifyInstance } from 'fastify';
import { subscribe, type SofiaEvent } from '../lib/events.js';
import type { AuthUser } from '../lib/context.js';
import { unauthorized } from '../lib/errors.js';
import { defineRoute } from '../lib/route.js';

function visibleTo(user: AuthUser, e: SofiaEvent): boolean {
  const branchOk = (b?: string | null) => !b || user.allBranches || user.branchIds.includes(b);
  switch (e.type) {
    case 'changes':
      return branchOk(e.branchId);
    case 'table_freed':
      return branchOk(e.branchId);
    case 'notification':
      if (e.userId) return e.userId === user.id;
      return branchOk(e.branchId) && (!e.permission || user.permissions.has(e.permission));
    case 'maintenance':
      return true;
    default:
      return false;
  }
}

/** Server-Sent Events stream: live table status, reservation changes, conflicts and staff notifications. */
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, { method: 'GET', url: '/api/v1/events', summary: 'Live event stream (text/event-stream)', tags: ['Live'], allowInMaintenance: true }, async ({ req, reply }) => {
    const user = req.ctx.user;
    if (!user) throw unauthorized();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const unsubscribe = subscribe((e) => {
      if (!visibleTo(user, e)) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
