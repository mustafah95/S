import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { Permission } from '@sofia/shared';
import { AppError, forbidden, unauthorized } from './errors.js';
import type { AuthUser, RequestContext } from './context.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDefinition<B, Q, P> {
  method: HttpMethod;
  url: string;
  summary: string;
  tags: string[];
  /** 'required' (default): valid session needed. 'optional': user attached when present. 'none': public. */
  auth?: 'required' | 'optional' | 'none';
  /** The user needs ANY of these permissions. */
  permission?: Permission | Permission[];
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  rateLimit?: { max: number; timeWindow: string };
  /** Skip CSRF verification (public endpoints, signed webhooks). */
  skipCsrf?: boolean;
  /** Allowed while the system is in maintenance mode (default: only GET requests are allowed). */
  allowInMaintenance?: boolean;
  bodyLimit?: number;
  description?: string;
}

export interface HandlerContext<B, Q, P> {
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  ctx: RequestContext;
  user: AuthUser;
}

export interface RegisteredRoute {
  method: HttpMethod;
  url: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: 'required' | 'optional' | 'none';
  permission?: Permission[];
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export const routeRegistry: RegisteredRoute[] = [];

function parse<T>(schema: ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T;
  const r = schema.safeParse(value ?? (where === 'body' ? {} : value));
  if (!r.success) {
    throw new AppError(422, 'validation_error', `Invalid ${where}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    });
  }
  return r.data;
}

export const idParams = z.object({ id: z.uuid() });

/**
 * Define an API route. Authentication, RBAC, validation and OpenAPI documentation are all derived from the
 * definition, so an endpoint cannot be registered without its authorization rule.
 */
export function defineRoute<B = unknown, Q = unknown, P = unknown>(
  app: FastifyInstance,
  def: RouteDefinition<B, Q, P>,
  handler: (h: HandlerContext<B, Q, P>) => Promise<unknown> | unknown,
): void {
  const auth = def.auth ?? 'required';
  const permissions = def.permission ? (Array.isArray(def.permission) ? def.permission : [def.permission]) : undefined;
  routeRegistry.push({
    method: def.method,
    url: def.url,
    summary: def.summary,
    description: def.description,
    tags: def.tags,
    auth,
    permission: permissions,
    body: def.body as ZodType | undefined,
    query: def.query as ZodType | undefined,
    params: def.params as ZodType | undefined,
  });

  app.route({
    method: def.method,
    url: def.url,
    bodyLimit: def.bodyLimit,
    config: {
      rateLimit: def.rateLimit,
      skipCsrf: def.skipCsrf ?? auth === 'none',
      allowInMaintenance: def.allowInMaintenance ?? false,
      authMode: auth,
    },
    handler: async (req, reply) => {
      const ctx = req.ctx;
      if (auth === 'required' && !ctx.user) throw unauthorized();
      if (permissions && ctx.user && !permissions.some((p) => ctx.user!.permissions.has(p))) {
        throw forbidden(`Missing permission: ${permissions.join(' or ')}`);
      }
      const params = parse(def.params, req.params, 'path parameters');
      const query = parse(def.query, req.query, 'query');
      const body = parse(def.body, req.body, 'body');
      const result = await handler({ req, reply, body, query, params, ctx, user: ctx.user as AuthUser });
      if (reply.sent) return reply;
      if (result === undefined) return reply.code(204).send();
      return result;
    },
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
  interface FastifyContextConfig {
    skipCsrf?: boolean;
    allowInMaintenance?: boolean;
    authMode?: 'required' | 'optional' | 'none';
  }
}
