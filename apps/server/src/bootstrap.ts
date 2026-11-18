import { config } from './config.js';
import { applyRuntimeGrants, runMigrations } from './db/migrator.js';
import { getDb } from './db/pool.js';
import { seedReferenceData } from './db/seed.js';
import { subscribe } from './lib/events.js';
import { invalidateSettingsCache } from './lib/settings.js';
import { invalidateAuthCache } from './modules/auth/service.js';

/** Apply pending migrations (owner role), runtime grants and reference data. Idempotent. */
export async function prepareDatabase(log: (m: string) => void = console.log): Promise<void> {
  const r = await runMigrations(config.databaseOwnerUrl, config.migrationsDir, { log });
  if (r.applied.length) log(`Applied ${r.applied.length} migration(s)`);
  if (config.dbAppRole) await applyRuntimeGrants(config.databaseOwnerUrl, config.dbAppRole);
  await getDb().transaction((tx) => seedReferenceData(tx));
}

/** React to cross-process control events (cache invalidation). */
export function wireControlEvents(onRestart?: () => void): () => void {
  return subscribe((e) => {
    if (e.type !== 'control') return;
    if (e.action === 'auth-cache') invalidateAuthCache(e.target);
    if (e.action === 'settings') invalidateSettingsCache();
    if (e.action === 'restart' && onRestart && (!e.target || e.target === process.env.SOFIA_PROCESS_ROLE)) onRestart();
  });
}
