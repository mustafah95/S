#!/usr/bin/env node
/**
 * Sofia launcher — keeps one Sofia role running from the release that current.json points to.
 *
 *   node launcher.mjs <api|worker|updater>            (SOFIA_INSTALL_ROOT defaults to this file's folder)
 *
 * Install layout:
 *   <root>/current.json                {"version":"1.1.0","previous":"1.0.0"}
 *   <root>/releases/<version>/server/main.js
 *   <root>/releases/<version>/web/
 *
 * When the role exits (an update or "Restart system" asks it to), the launcher starts it again from whatever
 * release current.json now names. Crash loops back off so a broken release cannot spin the CPU, and the updater
 * notices the failed health check and rolls back. Windows services (WinSW), systemd units and Docker containers
 * all run this same launcher, so restarts behave identically everywhere.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const role = process.argv[2] ?? 'api';
if (!['api', 'worker', 'updater'].includes(role)) {
  console.error(`Unknown role "${role}". Use api, worker or updater.`);
  process.exit(2);
}
const root = resolve(process.env.SOFIA_INSTALL_ROOT ?? dirname(fileURLToPath(import.meta.url)));
const log = (m) => console.log(`[sofia-launcher ${role}] ${new Date().toISOString()} ${m}`);

function currentRelease() {
  const pointer = join(root, 'current.json');
  if (!existsSync(pointer)) throw new Error(`${pointer} not found — is Sofia installed in ${root}?`);
  const { version } = JSON.parse(readFileSync(pointer, 'utf8'));
  const main = join(root, 'releases', version, 'server', 'main.js');
  if (!existsSync(main)) throw new Error(`Release ${version} is missing ${main}`);
  return { version, main, web: join(root, 'releases', version, 'web') };
}

let child = null;
let stopping = false;
const crashes = [];

function start() {
  let rel;
  try {
    rel = currentRelease();
  } catch (err) {
    log(err.message);
    return setTimeout(start, 10_000);
  }
  log(`starting ${rel.version}`);
  const started = Date.now();
  child = spawn(process.execPath, [rel.main, role], {
    stdio: 'inherit',
    env: { ...process.env, SOFIA_INSTALL_ROOT: root, SOFIA_WEB_DIR: process.env.SOFIA_WEB_DIR_OVERRIDE ?? rel.web, SOFIA_RELEASE: rel.version },
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    const ranFor = Date.now() - started;
    if (code !== 0 && ranFor < 60_000) crashes.push(Date.now());
    while (crashes.length && Date.now() - crashes[0] > 300_000) crashes.shift();
    const delay = crashes.length >= 5 ? 30_000 : code === 0 ? 500 : 3_000;
    log(`exited (code ${code ?? '-'}${signal ? `, ${signal}` : ''}) after ${Math.round(ranFor / 1000)}s — restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    child.kill('SIGTERM');
    setTimeout(() => child?.kill('SIGKILL'), 15_000).unref();
  });
}

start();
