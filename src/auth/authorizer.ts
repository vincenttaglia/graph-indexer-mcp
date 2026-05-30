import type { AccessLevel } from '../config.js';
import type { PermissionClass } from '../access-control.js';

/**
 * Per-request authorization context.
 *
 * `identity` is `null` on stdio (no token plumbing) — the StaticAuthorizer
 * ignores it. On http, it carries the validated bearer token (and, once an
 * authorizer resolves it, the user/groups) so policy authorizers can map the
 * caller to a subject.
 */
export interface RequestContext {
  identity: { token?: string; user?: string; groups?: string[] } | null;
  sessionId?: string;
}

/**
 * Pluggable grant strategy. Authorizers decide GRANTS only; the invariants
 * (unknown-tool deny, deny-list kill-switch) are enforced by `checkAccess()`
 * regardless of which authorizer is active.
 */
export interface Authorizer {
  /** Decide GRANTS only. Invariants are enforced by checkAccess(). */
  authorize(
    ctx: RequestContext,
    permissionClass: PermissionClass,
    toolName: string,
  ): Promise<boolean>;
  /** Optional startup self-check (e.g. confirm SAR access). */
  init?(): Promise<void>;
}

/**
 * Maps each access level to the set of permission classes it grants. This is
 * the canonical access matrix and is the only place the level→class mapping
 * lives.
 */
export const LEVEL_CLASSES: Record<AccessLevel, ReadonlySet<PermissionClass>> = {
  read_only: new Set(['read']),
  read_write: new Set(['read', 'agent_queue', 'graphman_safe']),
  read_write_destructive: new Set([
    'read',
    'agent_queue',
    'graphman_safe',
    'graphman_destructive',
  ]),
  full: new Set([
    'read',
    'agent_queue',
    'agent_approve',
    'graphman_safe',
    'graphman_destructive',
  ]),
};

/**
 * The default authorizer: today's level-based access model. A tool is granted
 * if it is on the `allow` override list OR the active level's class set
 * contains its permission class. Identity is ignored.
 */
export class StaticAuthorizer implements Authorizer {
  private readonly level: AccessLevel;
  private readonly allow: ReadonlySet<string>;

  constructor(level: AccessLevel, allow: ReadonlySet<string>) {
    this.level = level;
    this.allow = allow;
  }

  authorize(
    _ctx: RequestContext,
    permissionClass: PermissionClass,
    toolName: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.allow.has(toolName) || LEVEL_CLASSES[this.level].has(permissionClass),
    );
  }

  /** Expose the allow-list so `validateOverrides()` can inspect it. */
  getAllow(): ReadonlySet<string> {
    return this.allow;
  }

  /** Expose the active level for diagnostics. */
  getLevel(): AccessLevel {
    return this.level;
  }
}
