import { z, type ZodType } from 'zod';
import { APP_NAME, APP_VERSION } from '@sofia/shared';
import { routeRegistry } from './route.js';

function toSchema(schema: ZodType | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

function parameters(schema: ZodType | undefined, location: 'query' | 'path'): unknown[] {
  const js = toSchema(schema) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (!js?.properties) return [];
  return Object.entries(js.properties).map(([name, s]) => ({
    name,
    in: location,
    required: location === 'path' || (js.required ?? []).includes(name),
    schema: s,
  }));
}

/** Build the OpenAPI 3.1 document from the route registry (every route defined through defineRoute). */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeRegistry) {
    if (!r.url.startsWith('/api/') && !r.url.startsWith('/health')) continue;
    const path = r.url.replace(/:([a-zA-Z]+)/g, '{$1}');
    paths[path] ??= {};
    const op: Record<string, unknown> = {
      summary: r.summary,
      description: [r.description, r.permission ? `Required permission: \`${r.permission.join('` or `')}\`` : null]
        .filter(Boolean)
        .join('\n\n'),
      tags: r.tags,
      parameters: [...parameters(r.params, 'path'), ...parameters(r.query, 'query')],
      responses: {
        '200': { description: 'Success' },
        '401': { description: 'Authentication required' },
        '403': { description: 'Missing permission' },
        '422': { description: 'Validation error' },
      },
    };
    if (r.auth !== 'none') op.security = [{ cookieAuth: [] }, { bearerAuth: [] }];
    const body = toSchema(r.body);
    if (body) op.requestBody = { required: true, content: { 'application/json': { schema: body } } };
    paths[path][r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${APP_NAME} API`,
      version: APP_VERSION,
      description:
        'Versioned REST API of the Sofia Restaurant Management Platform. Authenticate with the session cookie ' +
        '(browser) plus the X-CSRF-Token header for state-changing requests, or with `Authorization: Bearer <token>`.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sofia_at' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    paths,
  };
}
