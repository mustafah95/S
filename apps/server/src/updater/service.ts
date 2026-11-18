import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, compareVersions } from '@sofia/shared';
import { config } from '../config.js';
import { readMigrations, runMigrations, applyRuntimeGrants } from '../db/migrator.js';
import { getDb, q, q1, sql } from '../db/pool.js';
import { systemContext, type RequestContext } from '../lib/context.js';
import { getSetting, putSetting } from '../lib/settings.js';
import { logEvent, notifyStaff } from '../lib/system-events.js';
import { createBackup, restoreBackup, setMaintenance } from '../modules/system/backup.js';
import { createController, type ServiceController } from './controller.js';
import { downloadRelease, extractRelease, loadPublicKey, readCurrent, writeCurrent, type ReleaseEntry } from './package.js';

/**
 * Update orchestration (§21–24, §82). Runs in the dedicated updater process so it can restart the API and worker.
 *
 *   1 backup database   2 download   3 verify signature + checksum   4 extract release   5 maintenance mode
 *   6 run migrations    7 switch current.json   8 restart services   9 health check   10 confirm success
 *   any failure after the switch/migrations → switch back + restore the pre-update backup → restart → health check
 */

export interface UpdaterDeps {
  installRoot: string;
  controller: ServiceController;
  /** Resolves when the restarted application reports `version` as healthy; rejects on timeout. */
  healthCheck: (version: string) => Promise<void>;
  publicKeyPem: string;
  downloadsDir: string;
}

export function defaultDeps(): UpdaterDeps {
  const installRoot = config.installRoot ?? config.dataDir;
  return {
    installRoot,
    controller: createController(),
    healthCheck: (v) => waitForHealthy(`http://127.0.0.1:${config.port}/health`, v),
    publicKeyPem: config.updatePublicKey || existsSync(join(installRoot, 'config', 'update-public-key.pem')) ? loadPublicKey(config.updatePublicKey, installRoot) : '',
    downloadsDir: join(config.dataDir, 'updates'),
  };
}

