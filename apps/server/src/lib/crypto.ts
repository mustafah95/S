import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { config } from '../config.js';

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// OWASP Password Storage Cheat Sheet: scrypt N=2^16, r=8, p=2 (64 MiB).
const SCRYPT = { N: 2 ** 16, r: 8, p: 2, keylen: 32 };
const TEST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keylen: 32 };

/** Hash a password. Format: scrypt$N$r$p$saltB64$hashB64 (parameters stored for future upgrades). */
export async function hashPassword(password: string): Promise<string> {
  const p = config.isTest ? TEST_SCRYPT : SCRYPT;
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, p.keylen, {
    N: p.N,
    r: p.r,
    p: p.p,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A dummy hash used to keep login timing constant when the username does not exist. */
let dummyHash: string | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword('not-a-real-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(secret: string | Buffer, data: string | Buffer, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function encryptionKey(): Buffer {
  const raw = config.encryptionKey;
  const b = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44 ? Buffer.from(raw, 'base64') : Buffer.from(raw);
  return createHash('sha256').update(b).digest();
}

/** AES-256-GCM encryption for secrets at rest (integration credentials, MFA secrets). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(payload: string | null | undefined): T | undefined {
  if (!payload) return undefined;
  return JSON.parse(decryptSecret(payload)) as T;
}
