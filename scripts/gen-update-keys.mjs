#!/usr/bin/env node
// Generates the Ed25519 key pair that signs Sofia update packages.
// Keep the private key OFF the restaurant servers (store it with the release tooling, e.g. a password manager / HSM).
// Install the PUBLIC key on every server: config/update-public-key.pem (or SOFIA_UPDATE_PUBLIC_KEY).
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'update-keys'));
mkdirSync(dir, { recursive: true });
const priv = join(dir, 'sofia-update.private.pem');
if (existsSync(priv) && !process.argv.includes('--force')) {
  console.error(`${priv} already exists (use --force to replace — every installed server would need the new public key).`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(join(dir, 'update-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`Private key: ${priv}\nPublic key:  ${join(dir, 'update-public-key.pem')}`);
