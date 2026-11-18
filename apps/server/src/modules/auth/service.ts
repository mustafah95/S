import { and, eq, isNull, sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { getDb, q, q1, schema, type DbOrTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import type { AuthUser, RequestContext } from '../../lib/context.js';
import {
  burnPasswordCheck,
  decryptSecret,
  encryptSecret,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { signJwt, verifyJwt } from '../../lib/jwt.js';
import { logEvent } from '../../lib/system-events.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

authenticator.options = { window: 1 };

// ---------------------------------------------------------------------------------------------------------
// Auth user cache (permissions + branch scope), invalidated by role/user changes via the event bus.
// ---------------------------------------------------------------------------------------------------------
const userCache = new Map<string, { user: AuthUser; at: number }>();
const CACHE_TTL_MS = 30_000;

export function invalidateAuthCache(userId?: string): void {
  if (!userId) userCache.clear();
  else for (const k of userCache.keys()) if (k.startsWith(userId)) userCache.delete(k);
}

export async function loadAuthUser(userId: string, sessionId: string, tx: DbOrTx = getDb()): Promise<AuthUser | null> {
  const key = `${userId}:${sessionId}`;
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.user;
  const row = await q1<{
    id: string;
    username: string;
    display_name: string;
    role_id: string;
    role_key: string;
    all_branches: boolean;
    preferred_language: string;
    mfa_enabled: boolean;
    permissions: string[] | null;
    branch_ids: string[] | null;
    session_ok: boolean;
  }>(
    tx,
    sql`SELECT u.id, u.username, u.display_name, u.role_id, r.key AS role_key, r.all_branches, u.preferred_language,
               u.mfa_enabled,
               (SELECT array_agg(permission) FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions,
               (SELECT array_agg(branch_id) FROM user_branches ub WHERE ub.user_id = u.id) AS branch_ids,
               EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = ${sessionId} AND s.user_id = u.id
                        AND s.revoked_at IS NULL AND s.expires_at > now()) AS session_ok
        FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = ${userId} AND u.deleted_at IS NULL AND u.is_active`,
  );
  if (!row || !row.session_ok) return null;
  const user: AuthUser = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleKey: row.role_key,
    permissions: new Set(row.permissions ?? []),
    allBranches: row.all_branches,
    branchIds: row.branch_ids ?? [],
    sessionId,
    preferredLanguage: row.preferred_language,
    mfaEnabled: row.mfa_enabled,
  };
  userCache.set(key, { user, at: Date.now() });
  return user;
}

export function verifyAccessToken(token: string): { userId: string; sessionId: string } | null {
  const p = verifyJwt(token, config.jwtSecret, 'access');
  return p ? { userId: p.sub, sessionId: p.sid } : null;
}

// ---------------------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------------------

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
}

export type LoginResult = { kind: 'session'; session: IssuedSession; userId: string } | { kind: 'mfa'; challenge: string };

export async function login(
  username: string,
  password: string,
  ctx: RequestContext,
  deviceId?: string,
): Promise<LoginResult> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.username, username), isNull(schema.users.deletedAt)));
  if (!user) {
    await burnPasswordCheck(password);
    await logEvent('warn', 'security', 'Login failed: unknown user', { username, ip: ctx.ip });
    throw unauthorized('Invalid username or password', 'invalid_credentials');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logEvent('warn', 'security', 'Login blocked: account locked', { userId: user.id, ip: ctx.ip });
    throw new AppError(423, 'account_locked', 'Account temporarily locked after repeated failed logins. Try again later.');
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok || !user.isActive) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(schema.users)
      .set({
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
      })
      .where(eq(schema.users.id, user.id));
    await logEvent('warn', 'security', 'Login failed: bad password', { userId: user.id, ip: ctx.ip, failed });
    throw unauthorized('Invalid username or password', 'invalid_credentials');
  }
  if (user.mfaEnabled) {
    const challenge = signJwt({ sub: user.id, sid: deviceId ?? '', typ: 'mfa' }, config.jwtSecret, 300);
    return { kind: 'mfa', challenge };
  }
  const session = await completeLogin(user.id, ctx, deviceId);
  return { kind: 'session', session, userId: user.id };
}

