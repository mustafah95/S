import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loginSchema, mfaVerifySchema, passwordChangeSchema } from '@sofia/shared';
import { defineRoute, idParams } from '../../lib/route.js';
import { config } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { getDb, q1, sql } from '../../db/pool.js';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_DAYS,
  beginMfaSetup,
  changePassword,
  disableMfa,
  enableMfa,
  listSessions,
  login,
  profile,
  refreshSession,
  revokeSession,
  verifyMfaLogin,
  type IssuedSession,
} from './service.js';

export const COOKIE_ACCESS = 'sofia_at';
export const COOKIE_REFRESH = 'sofia_rt';
export const COOKIE_CSRF = 'sofia_csrf';

/** Cookies are Secure whenever the request arrived over HTTPS (LAN access over http://SERVER-IP still works). */
export function isHttps(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

export function setSessionCookies(req: FastifyRequest, reply: FastifyReply, s: IssuedSession): void {
  const secure = isHttps(req);
  reply.setCookie(COOKIE_ACCESS, s.accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: ACCESS_TTL_SECONDS,
  });
  reply.setCookie(COOKIE_REFRESH, s.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/api/v1/auth',
    maxAge: REFRESH_TTL_DAYS * 86400,
  });
  reply.setCookie(COOKIE_CSRF, randomToken(24), { httpOnly: false, sameSite: 'strict', secure, path: '/' });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_ACCESS, { path: '/' });
  reply.clearCookie(COOKIE_REFRESH, { path: '/api/v1/auth' });
}

const LOGIN_LIMIT = { max: config.loginRateLimit, timeWindow: '1 minute' };

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/login', summary: 'Sign in', tags: ['Auth'], auth: 'none', skipCsrf: false, body: loginSchema, rateLimit: LOGIN_LIMIT, allowInMaintenance: true },
    async ({ req, reply, body, ctx }) => {
      const result = await login(body.username, body.password, ctx, body.deviceId ?? ctx.deviceId);
      if (result.kind === 'mfa') return { mfaRequired: true, challenge: result.challenge };
      setSessionCookies(req, reply, result.session);
      const user = await requireLoadedUser(result.userId, result.session.sessionId);
      return { mfaRequired: false, user, expiresIn: result.session.expiresIn };
    },
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/mfa/verify', summary: 'Complete sign-in with a TOTP or recovery code', tags: ['Auth'], auth: 'none', skipCsrf: false, body: mfaVerifySchema, rateLimit: LOGIN_LIMIT, allowInMaintenance: true },
    async ({ req, reply, body, ctx }) => {
      const { session, userId } = await verifyMfaLogin(body.challenge, body.code, ctx);
      setSessionCookies(req, reply, session);
      return { user: await requireLoadedUser(userId, session.sessionId), expiresIn: session.expiresIn };
    },
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/refresh', summary: 'Rotate the refresh token and issue a new access token', tags: ['Auth'], auth: 'none', skipCsrf: false, rateLimit: { max: 60, timeWindow: '1 minute' }, allowInMaintenance: true },
    async ({ req, reply, ctx }) => {
      const token = req.cookies[COOKIE_REFRESH];
      if (!token) throw unauthorized('Session expired', 'session_expired');
      try {
        const session = await refreshSession(token, ctx);
        setSessionCookies(req, reply, session);
        const row = await q1<{ user_id: string }>(getDb(), sql`SELECT user_id FROM user_sessions WHERE id = ${session.sessionId}`);
        return { user: await requireLoadedUser(row!.user_id, session.sessionId), expiresIn: session.expiresIn };
      } catch (err) {
        clearSessionCookies(reply);
        throw err;
      }
    },
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/logout', summary: 'Sign out and revoke the current session', tags: ['Auth'], auth: 'optional', allowInMaintenance: true },
    async ({ reply, ctx }) => {
      if (ctx.user) await revokeSession(ctx.user.sessionId, 'logout');
      clearSessionCookies(reply);
      return { ok: true };
    },
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/auth/me', summary: 'Current user, permissions and branches', tags: ['Auth'] }, async ({ user }) =>
    profile(user),
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/password', summary: 'Change own password (revokes other sessions)', tags: ['Auth'], body: passwordChangeSchema, rateLimit: LOGIN_LIMIT },
    async ({ body, ctx }) => {
      await changePassword(ctx, body.currentPassword, body.newPassword);
      return { ok: true };
    },
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/auth/mfa/setup', summary: 'Start TOTP MFA enrolment', tags: ['Auth'] }, async ({ ctx }) => beginMfaSetup(ctx));

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/mfa/enable', summary: 'Confirm TOTP code and enable MFA; returns one-time recovery codes', tags: ['Auth'], body: z.object({ code: z.string().min(6).max(10) }) },
    async ({ body, ctx }) => enableMfa(ctx, body.code),
  );

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/auth/mfa/disable', summary: 'Disable MFA (password required)', tags: ['Auth'], body: z.object({ password: z.string().min(1).max(256) }) },
    async ({ body, ctx }) => {
      await disableMfa(ctx, body.password);
      return { ok: true };
    },
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/auth/sessions', summary: 'Active sessions of the current user', tags: ['Auth'] }, async ({ user }) =>
    listSessions(user.id),
  );

  defineRoute(
    app,
    { method: 'DELETE', url: '/api/v1/auth/sessions/:id', summary: 'Revoke one of my sessions', tags: ['Auth'], params: idParams },
    async ({ params, user }) => {
      const row = await q1(getDb(), sql`SELECT id FROM user_sessions WHERE id = ${params.id} AND user_id = ${user.id}`);
      if (!row) throw notFound('Session');
      await revokeSession(params.id, 'user_revoked');
      return { ok: true };
    },
  );
}

async function requireLoadedUser(userId: string, sessionId: string) {
  const { loadAuthUser } = await import('./service.js');
  const user = await loadAuthUser(userId, sessionId);
  if (!user) throw unauthorized();
  return profile(user);
}
