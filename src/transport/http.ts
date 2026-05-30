import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';

/**
 * Host the MCP server over the StreamableHTTP transport.
 *
 * TODO(stage2-B): implement StreamableHTTPServerTransport + /healthz + /readyz.
 *
 * Expected behavior (per plan Phase 3):
 *   - Stand up a Node `http` server (no new HTTP framework dependency) bound to
 *     `config.httpHost`:`config.httpPort`.
 *   - Route MCP traffic to a `StreamableHTTPServerTransport` (SDK 1.29) wired to
 *     `server.connect(...)`. The transport surfaces the validated bearer token as
 *     `extra.authInfo`, which `register.ts` turns into the RequestContext.
 *   - `GET /healthz` (liveness): return 200 once the process is up.
 *   - `GET /readyz` (readiness): return 200 only after `server.connect` succeeds
 *     and, in k8s-rbac mode, after `authorizer.init()` has confirmed SAR access.
 *   - Return a handle whose `close()` gracefully shuts the http server down so
 *     `index.ts` can close it on SIGINT/SIGTERM.
 */
export async function startHttpTransport(
  _server: McpServer,
  _config: Config,
): Promise<{ close(): Promise<void> }> {
  throw new Error('http transport not implemented yet');
}
