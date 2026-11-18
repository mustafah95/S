// Runs every end-to-end scenario (requires: pnpm test:db:start and a built web app: pnpm --filter @sofia/web build).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.log('Building the web app first…');
  const b = spawnSync('pnpm', ['--filter', '@sofia/web', 'build'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
let failed = 0;
for (const file of ['critical-offline-sync.mjs']) {
  console.log(`\n=== ${file} ===`);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, file)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
