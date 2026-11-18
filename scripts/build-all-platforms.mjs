#!/usr/bin/env node
/**
 * Builds one package with everything needed to set up the restaurant:  release/Sofia-All-Platforms-<version>.zip
 *
 *   START-HERE.html            bilingual installation guide (server, staff PCs, Android, iPhone/iPad, guests)
 *   1-Server-Windows/          the Windows server installer bundle (from build-windows-bundle.mjs, verified)
 *   2-Staff-Windows-PC/        staff PC setup: certificate (fingerprint-checked) + app shortcut
 *   3-Android/  4-iPhone-iPad/ device instructions (the staff app is a PWA installed from the restaurant server)
 *   5-Server-Linux-Docker/     source archive for the Docker deployment + the signed-update release package
 *   SHA256SUMS.txt
 *
 * Requires: pnpm release:build && pnpm release:windows (run first), a git checkout (for the source archive) and `zip`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'packages/shared/src/version.ts'), 'utf8'))?.[1];
const rel = join(root, 'release');
const winBundle = join(rel, `SofiaSetup-${version}-windows`);
const tarball = join(rel, `sofia-${version}.tar.gz`);
for (const need of [winBundle, tarball]) {
  if (!existsSync(need)) throw new Error(`${relative(root, need)} not found — run "pnpm release:build && pnpm release:windows" first.`);
}

// The Windows bundle must be intact (same check as the installer).
const bundle = JSON.parse(readFileSync(join(winBundle, 'bundle.json'), 'utf8'));
for (const f of bundle.files) {
  const h = createHash('sha256').update(readFileSync(join(winBundle, f.path))).digest('hex');
  if (h !== f.sha256) throw new Error(`Windows bundle file changed after it was built: ${f.path}`);
}

const name = `Sofia-All-Platforms-${version}`;
const out = join(rel, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const clients = join(root, 'deploy', 'clients');
const fill = (text) => text.replaceAll('{{VERSION}}', version).replaceAll('{VERSION}', version);

const logo = readFileSync(join(root, 'brand', 'sofia-logo-cream.png')).toString('base64');
writeFileSync(join(out, 'START-HERE.html'), fill(readFileSync(join(clients, 'START-HERE.html'), 'utf8')).replace('{{LOGO}}', `data:image/png;base64,${logo}`));

cpSync(winBundle, join(out, '1-Server-Windows', `SofiaSetup-${version}-windows`), { recursive: true });
cpSync(join(clients, 'windows'), join(out, '2-Staff-Windows-PC'), { recursive: true });
cpSync(join(clients, 'android'), join(out, '3-Android'), { recursive: true });
cpSync(join(clients, 'iphone'), join(out, '4-iPhone-iPad'), { recursive: true });

const linux = join(out, '5-Server-Linux-Docker');
mkdirSync(linux, { recursive: true });
writeFileSync(join(linux, 'README.txt'), fill(readFileSync(join(clients, 'linux', 'README.txt'), 'utf8')));
cpSync(tarball, join(linux, `sofia-${version}.tar.gz`));
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) console.warn('! The source archive is made from the last commit; uncommitted changes are not included.');
execFileSync('git', ['archive', '--format=zip', `--prefix=sofia-${version}/`, '-o', join(linux, `sofia-${version}-source.zip`), 'HEAD'], { cwd: root });

const sums = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else sums.push(`${createHash('sha256').update(readFileSync(full)).digest('hex')}  ${relative(out, full).split('\\').join('/')}`);
  }
};
walk(out);
writeFileSync(join(out, 'SHA256SUMS.txt'), `${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`);

const zip = join(rel, `${name}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-qrX', zip, name], { cwd: rel, stdio: 'inherit' });
console.log(`All-platforms package: ${relative(root, zip)} (${(statSync(zip).size / 1048576).toFixed(1)} MB, ${sums.length} files)`);
