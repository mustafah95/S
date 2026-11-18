/**
 * Every test file gets its own freshly created PostgreSQL database (real PostgreSQL, no mocks).
 * Requires the local test cluster: `pnpm test:db:start` (scripts/test-db.sh).
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const admin = process.env.SOFIA_TEST_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const name = `sofia_test_${randomBytes(5).toString('hex')}`;
const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query(`CREATE DATABASE ${name}`);
await client.end();

const url = new URL(admin);
url.pathname = `/${name}`;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = url.toString();
process.env.DATABASE_OWNER_URL = url.toString();
process.env.SOFIA_SETUP_TOKEN = 'test-setup-token';
process.env.SOFIA_DATA_DIR = mkdtempSync(join(tmpdir(), 'sofia-test-'));
process.env.SOFIA_LOG_LEVEL = 'silent';
process.env.SOFIA_EMBEDDED_WORKER = 'false';
process.env.SOFIA_TEST_DB_NAME = name;
process.env.SOFIA_LOGIN_RATE_LIMIT = '1000';
process.env.SOFIA_RATE_LIMIT_MAX = '100000';
// Local stand-in for a browser push service (see push.test.ts).
process.env.SOFIA_PUSH_EXTRA_HOSTS = '127.0.0.1';
