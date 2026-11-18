import type { Permission } from '@sofia/shared';
import { forbidden } from './errors.js';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleKey: string;
  permissions: Set<string>;
  allBranches: boolean;
  branchIds: string[];
  sessionId: string;
  preferredLanguage: string;
  mfaEnabled: boolean;
}

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent?: string;
  deviceId?: string;
  user?: AuthUser;
  /** For sync: the user who performed the operation offline (may differ from the session user). */
  offlineUserId?: string;
  /** Background processes (worker, updater, public booking) act as the system. */
  system?: string;
}

export function systemContext(name: string): RequestContext {
  return { requestId: `system-${name}`, ip: '127.0.0.1', system: name };
}

export function actorId(ctx: RequestContext): string | null {
  return ctx.user?.id ?? null;
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  if (ctx.system) return true;
  return !!ctx.user?.permissions.has(permission);
}

export function requirePermission(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx, permission)) throw forbidden(`Missing permission: ${permission}`);
}

/** null = every branch; otherwise the list of branch ids the actor may access. */
export function branchScope(ctx: RequestContext): string[] | null {
  if (ctx.system || ctx.user?.allBranches) return null;
  return ctx.user?.branchIds ?? [];
}

export function canAccessBranch(ctx: RequestContext, branchId: string | null | undefined): boolean {
  if (!branchId) return true;
  const scope = branchScope(ctx);
  return scope === null || scope.includes(branchId);
}

export function assertBranchAccess(ctx: RequestContext, branchId: string | null | undefined): void {
  if (!canAccessBranch(ctx, branchId)) throw forbidden('You do not have access to this branch');
}