export async function verifyMfaLogin(challenge: string, code: string, ctx: RequestContext): Promise<{ session: IssuedSession; userId: string }> {
  const p = verifyJwt(challenge, config.jwtSecret, 'mfa');
  if (!p) throw unauthorized('MFA challenge expired, please sign in again', 'mfa_expired');
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, p.sub));
  if (!user || !user.mfaEnabled || !user.mfaSecretEnc) throw unauthorized();
  const valid = await checkMfaCode(user.id, user.mfaSecretEnc, user.mfaRecoveryHashes, code);
  if (!valid) {
    await logEvent('warn', 'security', 'MFA verification failed', { userId: user.id, ip: ctx.ip });
    throw unauthorized('Invalid verification code', 'invalid_mfa_code');
  }
  const session = await completeLogin(user.id, ctx, p.sid || undefined);
  return { session, userId: user.id };
}

async function checkMfaCode(userId: string, secretEnc: string, recovery: string[], code: string): Promise<boolean> {
  const clean = code.replace(/\s|-/g, '');
  if (/^\d{6}$/.test(clean) && authenticator.verify({ token: clean, secret: decryptSecret(secretEnc) })) return true;
  const h = sha256(clean.toUpperCase());
  if (recovery.includes(h)) {
    await getDb()
      .update(schema.users)
      .set({ mfaRecoveryHashes: recovery.filter((r) => r !== h) })
      .where(eq(schema.users.id, userId));
    await logEvent('info', 'security', 'MFA recovery code used', { userId });
    return true;
  }
  return false;
}

async function completeLogin(userId: string, ctx: RequestContext, deviceId?: string): Promise<IssuedSession> {
  const db = getDb();
  const session = await createSession(db, userId, ctx, deviceId);
  await db
    .update(schema.users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(schema.users.id, userId));
  await audit(db, { ...ctx, user: { id: userId } as AuthUser }, { action: 'auth.login', entityType: 'user', entityId: userId, meta: { deviceId } });
  await logEvent('info', 'security', 'Login succeeded', { userId, ip: ctx.ip, deviceId });
  return session;
}

export async function createSession(
  tx: DbOrTx,
  userId: string,
  ctx: RequestContext,
  deviceId?: string,
  familyId: string = randomUUID(),
): Promise<IssuedSession> {
  const refreshToken = randomToken(32);
  const [s] = await tx
    .insert(schema.userSessions)
    .values({
      userId,
      familyId,
      refreshHash: sha256(refreshToken),
      deviceId: deviceId ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      ip: ctx.ip || null,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000),
    })
    .returning({ id: schema.userSessions.id });
  const accessToken = signJwt({ sub: userId, sid: s!.id, typ: 'access' }, config.jwtSecret, ACCESS_TTL_SECONDS);
  return { accessToken, refreshToken, sessionId: s!.id, expiresIn: ACCESS_TTL_SECONDS };
}

/**
 * Refresh-token rotation with reuse detection: each refresh token is single-use. Presenting a token that was
 * already rotated means it was stolen or replayed → the whole session family is revoked.
 */
export async function refreshSession(refreshToken: string, ctx: RequestContext): Promise<IssuedSession> {
  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(schema.userSessions)
      .where(eq(schema.userSessions.refreshHash, sha256(refreshToken)))
      .for('update');
    if (!s || s.revokedAt) return { kind: 'expired' as const };
    // Two tabs refreshing at the same moment is benign; an old token presented later is a replay.
    if (s.rotatedAt && Date.now() - s.rotatedAt.getTime() >= 30_000) return { kind: 'reuse' as const, familyId: s.familyId, userId: s.userId };
    if (s.expiresAt < new Date()) return { kind: 'expired' as const };
    const [u] = await tx.select({ active: schema.users.isActive, deleted: schema.users.deletedAt }).from(schema.users).where(eq(schema.users.id, s.userId));
    if (!u?.active || u.deleted) return { kind: 'disabled' as const };
    if (!s.rotatedAt) {
      await tx.update(schema.userSessions).set({ rotatedAt: new Date(), lastUsedAt: new Date() }).where(eq(schema.userSessions.id, s.id));
    }
    return { kind: 'ok' as const, session: await createSession(tx, s.userId, ctx, s.deviceId ?? undefined, s.familyId) };
  });
  if (outcome.kind === 'ok') return outcome.session;
  if (outcome.kind === 'reuse') {
    // Committed separately so the revocation is not rolled back by the error below.
    await db
      .update(schema.userSessions)
      .set({ revokedAt: new Date(), revokeReason: 'refresh_token_reuse' })
      .where(and(eq(schema.userSessions.familyId, outcome.familyId), isNull(schema.userSessions.revokedAt)));
    await logEvent('warn', 'security', 'Refresh token reuse detected — session family revoked', { userId: outcome.userId, ip: ctx.ip });
    invalidateAuthCache(outcome.userId);
  }
  if (outcome.kind === 'disabled') throw unauthorized('Account disabled', 'account_disabled');
  throw unauthorized('Session expired', 'session_expired');
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await getDb()
    .update(schema.userSessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(schema.userSessions.id, sessionId), isNull(schema.userSessions.revokedAt)));
  invalidateAuthCache();
}

