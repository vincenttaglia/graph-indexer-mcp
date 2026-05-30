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
import { httpPostJson } from '../utils/http.js';

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

/**
 * Resolve `chain` + `source` to a concrete endpoint URL and its kind, honoring
 * the `allowRemote` kill-switch. Throws a clear, credential-safe error (it
 * references the chain + source ONLY, never the resolved URL) when no usable
 * endpoint exists. This is the SSRF/typo guard: the agent supplies an alias,
 * never a URL, and an unknown alias is refused.
 */
function resolveEndpoint(
  cfg: {
    endpoints: Config['rpcEndpoints'];
    allowRemote: boolean;
  },
  chain: string,
  source: RpcSource,
): { url: string; endpointKind: 'local' | 'remote' } {
  const entry = cfg.endpoints[chain];
  if (!entry) {
    throw new Error(`unknown chain "${chain}"`);
  }

  if (source === 'local') {
    if (!entry.local) {
      throw new Error(`no local endpoint for chain "${chain}"`);
    }
    return { url: entry.local, endpointKind: 'local' };
  }

  if (source === 'remote') {
    if (!cfg.allowRemote) {
      throw new Error('remote RPC endpoints are disabled (RPC_ALLOW_REMOTE=false)');
    }
    if (!entry.remote) {
      throw new Error(`no remote endpoint for chain "${chain}"`);
    }
    return { url: entry.remote, endpointKind: 'remote' };
  }

  // source === 'auto': prefer the trusted local node, else fall back to a
  // remote endpoint only when third-party egress is enabled.
  if (entry.local) {
    return { url: entry.local, endpointKind: 'local' };
  }
  if (cfg.allowRemote && entry.remote) {
    return { url: entry.remote, endpointKind: 'remote' };
  }
  throw new Error(`no usable endpoint for chain "${chain}"`);
}

export function createRpcClient(cfg: {
  endpoints: Config['rpcEndpoints'];
  allowRemote: boolean;
  timeoutMs: number;
  maxBytes: number;
}): RpcClient {
  return {
    async call(chain, method, params, source, opts) {
      // Resolve alias → URL. Any resolution failure (unknown chain, missing
      // endpoint, remote disabled) throws here and propagates (fail-closed).
      const { url, endpointKind } = resolveEndpoint(cfg, chain, source);

      const body = { jsonrpc: '2.0', id: 1, method, params };

      // The `label` is the ONLY identifier that reaches error messages. It is
      // built from chain + endpointKind so the resolved URL (which may embed an
      // API key) can never leak through a thrown transport error.
      const resp = (await httpPostJson(url, body, {
        signal: opts?.signal,
        timeoutMs: cfg.timeoutMs,
        maxBytes: cfg.maxBytes,
        label: `rpc:${chain}:${endpointKind}`,
      })) as { result?: unknown; error?: unknown };

      // A JSON-RPC `error` envelope is a VALID response, not a transport
      // failure — relay it faithfully rather than throwing. Only httpPostJson's
      // transport-level failures (non-2xx, timeout, oversize, bad JSON) throw,
      // and those propagate to the caller fail-closed.
      if (resp && typeof resp === 'object' && 'error' in resp && resp.error !== undefined) {
        return { endpointKind, error: resp.error };
      }
      return { endpointKind, result: resp?.result };
    },
  };
}