export async function waitForHealthy(url: string, version: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { status: string; version: string; checks?: Record<string, { status: string }> };
      last = `${res.status} ${body.status} v${body.version}`;
      if (res.ok && body.version === version && body.checks?.database?.status === 'ok' && body.checks?.migrations?.status !== 'error') return;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Health check did not pass within ${Math.round(timeoutMs / 1000)}s (last: ${last})`);
}

type Step = { step: string; status: 'running' | 'done' | 'failed' | 'skipped'; at: string; message?: string };

async function recordStep(jobId: string, step: Step) {
  await getDb().execute(sql`UPDATE system_updates SET steps = steps || ${JSON.stringify([step])}::jsonb, status = ${step.step} WHERE id = ${jobId}`);
}

async function step<T>(jobId: string, name: string, fn: () => Promise<T>): Promise<T> {
  await recordStep(jobId, { step: name, status: 'running', at: new Date().toISOString() });
  try {
    const r = await fn();
    await recordStep(jobId, { step: name, status: 'done', at: new Date().toISOString() });
    return r;
  } catch (err) {
    await recordStep(jobId, { step: name, status: 'failed', at: new Date().toISOString(), message: (err as Error).message });
    throw err;
  }
}

interface Job {
  id: string;
  from_version: string;
  to_version: string;
  manifest: ReleaseEntry | null;
  is_rollback: boolean;
  initiated_by: string | null;
}

async function finish(jobId: string, status: string, error?: string) {
  await getDb().execute(sql`UPDATE system_updates SET status = ${status}, finished_at = now(), error = ${error ?? null} WHERE id = ${jobId}`);
  const s = await getSetting('system.update');
  await putSetting(getDb(), systemContext('updater'), 'system.update', { ...s, pendingJobId: null, lastError: error ?? null });
}

/** Execute an install job. Returns the final status. */
export async function runUpdateJob(jobId: string, deps: UpdaterDeps): Promise<'completed' | 'rolled_back' | 'failed'> {
  const db = getDb();
  const job = await q1<Job>(db, sql`SELECT * FROM system_updates WHERE id = ${jobId}`);
  if (!job) throw new Error('Update job not found');
  if (job.is_rollback) return runRollbackJob(job, deps);
  const ctx: RequestContext = { ...systemContext('updater'), user: job.initiated_by ? ({ id: job.initiated_by } as never) : undefined };
  const release = job.manifest!;
  const releasesDir = join(deps.installRoot, 'releases');
  const current = readCurrent(deps.installRoot)?.version ?? APP_VERSION;
  let switched = false;
  let migrated = false;
  let backupId: string | null = null;
  await logEvent('info', 'update', `Update ${job.from_version} → ${job.to_version} started`);
  try {
    if (compareVersions(current, release.minFromVersion) < 0) throw new Error(`Version ${current} cannot update directly to ${release.version} (requires ${release.minFromVersion}+)`);
    const backup = await step(jobId, 'backing_up', () => createBackup('pre_update', ctx));
    backupId = backup.id;
    await db.execute(sql`UPDATE system_updates SET backup_id = ${backupId} WHERE id = ${jobId}`);
    const pkg = await step(jobId, 'downloading', () => downloadRelease(release, deps.downloadsDir, deps.publicKeyPem));
    await step(jobId, 'verifying', async () => {
      const { sha256File, verifyReleaseSignature } = await import('./package.js');
      if (!verifyReleaseSignature(release, deps.publicKeyPem)) throw new Error('Signature verification failed');
      if ((await sha256File(pkg)) !== release.sha256) throw new Error('Checksum verification failed');
    });
    const dir = await step(jobId, 'installing', () => extractRelease(pkg, releasesDir, release.version));
    await setMaintenance(true, `Updating to version ${release.version}`);
    const applied = await step(jobId, 'migrating', async () => {
      const migrationsDir = join(dir, 'server', 'migrations');
      const r = await runMigrations(config.databaseOwnerUrl, migrationsDir, { appVersion: release.version, log: (m) => void logEvent('info', 'update', m) });
      migrated = r.applied.length > 0;
      if (config.dbAppRole) await applyRuntimeGrants(config.databaseOwnerUrl, config.dbAppRole);
      return r.applied.map((m) => m.version);
    });
    await db.execute(sql`UPDATE system_updates SET migrations_applied = ${sql.param(applied)}::int[] WHERE id = ${jobId}`);
    await step(jobId, 'switching', async () => {
      writeCurrent(deps.installRoot, { version: release.version, previous: current });
      switched = true;
    });
    await step(jobId, 'restarting', () => deps.controller.restart(['api', 'worker']));
    await step(jobId, 'health_check', () => deps.healthCheck(release.version));
    await setMaintenance(false);
    await finish(jobId, 'completed');
    await logEvent('info', 'update', `Update to ${release.version} completed successfully`);
    await notifyStaff({ type: 'update_completed', title: `Sofia updated to ${release.version}`, severity: 'success', permission: 'system.update' });
    return 'completed';
  } catch (err) {
    const message = (err as Error).message;
    await logEvent('error', 'update', `Update to ${release.version} failed: ${message}`);
    if (!switched && !migrated) {
      await setMaintenance(false).catch(() => undefined);
      await finish(jobId, 'failed', message);
      await notifyStaff({ type: 'update_failed', title: `Update to ${release.version} failed — nothing was changed`, body: message, severity: 'critical', permission: 'system.update' });
      return 'failed';
    }
    try {
      await recordStep(jobId, { step: 'rolling_back', status: 'running', at: new Date().toISOString(), message });
      if (switched) writeCurrent(deps.installRoot, { version: current, previous: release.version });
      if (migrated && backupId) await restoreBackup(backupId, ctx);
      await deps.controller.restart(['api', 'worker']);
      await deps.healthCheck(current);
      await setMaintenance(false);
      await recordStep(jobId, { step: 'rolling_back', status: 'done', at: new Date().toISOString() });
      await finish(jobId, 'rolled_back', message);
      await notifyStaff({ type: 'update_rolled_back', title: `Update to ${release.version} failed and was rolled back to ${current}`, body: message, severity: 'critical', permission: 'system.update' });
      return 'rolled_back';
    } catch (rbErr) {
      await finish(jobId, 'failed', `${message}; rollback failed: ${(rbErr as Error).message}`);
      await notifyStaff({ type: 'update_failed', title: 'Update AND rollback failed — run Sofia Server Manager → Restore backup', body: (rbErr as Error).message, severity: 'critical', permission: 'system.update' });
      return 'failed';
    }
  }
}

/** Manual rollback to the previous release. Restores the pre-update backup only when a breaking migration ran. */
async function runRollbackJob(job: Job, deps: UpdaterDeps): Promise<'completed' | 'failed'> {
  const ctx = systemContext('updater');
  const pointer = readCurrent(deps.installRoot);
  try {
    const target = job.to_version;
    if (!existsSync(join(deps.installRoot, 'releases', target, 'server', 'main.js'))) throw new Error(`Release ${target} is not available locally`);
    const breaking = await q<{ version: number }>(getDb(), sql`SELECT version FROM schema_migrations WHERE breaking AND app_version = ${job.from_version}`);
    await setMaintenance(true, `Rolling back to ${target}`);
    if (breaking.length) {
      const last = await q1<{ backup_id: string }>(getDb(), sql`SELECT backup_id FROM system_updates WHERE to_version = ${job.from_version} AND status = 'completed' AND NOT is_rollback ORDER BY started_at DESC LIMIT 1`);
      if (!last?.backup_id) throw new Error('A breaking migration was applied and no pre-update backup exists — restore manually');
      await step(job.id, 'restoring_database', () => restoreBackup(last.backup_id, ctx));
    } else {
      const known = new Set(readMigrations(join(deps.installRoot, 'releases', target, 'server', 'migrations')).map((m) => m.version));
      await recordStep(job.id, { step: 'database', status: 'skipped', at: new Date().toISOString(), message: `Schema is backward compatible (${known.size} migrations known to ${target})` });
    }
    await step(job.id, 'switching', async () => writeCurrent(deps.installRoot, { version: target, previous: pointer?.version ?? job.from_version }));
    await step(job.id, 'restarting', () => deps.controller.restart(['api', 'worker']));
    await step(job.id, 'health_check', () => deps.healthCheck(target));
    await setMaintenance(false);
    await finish(job.id, 'completed');
    await logEvent('warn', 'update', `Rolled back from ${job.from_version} to ${target}`);
    return 'completed';
  } catch (err) {
    await setMaintenance(false).catch(() => undefined);
    await finish(job.id, 'failed', (err as Error).message);
    return 'failed';
  }
}

/** Updater service loop: picks up pending jobs created by the Update Center. */
export async function startUpdater(deps: UpdaterDeps = defaultDeps()): Promise<() => void> {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const job = await q1<{ id: string }>(getDb(), sql`UPDATE system_updates SET status = 'running' WHERE id = (
                                                       SELECT id FROM system_updates WHERE status = 'pending' ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED)
                                                     RETURNING id`);
      if (job) {
        await runUpdateJob(job.id, deps);
        // Restart the updater itself so it runs the newly installed release.
        setTimeout(() => process.exit(0), 1000);
      }
    } catch (err) {
      await logEvent('error', 'update', `Updater loop error: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, 3000);
  return () => clearInterval(timer);
}
