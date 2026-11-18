import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { hostname, networkInterfaces, platform, release as osRelease } from 'node:os';
import { z } from 'zod';
import { APP_VERSION, compareVersions } from '@sofia/shared';
import { config } from '../../config.js';
import { camelRows, getDb, q, q1, sql } from '../../db/pool.js';
import { migrationStatus, runMigrations, applyRuntimeGrants } from '../../db/migrator.js';
import { seedReferenceData } from '../../db/seed.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { defineRoute, idParams } from '../../lib/route.js';
import { getSetting, putSetting } from '../../lib/settings.js';
import { logEvent } from '../../lib/system-events.js';
import { createController } from '../../updater/controller.js';
import { downloadRelease, fetchFeed, latestApplicable, loadPublicKey, readCurrent, type ReleaseEntry } from '../../updater/package.js';
import { healthReport } from '../health.js';
import { createBackup, getBackup, listBackups, restoreBackup, verifyBackupFile } from './backup.js';
import { join } from 'node:path';

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function installRoot() {
  return config.installRoot ?? config.dataDir;
}

function publicKey(): string {
  return loadPublicKey(config.updatePublicKey, installRoot());
}

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/system/status', summary: 'Server Manager overview: services, health, addresses, versions', tags: ['System'], permission: 'system.health', allowInMaintenance: true }, async () => {
    const health = await healthReport();
    const ips = lanAddresses();
    const general = await getSetting('general');
    return {
      version: APP_VERSION,
      health,
      server: {
        hostname: hostname(),
        platform: `${platform()} ${osRelease()}`,
        node: process.version,
        ipAddresses: ips,
        localUrls: ips.map((ip) => `http://${ip}${config.port === 80 ? '' : `:${config.port}`}`),
        publicUrl: general.publicBaseUrl || config.publicUrl || null,
        installRoot: installRoot(),
        current: readCurrent(installRoot()),
        serviceController: config.serviceController,
        services: [
          { name: 'PostgreSQL', status: health.checks.database?.status === 'ok' ? 'running' : 'stopped' },
          { name: 'API Server', status: 'running' },
          { name: 'Web Server', status: existsSync(join(config.webDir, 'index.html')) ? 'running' : 'stopped' },
          { name: 'Sync Engine', status: 'running' },
          { name: 'Backup Service', status: health.checks.backup?.enabled ? 'running' : 'disabled' },
          { name: 'Update Service', status: config.updateFeedUrl ? 'running' : 'not_configured' },
        ],
      },
    };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/system/restart', summary: 'Restart the API and worker services', tags: ['System'], permission: 'system.update', allowInMaintenance: true }, async ({ ctx }) => {
    await audit(db, ctx, { action: 'system.restart', entityType: 'system', entityId: 'services' });
    await logEvent('warn', 'app', 'Restart requested from the Update Center', { by: ctx.user?.id });
    setTimeout(() => void createController().restart(['worker', 'api']), 500);
    return { ok: true };
  });

  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/system/logs', summary: 'Application, security, sync, update, backup and integration logs', tags: ['System'], permission: 'system.logs', allowInMaintenance: true, query: z.object({ category: z.string().max(30).optional(), level: z.enum(['debug', 'info', 'warn', 'error']).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), before: z.coerce.number().int().optional() }) },
    async ({ query }) => {
      const conds = [sql`true`];
      if (query.category) conds.push(sql`category = ${query.category}`);
      if (query.level) conds.push(sql`level = ${query.level}`);
      if (query.q) conds.push(sql`message ILIKE ${'%' + query.q + '%'}`);
      if (query.before) conds.push(sql`id < ${query.before}`);
      return camelRows(await q(db, sql`SELECT * FROM system_events WHERE ${sql.join(conds, sql` AND `)} ORDER BY id DESC LIMIT ${query.limit}`));
    },
  );

  // Backups ---------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/backups', summary: 'Backup history', tags: ['Backup'], permission: 'system.backup', allowInMaintenance: true }, async () => listBackups());

  defineRoute(app, { method: 'POST', url: '/api/v1/backups', summary: 'Create a verified backup now', tags: ['Backup'], permission: 'system.backup', allowInMaintenance: true }, async ({ ctx }) => createBackup('manual', ctx));

  defineRoute(app, { method: 'POST', url: '/api/v1/backups/:id/verify', summary: 'Re-verify a backup file (checksum + archive structure)', tags: ['Backup'], permission: 'system.backup', params: idParams, body: z.object({ mode: z.enum(['list', 'full']).default('list') }) }, async ({ params, body }) => {
    const b = await getBackup(params.id);
    const { sha256File } = await import('../../updater/package.js');
    if (!existsSync(b.file_path)) throw new AppError(422, 'backup_missing', 'Backup file no longer exists on disk');
    if (b.sha256 && (await sha256File(b.file_path)) !== b.sha256) throw new AppError(422, 'backup_corrupt', 'Checksum mismatch');
    try {
      await verifyBackupFile(b.file_path, body.mode);
      await db.execute(sql`UPDATE backups SET verify_status = 'passed', verified_at = now(), verify_error = NULL WHERE id = ${params.id}`);
      return { ok: true };
    } catch (err) {
      await db.execute(sql`UPDATE backups SET verify_status = 'failed', verify_error = ${(err as Error).message} WHERE id = ${params.id}`);
      throw new AppError(422, 'verify_failed', (err as Error).message);
    }
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/backups/:id/restore', summary: 'Restore a backup (a safety backup is taken first)', tags: ['Backup'], permission: 'system.restore', params: idParams, allowInMaintenance: true, body: z.object({ confirm: z.literal('RESTORE') }) }, async ({ params, ctx }) => {
    const r = await restoreBackup(params.id, ctx, async () => {
      await runMigrations(config.databaseOwnerUrl, config.migrationsDir);
      if (config.dbAppRole) await applyRuntimeGrants(config.databaseOwnerUrl, config.dbAppRole);
      await db.transaction((tx) => seedReferenceData(tx));
    });
    return { ok: true, ...r };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/backups/:id/download', summary: 'Download a backup file (PostgreSQL custom format)', tags: ['Backup', 'Data ownership'], permission: 'system.backup', params: idParams }, async ({ params, reply, ctx }) => {
    const b = await getBackup(params.id);
    if (!existsSync(b.file_path)) throw new AppError(404, 'not_found', 'Backup file not found');
    await audit(db, ctx, { action: 'backup.download', entityType: 'backup', entityId: params.id });
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${b.file_name}"`);
    return reply.send(createReadStream(b.file_path));
  });

  // Updates ---------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/updates/status', summary: 'Update Center: versions, release notes, migrations, backups, pending job', tags: ['Updates'], permission: ['system.update', 'system.health'], allowInMaintenance: true }, async () => {
    const state = await getSetting('system.update');
    const migrations = await migrationStatus(config.databaseOwnerUrl, config.migrationsDir);
    const lastBackup = await q1(db, sql`SELECT id, file_name AS "fileName", finished_at AS "finishedAt", kind FROM backups WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1`);
    const job = await q1(db, sql`SELECT * FROM system_updates WHERE status NOT IN ('completed', 'failed', 'rolled_back') ORDER BY started_at DESC LIMIT 1`);
    const latest = state.latest as unknown as ReleaseEntry | null;
    const pointer = readCurrent(installRoot());
    return {
      currentVersion: APP_VERSION,
      latestVersion: latest?.version ?? null,
      updateAvailable: !!latest && compareVersions(latest.version, APP_VERSION) > 0,
      releaseNotes: latest?.notes ?? null,
      releasedAt: latest?.releasedAt ?? null,
      lastCheckAt: state.lastCheckAt,
      downloaded: state.downloaded,
      feedConfigured: !!config.updateFeedUrl,
      lastError: state.lastError,
      previousVersion: pointer?.previous ?? null,
      migrations: { current: migrations.current, latest: migrations.latest, pending: migrations.pending, applied: migrations.applied.slice(-10) },
      lastBackup,
      activeJob: job ? camelRows([job])[0] : null,
    };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/updates/check', summary: 'Check the trusted update server for a newer signed release', tags: ['Updates'], permission: 'system.update', allowInMaintenance: true }, async ({ ctx }) => {
    if (!config.updateFeedUrl) throw badRequest('No update server configured (SOFIA_UPDATE_FEED_URL)');
    const state = await getSetting('system.update');
    try {
      const feed = await fetchFeed(config.updateFeedUrl);
      const latest = latestApplicable(feed, APP_VERSION, publicKey());
      await putSetting(db, ctx, 'system.update', { ...state, lastCheckAt: new Date().toISOString(), latest: latest as never, lastError: null });
      await logEvent('info', 'update', latest ? `Update ${latest.version} available` : 'No update available');
      return { updateAvailable: !!latest, latest };
    } catch (err) {
      await putSetting(db, ctx, 'system.update', { ...state, lastCheckAt: new Date().toISOString(), lastError: (err as Error).message });
      throw new AppError(502, 'update_check_failed', (err as Error).message);
    }
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/updates/download', summary: 'Download and verify the latest release package', tags: ['Updates'], permission: 'system.update', allowInMaintenance: true }, async ({ ctx }) => {
    const state = await getSetting('system.update');
    const latest = state.latest as unknown as ReleaseEntry | null;
    if (!latest) throw badRequest('Check for updates first');
    const path = await downloadRelease(latest, join(config.dataDir, 'updates'), publicKey());
    const downloaded = { version: latest.version, path, sha256: latest.sha256, verifiedAt: new Date().toISOString() };
    await putSetting(db, ctx, 'system.update', { ...state, downloaded });
    await logEvent('info', 'update', `Release ${latest.version} downloaded and verified`);
    return { ok: true, downloaded };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/updates/install', summary: 'Install the downloaded release (runs in the updater service)', tags: ['Updates'], permission: 'system.update', allowInMaintenance: true }, async ({ ctx }) => {
    const state = await getSetting('system.update');
    const latest = state.latest as unknown as ReleaseEntry | null;
    if (!latest) throw badRequest('Check for updates first');
    const active = await q1(db, sql`SELECT id FROM system_updates WHERE status NOT IN ('completed', 'failed', 'rolled_back')`);
    if (active) throw new AppError(409, 'update_in_progress', 'An update is already in progress');
    const [job] = await q<{ id: string }>(
      db,
      sql`INSERT INTO system_updates (from_version, to_version, status, manifest, initiated_by)
          VALUES (${APP_VERSION}, ${latest.version}, 'pending', ${JSON.stringify(latest)}::jsonb, ${ctx.user!.id}) RETURNING id`,
    );
    await putSetting(db, ctx, 'system.update', { ...state, pendingJobId: job!.id });
    await audit(db, ctx, { action: 'update.install', entityType: 'system', entityId: job!.id, meta: { from: APP_VERSION, to: latest.version } });
    return { jobId: job!.id };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/updates/rollback', summary: 'Roll back to the previous installed release', tags: ['Updates'], permission: 'system.update', allowInMaintenance: true }, async ({ ctx }) => {
    const pointer = readCurrent(installRoot());
    if (!pointer?.previous) throw badRequest('No previous release is installed on this server');
    const [job] = await q<{ id: string }>(
      db,
      sql`INSERT INTO system_updates (from_version, to_version, status, is_rollback, initiated_by)
          VALUES (${APP_VERSION}, ${pointer.previous}, 'pending', true, ${ctx.user!.id}) RETURNING id`,
    );
    await audit(db, ctx, { action: 'update.rollback', entityType: 'system', entityId: job!.id, meta: { from: APP_VERSION, to: pointer.previous } });
    return { jobId: job!.id };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/updates/history', summary: 'Update history', tags: ['Updates'], permission: ['system.update', 'system.health'], allowInMaintenance: true }, async () =>
    camelRows(await q(db, sql`SELECT u.*, us.display_name AS initiated_by_name FROM system_updates u LEFT JOIN users us ON us.id = u.initiated_by ORDER BY started_at DESC LIMIT 50`)),
  );
}
