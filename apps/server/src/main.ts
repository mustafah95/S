import { APP_VERSION } from '@sofia/shared';

/**
 * Sofia process entry point. One build, several roles:
 *   api      REST API + PWA + SSE (and, unless disabled, an embedded worker for single-process installs)
 *   worker   background jobs (notifications, POS, reminders, backups, campaigns)
 *   updater  executes update jobs from the Update Center
 *   cli      administrative commands (migrate, backup, restore, export, health, user)
 */
const role = (process.argv[2] ?? 'api') as 'api' | 'worker' | 'updater' | 'cli';
process.env.SOFIA_PROCESS_ROLE = role;

async function main() {
  const { config } = await import('./config.js');
  if (role === 'cli') {
    const { runCli } = await import('./cli.js');
    process.exitCode = await runCli(process.argv.slice(3));
    const { closeDb } = await import('./db/pool.js');
    await closeDb();
    return;
  }

  const { prepareDatabase, wireControlEvents } = await import('./bootstrap.js');
  const { startEventListener, stopEventListener } = await import('./lib/events.js');
  const { closeDb } = await import('./db/pool.js');
  const { logEvent } = await import('./lib/system-events.js');
  const { startInternetMonitor } = await import('./modules/system/internet.js');

  let shuttingDown = false;
  const stoppers: (() => Promise<void> | void)[] = [];
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const s of stoppers.reverse()) await Promise.resolve(s()).catch(() => undefined);
    await stopEventListener();
    await closeDb();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  if (role === 'api') await prepareDatabase();
  await startEventListener();
  // A "restart" control event makes the process exit; the launcher / service manager starts it again,
  // picking up the release that current.json points to.
  stoppers.push(wireControlEvents(() => void shutdown(0)));
  startInternetMonitor();

  if (role === 'api') {
    const { buildApp } = await import('./app.js');
    const app = await buildApp();
    stoppers.push(() => app.close());
    await app.listen({ host: config.host, port: config.port });
    await logEvent('info', 'app', `Sofia API ${APP_VERSION} listening on ${config.host}:${config.port}`);
    if (config.embeddedWorker) {
      const { startWorker } = await import('./worker/index.js');
      stoppers.push(await startWorker());
    }
  } else if (role === 'worker') {
    const { startWorker } = await import('./worker/index.js');
    stoppers.push(await startWorker());
    await logEvent('info', 'worker', `Sofia worker ${APP_VERSION} started`);
  } else if (role === 'updater') {
    const { startUpdater } = await import('./updater/service.js');
    stoppers.push(await startUpdater());
    await logEvent('info', 'update', `Sofia updater ${APP_VERSION} started`);
  }
}

main().catch((err) => {
  console.error(`Sofia ${role} failed to start:`, err);
  process.exit(1);
});
