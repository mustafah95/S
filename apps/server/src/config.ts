import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Runtime configuration from environment variables (optionally loaded from SOFIA_ENV_FILE, which the Windows
 * installer writes to C:\Sofia\config\sofia.env). Secrets are never hard-coded: production refuses to start
 * without them.
 */

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (process.env.SOFIA_ENV_FILE) loadEnvFile(process.env.SOFIA_ENV_FILE);
else loadEnvFile(join(process.cwd(), '.env'));

const here = dirname(fileURLToPath(import.meta.url));

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['true', '1', 'yes'].includes(v)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:54329/sofia_dev'),
  DATABASE_OWNER_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  SOFIA_JWT_SECRET: z.string().optional(),
  SOFIA_ENCRYPTION_KEY: z.string().optional(),
  SOFIA_SETUP_TOKEN: z.string().optional(),
  SOFIA_DATA_DIR: z.string().default('.data/runtime'),
  SOFIA_BACKUP_DIR: z.string().optional(),
  SOFIA_WEB_DIR: z.string().optional(),
  SOFIA_PUBLIC_URL: z.string().default(''),
  SOFIA_TRUST_PROXY: bool,
  SOFIA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SOFIA_PG_BIN: z.string().optional(),
  SOFIA_INSTALL_ROOT: z.string().optional(),
  SOFIA_SERVICE_CONTROLLER: z.enum(['windows', 'systemd', 'launcher', 'none']).default('launcher'),
  SOFIA_SERVICE_NAMES: z.string().default('SofiaAPI,SofiaWorker'),
  SOFIA_UPDATE_FEED_URL: z.string().default(''),
  SOFIA_UPDATE_PUBLIC_KEY: z.string().default(''),
  SOFIA_UPDATE_CHANNEL: z.string().default('stable'),
  SOFIA_INTERNET_CHECK_URL: z.string().default('https://www.gstatic.com/generate_204'),
  SOFIA_DB_APP_ROLE: z.string().optional(),
  SOFIA_EMBEDDED_WORKER: bool,
  SOFIA_RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(600),
  SOFIA_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  /** Additional Web Push service hosts (comma separated) besides the browser vendors' push services. */
  SOFIA_PUSH_EXTRA_HOSTS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.issues);
  process.exit(1);
}
const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value && value.length >= 32) return value;
  if (isProd) {
    console.error(`${name} must be set to at least 32 characters in production.`);
    process.exit(1);
  }
  return devFallback;
}

const dataDir = isAbsolute(env.SOFIA_DATA_DIR) ? env.SOFIA_DATA_DIR : resolve(process.cwd(), env.SOFIA_DATA_DIR);

function defaultWebDir(): string {
  const candidates = [
    env.SOFIA_WEB_DIR,
    join(here, '../web'), // release layout: releases/x.y.z/server/main.js + releases/x.y.z/web
    join(here, '../../web/dist'), // monorepo: apps/server/src → apps/web/dist
    join(here, '../../../web/dist'),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? candidates[0]!;
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  host: env.HOST,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  databaseOwnerUrl: env.DATABASE_OWNER_URL ?? env.DATABASE_URL,
  databasePoolMax: env.DATABASE_POOL_MAX,
  jwtSecret: requireSecret('SOFIA_JWT_SECRET', env.SOFIA_JWT_SECRET, 'dev-only-jwt-secret-change-me-0123456789abcdef'),
  encryptionKey: requireSecret(
    'SOFIA_ENCRYPTION_KEY',
    env.SOFIA_ENCRYPTION_KEY,
    'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM=',
  ),
  setupToken: env.SOFIA_SETUP_TOKEN ?? (isProd ? undefined : 'dev-setup-token'),
  dataDir,
  backupDir: env.SOFIA_BACKUP_DIR ?? join(dataDir, 'backups'),
  webDir: defaultWebDir(),
  publicUrl: env.SOFIA_PUBLIC_URL,
  trustProxy: env.SOFIA_TRUST_PROXY ?? isProd,
  logLevel: env.SOFIA_LOG_LEVEL,
  pgBin: env.SOFIA_PG_BIN,
  installRoot: env.SOFIA_INSTALL_ROOT,
  serviceController: env.SOFIA_SERVICE_CONTROLLER,
  serviceNames: env.SOFIA_SERVICE_NAMES.split(',').map((s) => s.trim()).filter(Boolean),
  updateFeedUrl: env.SOFIA_UPDATE_FEED_URL,
  updatePublicKey: env.SOFIA_UPDATE_PUBLIC_KEY,
  updateChannel: env.SOFIA_UPDATE_CHANNEL,
  internetCheckUrl: env.SOFIA_INTERNET_CHECK_URL,
  dbAppRole: env.SOFIA_DB_APP_ROLE,
  embeddedWorker: env.SOFIA_EMBEDDED_WORKER ?? !isProd,
  rateLimitMax: env.SOFIA_RATE_LIMIT_MAX,
  loginRateLimit: env.SOFIA_LOGIN_RATE_LIMIT,
  pushExtraHosts: env.SOFIA_PUSH_EXTRA_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  migrationsDir: [join(here, '../migrations'), join(here, 'migrations')].find((d) => existsSync(d)) ?? join(here, '../migrations'),
  /** Fonts and brand images used for PDF reports (apps/server/assets; copied next to main.js in releases). */
  assetsDir: [join(here, '../assets'), join(here, 'assets')].find((d) => existsSync(join(d, 'fonts'))) ?? join(here, '../assets'),
};

export type Config = typeof config;
