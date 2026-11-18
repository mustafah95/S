#!/usr/bin/env node
/**
 * Signs a built release and adds it to the update feed:
 *   node scripts/sign-release.mjs <version> --key <private.pem> --base-url <https://updates.example.com/sofia> [--feed release/feed.json]
 * Upload release/feed.json and release/sofia-<version>.tar.gz to the update server (HTTPS).
 * Servers verify the Ed25519 signature over "sofia-release:<version>:<sha256>:<size>:<minFromVersion>".
 */
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const version = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const keyPath = opt('--key');
const baseUrl = opt('--base-url');
if (!version || !keyPath || !baseUrl) {
  console.error('Usage: sign-release.mjs <version> --key <private.pem> --base-url <https://…> [--feed release/feed.json] [--channel stable]');
  process.exit(2);
}
if (!baseUrl.startsWith('https://')) console.warn('Warning: production update servers must use HTTPS.');
const outDir = resolve(import.meta.dirname, '..', 'release');
const entry = JSON.parse(readFileSync(join(outDir, `sofia-${version}.entry.json`), 'utf8'));
entry.url = `${baseUrl.replace(/\/$/, '')}/sofia-${version}.tar.gz`;
const payload = `sofia-release:${entry.version}:${entry.sha256}:${entry.size}:${entry.minFromVersion}`;
entry.signature = sign(null, Buffer.from(payload), createPrivateKey(readFileSync(keyPath))).toString('base64');
const feedPath = resolve(opt('--feed') ?? join(outDir, 'feed.json'));
const feed = existsSync(feedPath) ? JSON.parse(readFileSync(feedPath, 'utf8')) : { channel: opt('--channel') ?? 'stable', releases: [] };
feed.releases = [...feed.releases.filter((r) => r.version !== entry.version), entry].sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
writeFileSync(feedPath, JSON.stringify(feed, null, 2));
console.log(`Signed ${version} → ${feedPath}`);
