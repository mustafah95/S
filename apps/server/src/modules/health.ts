import type { FastifyInstance } from 'fastify';
import { statfs } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { APP_VERSION } from '@sofia/shared';
import { config } from '../config.js';
import { getDb, q, q1, sql } from '../db/pool.js';
import { migrationStatus } from '../db/migrator.js';
import { defineRoute } from '../lib/route.js';
import { getSetting } from '../lib/settings.js';
import { internetStatus } from './system/internet.js';

type Level = 'ok' | 'warn' | 'error';
interface Check {
  status: Level;
  [k: string]: unknown;
}

const started = Date.now();

async function freeBytes(dir: string): Promise<number | null> {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Full health report used by /health, the Server Manager and the updater's post-install verification. */
export async function healthReport(): Promise<{ status: 'ok' | 'degraded' | 'down'; version: string; checks: Record<string, Check> }> {
  const checks: Record<string, Check> = {};
  checks.api = { status: 'ok', uptimeSeconds: Math.round((Date.now() - started) / 1000), memoryMb: Math.round(process.memoryUsage().rss / 1048576), pid: process.pid };
  const db = getDb();
  try {
    const t = Date.now();
    const row = await q1<{ v: string }>(db, sql`SELECT current_setting('server_version') AS v`);
    checks.database = { status: 'ok', latencyMs: Date.now() - t, postgres: row?.v };
  } catch (err) {
    checks.database = { status: 'error', error: (err as Error).message };
    return { status: 'down', version: APP_VERSION, checks };
  }
  try {
    const m = await migrationStatus(config.databaseOwnerUrl, config.migrationsDir);
    checks.migrations = { status: m.pending.length || m.checksumMismatches.length ? 'error' : 'ok', current: m.current, latest: m.latest, pending: m.pending.length };
  } catch (err) {
    checks.migrations = { status: 'warn', error: (err as Error).message };
  }
  const dataFree = await freeBytes(config.dataDir);
  const backupFree = await freeBytes(config.backupDir);
  const minFree = Math.min(dataFree ?? Infinity, backupFree ?? Infinity);
  checks.storage = { status: minFree < 1e9 ? 'error' : minFree < 5e9 ? 'warn' : 'ok', dataDirFreeBytes: dataFree, backupDirFreeBytes: backupFree };

  const [queue] = await q<{ pending: number; failed: number; oldest_s: number | null }>(
    db,
    sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
               extract(epoch FROM now() - min(next_attempt_at) FILTER (WHERE status = 'pending'))::int AS oldest_s
        FROM notification_outbox`,
  );
  checks.queue = { status: (queue?.oldest_s ?? 0) > 3600 ? 'warn' : 'ok', pending: queue?.pending ?? 0, failed24h: queue?.failed ?? 0, oldestPendingSeconds: queue?.oldest_s ?? null };

  const [sync] = await q<{ open: number; rejected: number; last: Date | null }>(
    db,
    sql`SELECT (SELECT count(*)::int FROM sync_conflicts WHERE status = 'open') AS open,
               (SELECT count(*)::int FROM sync_operations WHERE status = 'rejected' AND received_at > now() - interval '24 hours') AS rejected,
               (SELECT max(received_at) FROM sync_operations) AS last`,
  );
  checks.sync = { status: (sync?.open ?? 0) > 0 ? 'warn' : 'ok', openConflicts: sync?.open ?? 0, rejected24h: sync?.rejected ?? 0, lastOperationAt: sync?.last ?? null };

  const backupSettings = await getSetting('backup');
  const last = await q1<{ finished_at: Date; status: string }>(db, sql`SELECT finished_at, status FROM backups WHERE status = 'completed' ORDER BY finished_at DESC NULLS LAST LIMIT 1`);
  const lastFailed = await q1<{ started_at: Date; error: string }>(db, sql`SELECT started_at, error FROM backups WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`);
  const ageH = last ? (Date.now() - new Date(last.finished_at).getTime()) / 3600_000 : null;
  const maxAge = backupSettings.frequency === 'weekly' ? 7 * 24 + 2 : backupSettings.frequency === 'daily' ? 26 : 14;
  checks.backup = {
    status: !backupSettings.enabled ? 'warn' : ageH === null || ageH > maxAge ? 'warn' : 'ok',
    enabled: backupSettings.enabled,
    lastSuccessAt: last?.finished_at ?? null,
    lastFailureAt: lastFailed?.started_at ?? null,
    lastFailureError: lastFailed?.error ?? null,
  };

  const pos = await q<{ name: string; last_error: string | null; last_sync_at: Date | null; is_active: boolean }>(
    db,
    sql`SELECT name, last_error, last_sync_at, is_active FROM pos_connections WHERE deleted_at IS NULL`,
  );
  const wa = await getSetting('integrations.whatsapp');
  const email = await getSetting('integrations.email');
  checks.integrations = {
    status: pos.some((p) => p.is_active && p.last_error) ? 'warn' : 'ok',
    pos: pos.map((p) => ({ name: p.name, active: p.is_active, lastSyncAt: p.last_sync_at, lastError: p.last_error })),
    whatsapp: wa.enabled && wa.secretsSet ? 'configured' : 'not_configured',
    email: email.enabled && email.host ? 'configured' : 'not_configured',
  };
  const internet = internetStatus();
  checks.internet = { status: internet.online === false ? 'warn' : 'ok', ...internet };
  const m = await getSetting('system.maintenance');
  checks.maintenance = { status: m.enabled ? 'warn' : 'ok', enabled: m.enabled, reason: m.reason };

  const statuses = Object.values(checks).map((c) => c.status);
  return { status: statuses.includes('error') ? 'degraded' : 'ok', version: APP_VERSION, checks };
}

function isLocal(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, { method: 'GET', url: '/health/live', summary: 'Liveness probe', tags: ['Health'], auth: 'none' }, async () => ({ status: 'ok', version: APP_VERSION }));

  defineRoute(app, { method: 'GET', url: '/health/ready', summary: 'Readiness probe (database reachable)', tags: ['Health'], auth: 'none' }, async ({ reply }) => {
    try {
      await getDb().execute(sql`SELECT 1`);
      return { status: 'ok', version: APP_VERSION };
    } catch {
      return reply.code(503).send({ status: 'down', version: APP_VERSION });
    }
  });

  defineRoute(app, { method: 'GET', url: '/health', summary: 'Health of API, database, storage, queue, sync, backups, integrations (details for admins / localhost)', tags: ['Health'], auth: 'none' }, async ({ req, reply }) => {
    const report = await healthReport();
    let user = req.ctx.user;
    if (!user) {
      const { COOKIE_ACCESS } = await import('./auth/routes.js');
      const { loadAuthUser, verifyAccessToken } = await import('./auth/service.js');
      const token = req.cookies[COOKIE_ACCESS] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
      const claims = token ? verifyAccessToken(token) : null;
      user = claims ? (await loadAuthUser(claims.userId, claims.sessionId)) ?? undefined : undefined;
    }
    const detailed = isLocal(req.ip) || user?.permissions.has('system.health');
    reply.code(report.status === 'down' ? 503 : 200);
    return detailed ? report : { status: report.status, version: report.version };
  });
}
