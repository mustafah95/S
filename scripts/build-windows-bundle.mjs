#!/usr/bin/env node
/**
 * Builds the Windows installation bundle:  release/SofiaSetup-<version>-windows.zip
 *
 *   node scripts/build-windows-bundle.mjs [--with-node]
 *
 * Requires release/sofia-<version>.tar.gz (pnpm release:build). Third-party binaries are downloaded once into
 * release/.cache and checked against pinned checksums before they are bundled:
 *   - WinSW 2.12.0 (Windows service wrapper, MIT)               SHA-256 pinned below
 *   - Caddy 2.10.2 (HTTPS reverse proxy, Apache-2.0)             SHA-512 from the official checksums file
 *   - Node.js 22 LTS MSI (only with --with-node, for offline installs)   SHA-256 from nodejs.org SHASUMS256.txt
 * PostgreSQL is not bundled (≈350 MB): the installer downloads it or takes -PostgresInstaller <file>.
 *
 * Layout:
 *   Install-Sofia.cmd  Install-Sofia.ps1  Uninstall-Sofia.ps1  SofiaServerManager.ps1  sofia.ico  README.txt
 *   templates/  service.xml  Caddyfile.lan  Caddyfile.domain
 *   payload/    sofia-<v>.tar.gz  WinSW-x64.exe  caddy_<v>_windows_amd64.zip  update-public-key.pem  [node-*.msi]
 *   bundle.json { version, release, winsw, caddy, node, files: [{ path, sha256 }] }   ← verified by the installer
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'packages/shared/src/version.ts'), 'utf8'))?.[1];
const withNode = process.argv.includes('--with-node');
const releaseTar = join(root, 'release', `sofia-${version}.tar.gz`);
if (!existsSync(releaseTar)) throw new Error(`${releaseTar} not found — run "pnpm release:build" first.`);

const WINSW = {
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  file: 'WinSW-x64.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
};
const CADDY = {
  url: 'https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_windows_amd64.zip',
  file: 'caddy_2.10.2_windows_amd64.zip',
  sha512: '88347875f0cd4b5e26bb39cd1f359613f932d54158d560e03244004d1ba6e61aae0cd625ba7c913bd46df096ef973fef2249396b0bb81143414378cb4447aeb8',
};

const cache = join(root, 'release', '.cache');
mkdirSync(cache, { recursive: true });
const hash = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex');

/** Downloads with curl when available (it honours the system proxy settings), otherwise with fetch. */
async function download(url, dest) {
  try {
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function cached({ url, file, sha256, sha512 }) {
  const dest = join(cache, file);
  const ok = () => existsSync(dest) && (sha256 ? hash('sha256', dest) === sha256 : hash('sha512', dest) === sha512);
  if (!ok()) {
    console.log(`downloading ${url}`);
    await download(url, dest);
    if (!ok()) {
      rmSync(dest, { force: true });
      throw new Error(`Checksum mismatch for ${file} — refusing to bundle it.`);
    }
  }
  console.log(`✓ ${file} (checksum verified)`);
  return dest;
}

async function nodeMsi() {
  const base = 'https://nodejs.org/dist/latest-v22.x/';
  const sumsFile = join(cache, 'node-SHASUMS256.txt');
  await download(`${base}SHASUMS256.txt`, sumsFile);
  const line = readFileSync(sumsFile, 'utf8').split('\n').find((l) => /node-v[\d.]+-x64\.msi$/.test(l.trim()));
  if (!line) throw new Error('Node.js MSI not listed in SHASUMS256.txt');
  const [sha256, file] = line.trim().split(/\s+/);
  return cached({ url: base + file, file, sha256 });
}

const name = `SofiaSetup-${version}-windows`;
const out = join(root, 'release', name);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'payload'), { recursive: true });

const win = join(root, 'deploy', 'windows');
for (const f of ['Install-Sofia.ps1', 'Uninstall-Sofia.ps1', 'SofiaServerManager.ps1', 'Install-Sofia.cmd', 'sofia.ico']) cpSync(join(win, f), join(out, f));
cpSync(join(win, 'README.md'), join(out, 'README.txt'));
cpSync(join(win, 'templates'), join(out, 'templates'), { recursive: true });
cpSync(releaseTar, join(out, 'payload', basename(releaseTar)));
cpSync(await cached(WINSW), join(out, 'payload', WINSW.file));
cpSync(await cached(CADDY), join(out, 'payload', CADDY.file));
const keyFile = join(root, 'deploy', 'update-public-key.pem');
const hasKey = existsSync(keyFile) && statSync(keyFile).size > 0;
if (hasKey) cpSync(keyFile, join(out, 'payload', 'update-public-key.pem'));
else console.warn('! deploy/update-public-key.pem is empty: installations from this bundle will refuse every update package until a key is added.');
let nodeFile = null;
if (withNode) {
  const msi = await nodeMsi();
  nodeFile = `payload/${basename(msi)}`;
  cpSync(msi, join(out, nodeFile));
}

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push({ path: relative(out, full).split('\\').join('/'), sha256: hash('sha256', full) });
  }
};
walk(out);
writeFileSync(
  join(out, 'bundle.json'),
  JSON.stringify(
    {
      product: "Sofia's Resto-Lounge",
      version,
      builtAt: new Date().toISOString(),
      release: `payload/${basename(releaseTar)}`,
      winsw: `payload/${WINSW.file}`,
      caddy: `payload/${CADDY.file}`,
      node: nodeFile,
      postgres: null,
      updateKeyIncluded: hasKey,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  ),
);

const zip = join(root, 'release', `${name}.zip`);
rmSync(zip, { force: true });
try {
  execFileSync('zip', ['-qr', zip, name], { cwd: join(root, 'release'), stdio: 'inherit' });
  console.log(`\nWindows bundle: ${relative(root, zip)} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
} catch {
  console.log(`\nWindows bundle folder: ${relative(root, out)} (zip it to distribute; "zip" was not found)`);
}
