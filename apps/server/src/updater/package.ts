import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { compareVersions, isSemver } from '@sofia/shared';

/**
 * Update packages: `sofia-X.Y.Z.tar.gz` containing release.json, server/ (bundle + migrations) and web/.
 * The update feed lists releases with the package SHA-256 and an Ed25519 signature over
 * "sofia-release:<version>:<sha256>:<size>:<minFromVersion>". Nothing is installed unless the signature verifies
 * against the public key installed with the server, the download matches the checksum, and the feed is HTTPS.
 */

export interface ReleaseEntry {
  version: string;
  releasedAt: string;
  notes: { en: string; ar: string };
  minFromVersion: string;
  url: string;
  sha256: string;
  size: number;
  signature: string;
  breaking?: boolean;
}

export interface UpdateFeed {
  channel: string;
  releases: ReleaseEntry[];
}

export function signedPayload(r: Pick<ReleaseEntry, 'version' | 'sha256' | 'size' | 'minFromVersion'>): string {
  return `sofia-release:${r.version}:${r.sha256}:${r.size}:${r.minFromVersion}`;
}

export function loadPublicKey(value: string, installRoot?: string): string {
  if (value.includes('BEGIN PUBLIC KEY')) return value.replace(/\\n/g, '\n');
  if (value && existsSync(value)) return readFileSync(value, 'utf8');
  const fallback = installRoot ? join(installRoot, 'config', 'update-public-key.pem') : '';
  if (fallback && existsSync(fallback)) return readFileSync(fallback, 'utf8');
  throw new Error('No update signing public key configured (SOFIA_UPDATE_PUBLIC_KEY)');
}

export function verifyReleaseSignature(r: ReleaseEntry, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(signedPayload(r)), createPublicKey(publicKeyPem), Buffer.from(r.signature, 'base64'));
  } catch {
    return false;
  }
}

function assertTrustedUrl(url: string): void {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Update server must use HTTPS');
}

export async function fetchFeed(feedUrl: string): Promise<UpdateFeed> {
  assertTrustedUrl(feedUrl);
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Update server responded ${res.status}`);
  const feed = (await res.json()) as UpdateFeed;
  if (!Array.isArray(feed.releases)) throw new Error('Malformed update feed');
  return feed;
}

/** Newest signed release that can be installed on top of `current`. */
export function latestApplicable(feed: UpdateFeed, current: string, publicKeyPem: string): ReleaseEntry | null {
  const candidates = feed.releases
    .filter((r) => isSemver(r.version) && compareVersions(r.version, current) > 0 && compareVersions(current, r.minFromVersion) >= 0)
    .filter((r) => verifyReleaseSignature(r, publicKeyPem))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) h.update(chunk as Buffer);
  });
  return h.digest('hex');
}

export async function downloadRelease(r: ReleaseEntry, dir: string, publicKeyPem: string): Promise<string> {
  if (!verifyReleaseSignature(r, publicKeyPem)) throw new Error(`Signature verification failed for ${r.version} — package rejected`);
  assertTrustedUrl(r.url);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `sofia-${r.version}.tar.gz`);
  if (existsSync(target) && (await sha256File(target)) === r.sha256) return target;
  const tmp = `${target}.part`;
  const res = await fetch(r.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const digest = await sha256File(tmp);
  if (digest !== r.sha256) {
    rmSync(tmp, { force: true });
    throw new Error('Checksum mismatch — the downloaded package is corrupt or was tampered with');
  }
  renameSync(tmp, target);
  return target;
}

export interface ReleaseInfo {
  version: string;
  migrations?: number[];
  breaking?: boolean;
}

/** Extract a verified package into releases/<version> (staging dir first, then atomic rename). */
export async function extractRelease(packagePath: string, releasesDir: string, expectedVersion: string): Promise<string> {
  const finalDir = join(releasesDir, expectedVersion);
  if (existsSync(join(finalDir, 'release.json'))) return finalDir;
  const staging = join(releasesDir, `.staging-${expectedVersion}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    await tar.x({
      file: packagePath,
      cwd: staging,
      strict: true,
      filter: (p) => !p.split(/[\\/]/).includes('..') && !p.startsWith('/'),
    });
    const info = JSON.parse(readFileSync(join(staging, 'release.json'), 'utf8')) as ReleaseInfo;
    if (info.version !== expectedVersion) throw new Error(`Package contains version ${info.version}, expected ${expectedVersion}`);
    if (!existsSync(join(staging, 'server', 'main.js'))) throw new Error('Package is missing server/main.js');
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
    return finalDir;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export interface CurrentPointer {
  version: string;
  previous?: string | null;
  switchedAt?: string;
}

export function readCurrent(installRoot: string): CurrentPointer | null {
  const p = join(installRoot, 'current.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CurrentPointer) : null;
}

/** Atomically point current.json at another release. */
export function writeCurrent(installRoot: string, pointer: CurrentPointer): void {
  const p = join(installRoot, 'current.json');
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...pointer, switchedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, p);
}
