import type { AccessLevel } from './config.js';

export type PermissionClass =
  | 'read'
  | 'agent_queue'
  | 'agent_approve'
  | 'graphman_safe'
  | 'graphman_destructive';

const LEVEL_CLASSES: Record<AccessLevel, ReadonlySet<PermissionClass>> = {
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

const toolPermissions = new Map<string, PermissionClass>();
let activeConfig: AccessControlConfig | null = null;

export function initAccessControl(config: AccessControlConfig): void {
  activeConfig = config;
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
 *   1. `deny` override → always deny.
 *   2. Tool must have a registered permission class → otherwise deny (unknown tools cannot be allowed by override).
 *   3. `allow` override → grant even if the level wouldn't.
 *   4. Permission class is in the active level's class set → allow.
 *   5. Otherwise → deny.
 */
export function checkAccess(toolName: string): AccessCheckResult {
  if (!activeConfig) {
    throw new Error('Access control not initialized — call initAccessControl() first.');
  }

  if (activeConfig.deny.has(toolName)) {
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

  if (activeConfig.allow.has(toolName)) {
    return { allowed: true, permissionClass };
  }

  if (LEVEL_CLASSES[activeConfig.level].has(permissionClass)) {
    return { allowed: true, permissionClass };
  }

  return {
    allowed: false,
    reason: `Tool "${toolName}" requires permission class "${permissionClass}". Current access_level "${activeConfig.level}" does not grant it. Raise access_level or add this tool to access_overrides.allow.`,
    permissionClass,
  };
}

/**
 * Validate that every name in allow/deny overrides corresponds to a registered tool.
 * Returns a list of unknown names; callers can warn or fail.
 */
export function validateOverrides(): { unknownAllow: string[]; unknownDeny: string[] } {
  if (!activeConfig) {
    throw new Error('Access control not initialized — call initAccessControl() first.');
  }
  const unknownAllow: string[] = [];
  for (const name of activeConfig.allow) {
    if (!toolPermissions.has(name)) unknownAllow.push(name);
  }
  const unknownDeny: string[] = [];
  for (const name of activeConfig.deny) {
    if (!toolPermissions.has(name)) unknownDeny.push(name);
  }
  return { unknownAllow, unknownDeny };
}

export function resetForTests(): void {
  toolPermissions.clear();
  activeConfig = null;
}
