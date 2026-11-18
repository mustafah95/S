import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { PERMISSIONS, passwordSchema, userCreateSchema, userUpdateSchema } from '@sofia/shared';
import { camelRows, getDb, q, schema, sql, type DbOrTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { branchScope, type RequestContext } from '../lib/context.js';
import { hashPassword } from '../lib/crypto.js';
import { forbidden, notFound, unprocessable } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute, idParams } from '../lib/route.js';
import { invalidateAuthCache, revokeAllSessions } from './auth/service.js';

const PRIVILEGED = new Set(['super_admin', 'owner']);

async function roleByKey(tx: DbOrTx, key: string) {
  const [r] = await tx.select().from(schema.roles).where(eq(schema.roles.key, key));
  if (!r) throw unprocessable('invalid_role', `Unknown role ${key}`);
  return r;
}

/** Managers can only manage users of their own branches and cannot grant roles above their own. */
function assertCanAssign(ctx: RequestContext, roleKey: string, branchIds: string[]) {
  if (PRIVILEGED.has(roleKey) && !PRIVILEGED.has(ctx.user!.roleKey)) throw forbidden('Only an owner or super admin can assign this role');
  const scope = branchScope(ctx);
  if (scope && branchIds.some((b) => !scope.includes(b))) throw forbidden('You can only assign branches you manage');
}