export async function revokeAllSessions(userId: string, exceptSessionId: string | null, reason: string, tx: DbOrTx = getDb()): Promise<void> {
  await tx.execute(sql`UPDATE user_sessions SET revoked_at = now(), revoke_reason = ${reason}
                       WHERE user_id = ${userId} AND revoked_at IS NULL
                         AND (${exceptSessionId}::uuid IS NULL OR id <> ${exceptSessionId}::uuid)`);
  invalidateAuthCache(userId);
}

// ---------------------------------------------------------------------------------------------------------
// Password & MFA management
// ---------------------------------------------------------------------------------------------------------

export async function changePassword(ctx: RequestContext, current: string, next: string): Promise<void> {
  const db = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.user!.id));
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw unauthorized('Current password is incorrect', 'invalid_credentials');
  if (next.toLowerCase().includes(user.username.toLowerCase())) throw new AppError(422, 'weak_password', 'Password must not contain the username');
  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date(), updatedBy: user.id })
      .where(eq(schema.users.id, user.id));
    await revokeAllSessions(user.id, ctx.user!.sessionId, 'password_changed', tx);
    await audit(tx, ctx, { action: 'auth.password_change', entityType: 'user', entityId: user.id });
  });
}

export async function beginMfaSetup(ctx: RequestContext): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = authenticator.generateSecret(20);
  await getDb().update(schema.users).set({ mfaSecretEnc: encryptSecret(secret) }).where(eq(schema.users.id, ctx.user!.id));
  return { secret, otpauthUrl: authenticator.keyuri(ctx.user!.username, "Sofia's Resto-Lounge", secret) };
}

export async function enableMfa(ctx: RequestContext, code: string): Promise<{ recoveryCodes: string[] }> {
  const db = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.user!.id));
  if (!user?.mfaSecretEnc) throw new AppError(400, 'mfa_not_started', 'Start MFA setup first');
  if (!authenticator.verify({ token: code.trim(), secret: decryptSecret(user.mfaSecretEnc) })) {
    throw new AppError(422, 'invalid_mfa_code', 'Invalid verification code');
  }
  const recoveryCodes = Array.from({ length: 8 }, () => randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase());
  await db
    .update(schema.users)
    .set({ mfaEnabled: true, mfaRecoveryHashes: recoveryCodes.map((c) => sha256(c)) })
    .where(eq(schema.users.id, user.id));
  await audit(db, ctx, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
  invalidateAuthCache(user.id);
  return { recoveryCodes };
}

export async function disableMfa(ctx: RequestContext, password: string): Promise<void> {
  const db = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.user!.id));
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw unauthorized('Password is incorrect', 'invalid_credentials');
  if (user.mfaRequired) throw new AppError(403, 'mfa_required', 'Multi-factor authentication is mandatory for this account');
  await db.update(schema.users).set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] }).where(eq(schema.users.id, user.id));
  await audit(db, ctx, { action: 'auth.mfa_disabled', entityType: 'user', entityId: user.id });
  invalidateAuthCache(user.id);
}

export async function listSessions(userId: string) {
  return q(
    getDb(),
    sql`SELECT id, device_id AS "deviceId", user_agent AS "userAgent", ip, created_at AS "createdAt",
               last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
        FROM user_sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
  );
}

export async function profile(user: AuthUser) {
  const branches = await q<{ id: string; code: string; name: string; name_ar: string | null; timezone: string; currency: string }>(
    getDb(),
    user.allBranches
      ? sql`SELECT id, code, name, name_ar, timezone, currency FROM branches WHERE deleted_at IS NULL AND is_active ORDER BY name`
      : sql`SELECT b.id, b.code, b.name, b.name_ar, b.timezone, b.currency FROM branches b
            JOIN user_branches ub ON ub.branch_id = b.id AND ub.user_id = ${user.id}
            WHERE b.deleted_at IS NULL AND b.is_active ORDER BY b.name`,
  );
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.roleKey,
    permissions: [...user.permissions].sort(),
    allBranches: user.allBranches,
    branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, timezone: b.timezone, currency: b.currency })),
    preferredLanguage: user.preferredLanguage,
    mfaEnabled: user.mfaEnabled,
  };
}
