import type { AccessLevel } from './config.js';
import {
  StaticAuthorizer,
  type Authorizer,
  type RequestContext,
} from './auth/authorizer.js';

export type PermissionClass =
  | 'read'
  | 'agent_queue'
  | 'agent_approve'
  | 'graphman_safe'
  | 'graphman_destructive';

export interface AccessControlConfig {
  level: AccessLevel;
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
  permissionClass?: PermissionClass;
}

interface AccessControlState {
  authorizer: Authorizer | null;
  hardDeny: ReadonlySet<string>;
}

const toolPermissions = new Map<string, PermissionClass>();
const state: AccessControlState = { authorizer: null, hardDeny: new Set() };

/**
 * Backward-compatible init for the static (level-based) path. Constructs a
 * `StaticAuthorizer` from `{ level, allow }` and stores `deny` as the
 * always-enforced `hardDeny` invariant.
 */
export function initAccessControl(config: AccessControlConfig): void {
  state.authorizer = new StaticAuthorizer(config.level, config.allow);
  state.hardDeny = config.deny;
}

/**
 * Pluggable init: install any `Authorizer` as the grant strategy while keeping
 * the `deny` list as an always-enforced invariant.
 */
export function initAccessControlWith(
  authorizer: Authorizer,
  opts: { deny: ReadonlySet<string> },
): void {
  state.authorizer = authorizer;
  state.hardDeny = opts.deny;
}

export function registerToolPermission(
  toolName: string,
  permissionClass: PermissionClass,
): void {
  const existing = toolPermissions.get(toolName);
  if (existing && existing !== permissionClass) {
    throw new Error(
      `Tool "${toolName}" already registered with permission class "${existing}"; cannot re-register as "${permissionClass}".`,
    );
  }
  toolPermissions.set(toolName, permissionClass);
}

export function getToolPermission(toolName: string): PermissionClass | undefined {
  return toolPermissions.get(toolName);
}

export function listRegisteredTools(): ReadonlyMap<string, PermissionClass> {
  return new Map(toolPermissions);
}

/**
 * Decide whether a tool call is allowed.
 *
 * Resolution order (default-deny):
 *   1. `deny` override → always deny.            (invariant)
 *   2. Tool must have a registered permission class → otherwise deny
 *      (unknown tools cannot be granted by any authorizer).   (invariant)
 *   3. Grant: delegate to the active authorizer. For the static authorizer
 *      this is `allow.has(tool) || level grants the class`.
 */
export async function checkAccess(
  toolName: string,
  ctx?: RequestContext,
): Promise<AccessCheckResult> {
  if (!state.authorizer) {
    throw new Error('Access control not initialized — call initAccessControl() first.');
  }

  if (state.hardDeny.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is explicitly denied by access_overrides.deny.`,
      permissionClass: toolPermissions.get(toolName),
    };
  }

  const permissionClass = toolPermissions.get(toolName);
  if (!permissionClass) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" has no registered permission class; refused by default.`,
    };
  }

  const granted = await state.authorizer.authorize(
    ctx ?? { identity: null },
    permissionClass,
    toolName,
  );
  if (granted) {
    return { allowed: true, permissionClass };
  }

  return {
    allowed: false,
    reason: `Tool "${toolName}" requires permission class "${permissionClass}", which the active authorizer does not grant for this caller. Raise access_level or add this tool to access_overrides.allow.`,
    permissionClass,
  };
}

/**
 * Validate that every name in allow/deny overrides corresponds to a registered
 * tool. Returns a list of unknown names; callers can warn or fail.
 *
 * The deny-list is a wrapper-level invariant and is always validated. The
 * allow-list lives inside the authorizer; it can only be inspected when the
 * active authorizer is a `StaticAuthorizer`. For other authorizers there is no
 * static allow-list to validate, so `unknownAllow` is empty.
 */
export function validateOverrides(): { unknownAllow: string[]; unknownDeny: string[] } {
  if (!state.authorizer) {
    throw new Error('Access control not initialized — call initAccessControl() first.');
  }
  const unknownAllow: string[] = [];
  if (state.authorizer instanceof StaticAuthorizer) {
    for (const name of state.authorizer.getAllow()) {
      if (!toolPermissions.has(name)) unknownAllow.push(name);
    }
  }
  const unknownDeny: string[] = [];
  for (const name of state.hardDeny) {
    if (!toolPermissions.has(name)) unknownDeny.push(name);
  }
  return { unknownAllow, unknownDeny };
}

export function resetForTests(): void {
  toolPermissions.clear();
  state.authorizer = null;
  state.hardDeny = new Set();
}