export async function createUser(tx: DbOrTx, ctx: RequestContext, input: z.infer<typeof userCreateSchema>) {
  const role = await roleByKey(tx, input.roleKey);
  if (input.password.toLowerCase().includes(input.username.toLowerCase())) throw unprocessable('weak_password', 'Password must not contain the username');
  const [user] = await tx
    .insert(schema.users)
    .values({
      username: input.username,
      email: input.email ?? null,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      roleId: role.id,
      isActive: input.isActive,
      preferredLanguage: input.preferredLanguage,
      mfaRequired: input.mfaRequired,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();
  for (const b of input.branchIds) await tx.insert(schema.userBranches).values({ userId: user!.id, branchId: b });
  await audit(tx, ctx, { action: 'user.create', entityType: 'user', entityId: user!.id, after: { ...user, roleKey: input.roleKey, branchIds: input.branchIds } });
  return user!;
}

function userView(u: Record<string, unknown>) {
  const { passwordHash: _p, mfaSecretEnc: _m, mfaRecoveryHashes: _r, password_hash: _p2, mfa_secret_enc: _m2, mfa_recovery_hashes: _r2, ...rest } = u;
  return rest;
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/users', summary: 'List staff accounts', tags: ['Users'], permission: 'users.read' }, async ({ ctx }) => {
    const scope = branchScope(ctx);
    const rows = await q(
      db,
      sql`SELECT u.*, r.key AS role_key, r.name_en AS role_name, r.name_ar AS role_name_ar,
                 coalesce((SELECT array_agg(branch_id) FROM user_branches ub WHERE ub.user_id = u.id), '{}') AS branch_ids
          FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.deleted_at IS NULL
            ${scope ? (scope.length ? sql`AND (r.all_branches = false AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id IN ${scope}))` : sql`AND false`) : sql``}
          ORDER BY u.display_name`,
    );
    return camelRows(rows).map(userView);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/users/directory', summary: 'Minimal staff directory (names) for assignment pickers', tags: ['Users'], permission: 'reservations.read' }, async () =>
    q(db, sql`SELECT id, display_name AS "displayName" FROM users WHERE deleted_at IS NULL AND is_active ORDER BY display_name`),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/users', summary: 'Create a staff account', tags: ['Users'], permission: 'users.manage', body: userCreateSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertCanAssign(ctx, body.roleKey, body.branchIds);
      return userView((await createUser(tx, ctx, body)) as unknown as Record<string, unknown>);
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/users/:id', summary: 'Update a staff account (role, branches, activation)', tags: ['Users'], permission: 'users.manage', params: idParams, body: userUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.users).where(and(eq(schema.users.id, params.id), isNull(schema.users.deletedAt)));
      if (!before) throw notFound('User');
      const [currentRole] = await tx.select().from(schema.roles).where(eq(schema.roles.id, before.roleId));
      if (PRIVILEGED.has(currentRole!.key) && !PRIVILEGED.has(ctx.user!.roleKey)) throw forbidden('Only an owner or super admin can modify this account');
      if (params.id === ctx.user!.id && (body.roleKey || body.isActive === false)) throw forbidden('You cannot change your own role or deactivate yourself');
      const set: Partial<typeof schema.users.$inferInsert> = { updatedBy: ctx.user!.id };
      if (body.roleKey) {
        assertCanAssign(ctx, body.roleKey, body.branchIds ?? []);
        set.roleId = (await roleByKey(tx, body.roleKey)).id;
      }
      for (const k of ['email', 'displayName', 'preferredLanguage', 'isActive', 'mfaRequired'] as const) if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
      const [after] = await tx.update(schema.users).set(set).where(eq(schema.users.id, params.id)).returning();
      if (body.branchIds) {
        assertCanAssign(ctx, body.roleKey ?? currentRole!.key, body.branchIds);
        await tx.delete(schema.userBranches).where(eq(schema.userBranches.userId, params.id));
        for (const b of body.branchIds) await tx.insert(schema.userBranches).values({ userId: params.id, branchId: b });
      }
      if (body.isActive === false) await revokeAllSessions(params.id, null, 'deactivated', tx);
      await audit(tx, ctx, { action: 'user.update', entityType: 'user', entityId: params.id, before, after, meta: { roleKey: body.roleKey, branchIds: body.branchIds } });
      invalidateAuthCache(params.id);
      await publish({ type: 'control', action: 'auth-cache', target: params.id }, tx);
      return userView(after as unknown as Record<string, unknown>);
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/users/:id/reset-password', summary: 'Set a new password for a staff member (revokes their sessions)', tags: ['Users'], permission: 'users.manage', params: idParams, body: z.object({ password: passwordSchema }) }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, params.id));
      if (!u) throw notFound('User');
      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.id, u.roleId));
      if (PRIVILEGED.has(role!.key) && !PRIVILEGED.has(ctx.user!.roleKey)) throw forbidden();
      await tx.update(schema.users).set({ passwordHash: await hashPassword(body.password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, params.id));
      await revokeAllSessions(params.id, null, 'password_reset', tx);
      await audit(tx, ctx, { action: 'user.password_reset', entityType: 'user', entityId: params.id });
      return { ok: true };
    }),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/roles', summary: 'Roles and their permissions', tags: ['Users'], permission: 'users.read' }, async () => {
    const rows = await q(db, sql`SELECT r.id, r.key, r.name_en, r.name_ar, r.all_branches, r.is_system,
                                       coalesce((SELECT array_agg(permission ORDER BY permission) FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS permissions
                                FROM roles r ORDER BY r.created_at`);
    return { roles: camelRows(rows), allPermissions: PERMISSIONS };
  });

  defineRoute(app, { method: 'PUT', url: '/api/v1/roles/:id/permissions', summary: 'Replace the permissions of a role', tags: ['Users'], permission: 'users.manage', params: idParams, body: z.object({ permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length) }) }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      if (!PRIVILEGED.has(ctx.user!.roleKey)) throw forbidden('Only an owner or super admin can change role permissions');
      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.id, params.id));
      if (!role) throw notFound('Role');
      if (role.key === 'super_admin') throw forbidden('The Super Admin role always has every permission');
      const before = await q<{ permission: string }>(tx, sql`SELECT permission FROM role_permissions WHERE role_id = ${params.id}`);
      await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, params.id));
      for (const p of new Set(body.permissions)) await tx.insert(schema.rolePermissions).values({ roleId: params.id, permission: p });
      await audit(tx, ctx, { action: 'role.permissions', entityType: 'role', entityId: role.key, before: { permissions: before.map((b) => b.permission).sort() }, after: { permissions: [...body.permissions].sort() } });
      invalidateAuthCache();
      await publish({ type: 'control', action: 'auth-cache' }, tx);
      return { ok: true };
    }),
  );
}
