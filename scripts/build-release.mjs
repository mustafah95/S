#!/usr/bin/env node
/**
 * Builds a release package:  release/sofia-<version>.tar.gz  (+ .entry.json, unsigned feed entry)
 *
 *   release.json   { version, builtAt, migrations[], breaking }
 *   server/        single-file bundle + migrations + swagger assets (Node.js 22 is the only runtime dependency)
 *   web/           PWA build (staff app + booking page + widget)
 *   launcher.mjs   process supervisor used by the services
 *
 * The version comes from packages/shared/src/version.ts (single source of truth). Sign with scripts/sign-release.mjs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as tar from '../apps/server/node_modules/tar/dist/esm/index.js';

const root = resolve(import.meta.dirname, '..');
const version = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'packages/shared/src/version.ts'), 'utf8'))?.[1];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Could not read APP_VERSION');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`package.json version ${pkg.version} differs from APP_VERSION ${version}`);

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
if (!process.argv.includes('--skip-build')) {
  run('pnpm', ['--filter', '@sofia/web', 'build']);
  run('node', ['apps/server/build.mjs']);
}

const outDir = join(root, 'release');
const stage = join(outDir, `stage-${version}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'apps/server/dist/server'), join(stage, 'server'), { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(stage, 'web'), { recursive: true });
cpSync(join(root, 'deploy/runtime/launcher.mjs'), join(stage, 'launcher.mjs'));
const migrations = readdirSync(join(stage, 'server/migrations')).filter((f) => f.endsWith('.sql')).sort();
const breaking = migrations.some((f) => /^--\s*sofia:breaking/m.test(readFileSync(join(stage, 'server/migrations', f), 'utf8')));
writeFileSync(
  join(stage, 'release.json'),
  JSON.stringify({ version, builtAt: new Date().toISOString(), migrations: migrations.map((m) => Number(m.split('_')[0])), breaking }, null, 2),
);

const file = join(outDir, `sofia-${version}.tar.gz`);
await tar.c({ gzip: { level: 9 }, file, cwd: stage, portable: true }, ['release.json', 'launcher.mjs', 'server', 'web']);
rmSync(stage, { recursive: true, force: true });
const data = readFileSync(file);
const entry = {
  version,
  releasedAt: new Date().toISOString(),
  notes: { en: process.env.RELEASE_NOTES_EN ?? `Sofia's Resto-Lounge ${version}`, ar: process.env.RELEASE_NOTES_AR ?? `صوفيا ريستو-لاونج ${version}` },
  minFromVersion: process.env.MIN_FROM_VERSION ?? '1.0.0',
  url: `sofia-${version}.tar.gz`,
  sha256: createHash('sha256').update(data).digest('hex'),
  size: statSync(file).size,
  breaking,
  signature: '',
};
writeFileSync(join(outDir, `sofia-${version}.entry.json`), JSON.stringify(entry, null, 2));
console.log(`\nRelease ${version}: ${file}\n  sha256 ${entry.sha256}\n  ${(entry.size / 1048576).toFixed(1)} MB\nNext: node scripts/sign-release.mjs ${version} --key update-keys/sofia-update.private.pem --base-url https://updates.example.com/sofia`);
if (!existsSync(file)) process.exit(1);
