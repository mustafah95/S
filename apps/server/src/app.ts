import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { MIN_SUPPORTED_SYNC_PROTOCOL } from '@sofia/shared';
import { config } from './config.js';
import { AppError, fromPgError, serviceUnavailable, upgradeRequired } from './lib/errors.js';
import type { RequestContext } from './lib/context.js';
import { buildOpenApi } from './lib/openapi.js';
import { getSetting } from './lib/settings.js';
import { safeEqual } from './lib/crypto.js';
import { logEvent } from './lib/system-events.js';
import { COOKIE_ACCESS, COOKIE_CSRF, registerAuthRoutes } from './modules/auth/routes.js';
import { loadAuthUser, verifyAccessToken } from './modules/auth/service.js';
import { registerModules } from './modules/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface BuildAppOptions {
  logger?: boolean;
  serveWeb?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    // HSTS only makes sense on HTTPS deployments; Caddy adds it in front of the app.
    hsts: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/assets/') || req.url === '/health/live',
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  // ---- request context, authentication, CSRF, maintenance --------------------------------------------------
  app.decorateRequest('ctx', null as unknown as RequestContext);
  app.addHook('onRequest', async (req, reply) => {
    const device = req.headers['x-sofia-device-id'];
    req.ctx = {
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceId: typeof device === 'string' && /^[0-9a-f-]{36}$/i.test(device) ? device : undefined,
    };
    if (!req.url.startsWith('/api/')) return;

    const authz = req.headers.authorization;
    const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined;
    const token = bearer ?? req.cookies[COOKIE_ACCESS];
    if (token) {
      const claims = verifyAccessToken(token);
      if (claims) {
        const user = await loadAuthUser(claims.userId, claims.sessionId);
        if (user) req.ctx.user = user;
      }
    }

    // Ensure every browser has a CSRF token cookie to echo back.
    if (!req.cookies[COOKIE_CSRF]) {
      const { randomToken } = await import('./lib/crypto.js');
      reply.setCookie(COOKIE_CSRF, randomToken(24), { httpOnly: false, sameSite: 'strict', secure: req.protocol === 'https', path: '/' });
    }

    const clientProtocol = req.headers['x-sofia-sync-protocol'];
    if (clientProtocol && Number(clientProtocol) < MIN_SUPPORTED_SYNC_PROTOCOL) {
      throw upgradeRequired('This version of the app is out of date. Please update to continue syncing.');
    }
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || !MUTATING.has(req.method)) return;
    const cfg = req.routeOptions.config;
    if (!cfg?.skipCsrf && !req.headers.authorization) {
      const header = req.headers['x-csrf-token'];
      const cookieToken = req.cookies[COOKIE_CSRF];
      if (typeof header !== 'string' || !cookieToken || !safeEqual(header, cookieToken)) {
        throw new AppError(403, 'csrf_failed', 'Security token missing or invalid. Please reload the page.');
      }
    }
    if (!cfg?.allowInMaintenance) {
      const m = await getSetting('system.maintenance');
      if (m.enabled) {
        throw serviceUnavailable(m.reason || 'The system is being updated. Changes are kept on this device and will sync automatically.', 'maintenance');
      }
    }
  });

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { statusCode?: number; code?: string };
    let e: AppError | undefined;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError) e = new AppError(422, 'validation_error', 'Invalid input', { issues: err.issues });
    else e = fromPgError(err);
    const statusFromFastify = (err as { statusCode?: number }).statusCode;
    if (!e && statusFromFastify && statusFromFastify < 500) {
      e = new AppError(statusFromFastify, statusFromFastify === 429 ? 'rate_limited' : (err.code ?? 'request_error'), err.message);
    }
    if (!e) {
      req.log.error({ err }, 'Unhandled error');
      void logEvent('error', 'error', err.message, { url: req.url, method: req.method, stack: err.stack?.slice(0, 2000) });
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected server error', requestId: req.id } });
    }
    if (e.status === 403 && e.code !== 'csrf_failed') {
      void logEvent('warn', 'security', `Forbidden: ${req.method} ${req.url}`, { userId: req.ctx?.user?.id, ip: req.ip });
    }
    return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details, requestId: req.id } });
  });

  // ---- API ---------------------------------------------------------------------------------------------------
  await registerAuthRoutes(app);
  await registerModules(app);

  await app.register(swagger, { mode: 'static', specification: { document: buildOpenApi() as never } });
  await app.register(swaggerUi, { routePrefix: '/api/v1/docs', uiConfig: { docExpansion: 'none' } });
  app.get('/api/v1/openapi.json', async () => buildOpenApi());

  // ---- Web application (PWA) ---------------------------------------------------------------------------------
  const webDir = config.webDir;
  if (opts.serveWeb !== false && existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        if (/[\\/]assets[\\/]/.test(path)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
    const indexHtml = () => readFileSync(join(webDir, 'index.html'), 'utf8');
    const bookingHtml = () =>
      existsSync(join(webDir, 'booking.html')) ? readFileSync(join(webDir, 'booking.html'), 'utf8') : indexHtml();
    app.setNotFoundHandler((req: FastifyRequest, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/health')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
      }
      reply.header('Cache-Control', 'no-cache').type('text/html');
      const isPublicPage = req.url.startsWith('/book') || req.url.startsWith('/r/') || req.url.startsWith('/feedback');
      if (isPublicPage) {
        // The public booking page may be embedded on the restaurant website / landing pages (booking widget).
        reply.removeHeader('x-frame-options');
        const csp = String(reply.getHeader('content-security-policy') ?? '');
        reply.header('content-security-policy', csp.replace(/frame-ancestors [^;]+/, 'frame-ancestors *'));
      }
      return reply.send(isPublicPage ? bookingHtml() : indexHtml());
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }));
  }

  return app;
}
