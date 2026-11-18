import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { can } from '../lib/context.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute, idParams } from '../lib/route.js';
import { CLIENT_READABLE, SETTINGS, getSetting, putSecrets, putSetting, type SettingKey } from '../lib/settings.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);

const SECRET_FIELDS: Record<string, string[]> = {
  'integrations.whatsapp': ['accessToken', 'appSecret', 'verifyToken'],
  'integrations.email': ['password'],
  'integrations.sms': ['authToken', 'apiKey'],
};

export async function storeFile(input: { fileName: string; mimeType: string; data: Buffer; purpose: string; userId?: string | null }) {
  if (!ALLOWED_MIME.has(input.mimeType)) throw badRequest('Only PNG, JPEG, WebP, SVG or ICO images are allowed');
  if (input.mimeType === 'image/svg+xml' && /<script|on\w+=|javascript:/i.test(input.data.toString('utf8'))) {
    throw badRequest('SVG files with scripts are not allowed');
  }
  const [f] = await getDb()
    .insert(schema.storedFiles)
    .values({ fileName: input.fileName.slice(0, 200), mimeType: input.mimeType, sizeBytes: input.data.length, sha256: sha256(input.data), purpose: input.purpose, data: input.data, createdBy: input.userId ?? null })
    .returning({ id: schema.storedFiles.id });
  return f!.id;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/settings', summary: 'Settings readable by the current user', tags: ['Settings'], allowInMaintenance: true }, async ({ ctx }) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      const perm = SETTINGS[key].permission;
      if (CLIENT_READABLE.includes(key) || (perm && can(ctx, perm as never)) || (key.startsWith('system.') && can(ctx, 'system.health'))) {
        out[key] = await getSetting(key);
      }
    }
    return out;
  });

  defineRoute(
    app,
    { method: 'PUT', url: '/api/v1/settings/:key', summary: 'Update a settings group (branding, general, guests, backup, notifications, integrations.*)', tags: ['Settings'], params: z.object({ key: z.string().max(60) }), body: z.object({ value: z.record(z.string(), z.unknown()), secrets: z.record(z.string(), z.string().max(2000)).optional() }) },
    async ({ params, body, ctx }) => {
      const key = params.key as SettingKey;
      const def = SETTINGS[key];
      if (!def || !def.permission) throw notFound('Settings group');
      if (!can(ctx, def.permission as never)) throw forbidden(`Missing permission: ${def.permission}`);
      return db.transaction(async (tx) => {
        let value = body.value;
        if (body.secrets && SECRET_FIELDS[key]) {
          const allowed = Object.fromEntries(Object.entries(body.secrets).filter(([k, v]) => SECRET_FIELDS[key]!.includes(k) && v));
          if (Object.keys(allowed).length) {
            await putSecrets(tx, ctx, key.replace('integrations.', ''), allowed);
            value = { ...value, secretsSet: true };
          }
        }
        const saved = await putSetting(tx, ctx, key, value);
        await publish({ type: 'control', action: 'settings' }, tx);
        return saved;
      });
    },
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/files', summary: 'Upload an image (logo, login background, favicon)', tags: ['Settings'], permission: 'settings.manage' }, async ({ req, ctx }) => {
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded');
    const data = await file.toBuffer();
    const id = await storeFile({ fileName: file.filename, mimeType: file.mimetype, data, purpose: String((file.fields.purpose as { value?: string } | undefined)?.value ?? 'branding'), userId: ctx.user?.id });
    await audit(db, ctx, { action: 'file.upload', entityType: 'file', entityId: id, meta: { name: file.filename, size: data.length } });
    return { id, url: `/api/v1/files/${id}` };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/files/:id', summary: 'Download a stored image (public: used for branding)', tags: ['Settings'], auth: 'none', params: idParams, allowInMaintenance: true }, async ({ params, reply }) => {
    const [f] = await db.select().from(schema.storedFiles).where(eq(schema.storedFiles.id, params.id));
    if (!f) throw notFound('File');
    reply
      .header('content-type', f.mimeType)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return reply.send(f.data);
  });
}
