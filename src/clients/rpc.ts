/**
 * Read-only JSON-RPC passthrough client (see plan §6.2).
 *
 * The agent selects a chain ALIAS (never a raw URL); this client resolves the
 * alias to an operator-configured endpoint URL and POSTs the JSON-RPC request.
 *
 * LAYER OWNERSHIP (decided per plan §6.2):
 *   - The TOOL (`src/tools/rpc-tools.ts`) owns the METHOD ALLOWLIST — the fixed
 *     constant of permitted read-only methods is the security boundary and is
 *     enforced before any call reaches this client. Extending it is a deliberate
 *     code change + review.
 *   - This CLIENT owns ENDPOINT RESOLUTION (alias + source → URL, honoring
 *     `allowRemote`) and the POST itself (timeout + size cap, fail-closed). It
 *     does NOT inspect `method`.
 */

import type { Config } from '../config.js';

export type RpcSource = 'local' | 'remote' | 'auto';

export interface RpcClient {
  /**
   * Route a JSON-RPC call to the resolved endpoint for `chain`/`source` and
   * relay the JSON-RPC `result` or `error` faithfully. `endpointKind` reports
   * which endpoint was used. NEVER returns or logs the endpoint URL.
   */
  call(
    chain: string,
    method: string,
    params: unknown[],
    source: RpcSource,
    opts?: { signal?: AbortSignal },
  ): Promise<{ endpointKind: 'local' | 'remote'; result?: unknown; error?: unknown }>;
}

export function createRpcClient(cfg: {
  endpoints: Config['rpcEndpoints'];
  allowRemote: boolean;
  timeoutMs: number;
  maxBytes: number;
}): RpcClient {
  // TODO(leaf-B): implement per plan §6.2.
  //   - Endpoint resolution:
  //       * `chain` must be a key in `cfg.endpoints` (else throw — SSRF/typo
  //         guard; the agent never supplies a URL).
  //       * source='local'  → require `entry.local`.
  //       * source='remote' → require `entry.remote` AND `cfg.allowRemote`.
  //       * source='auto'   → prefer `local`, else `remote` when allowed.
  //       * Refuse with a clear error referencing chain + source (NOT the URL).
  //   - POST `{ jsonrpc: '2.0', id: 1, method, params }` via
  //     `httpPostJson(url, body, { signal: opts?.signal, timeoutMs: cfg.timeoutMs,
  //     maxBytes: cfg.maxBytes, label: `chain=${chain} ${endpointKind}` })`.
  //   - Relay the parsed `{ result }` or `{ error }` plus `endpointKind`.
  //   - Method allowlisting is NOT done here — the tool enforces it (see header).
  void cfg;
  throw new Error('rpc client not implemented yet');
}
