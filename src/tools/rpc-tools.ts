/**
 * MCP tool backed by the RPC client: `rpc_call` (see plan §6.2).
 *
 * This tool OWNS the read-only method allowlist (the security boundary). The
 * client only resolves the endpoint and POSTs. Registrar follows the
 * deps-interface + `registerIndexerTool` style of `src/tools/network-tools.ts`.
 * `read`-class.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerTool } from '../server/register.js';
import type { Config } from '../config.js';
import type { RpcClient } from '../clients/rpc.js';

export interface RpcToolDeps {
  client: RpcClient;
  config: Config;
}

/**
 * SECURITY BOUNDARY — read-only JSON-RPC method allowlist.
 *
 * This fixed constant is the single gate that makes `rpc_call` safe: only the
 * methods listed here may reach an endpoint. It MUST remain read-only. NEVER
 * add a state-changing or signing method — e.g. `eth_sendRawTransaction`,
 * `eth_sendTransaction`, `personal_*`, `eth_sign`, `eth_signTransaction`,
 * `eth_signTypedData*`. Extending this list is a deliberate code change that
 * requires review. The server holds no signer, so this list is both safe and
 * the complete set of permitted operations.
 */
const READ_ALLOWLIST: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_estimateGas',
  'net_version',
  'web3_clientVersion',
]);

function asText(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function asErrorText(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

export function registerRpcTools(server: McpServer, deps: RpcToolDeps): void {
  registerIndexerTool(server, {
    name: 'rpc_call',
    permissionClass: 'read',
    description:
      'Read-only JSON-RPC passthrough to the chains the indexer serves. ' +
      '`chain` must be a configured alias (e.g. "arbitrum-one"); raw URLs are ' +
      'never accepted (the operator maps aliases to endpoints). `method` must ' +
      'be in the read-only allowlist (e.g. eth_chainId, eth_blockNumber, ' +
      'eth_call, eth_getLogs, eth_getTransactionReceipt). `source` selects the ' +
      'endpoint: "local" (the indexer node — trusted/private), "remote" ' +
      '(third-party — may rate-limit/log), or "auto" (prefers local). ' +
      'State-changing or signing methods (eth_sendRawTransaction, ' +
      'eth_sendTransaction, personal_*, eth_sign*) are NOT permitted. ' +
      'Endpoint URLs are never returned.',
    inputSchema: {
      chain: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'chain alias'),
      method: z.string().min(1),
      params: z.array(z.unknown()).default([]),
      source: z.enum(['local', 'remote', 'auto']).default('auto'),
    },
    handler: async ({ chain, method, params, source }, extra) => {
      extra.signal.throwIfAborted();

      // Security boundary: enforce the read-only allowlist BEFORE the client is
      // ever touched. A refused method never resolves an endpoint or makes a
      // network call.
      if (!READ_ALLOWLIST.has(method)) {
        return asErrorText(
          `RPC method "${method}" is not permitted (read-only allowlist).`,
        );
      }

      // SSRF/typo guard, also enforced before the client call so an unknown
      // alias never reaches endpoint resolution.
      if (!(chain in deps.config.rpcEndpoints)) {
        return asErrorText(
          `Unknown chain "${chain}". Configured: ${Object.keys(deps.config.rpcEndpoints).join(', ')}`,
        );
      }

      try {
        const out = await deps.client.call(chain, method, params, source, {
          signal: extra.signal,
        });
        // Faithfully relay either the JSON-RPC `result` or `error`. The client
        // guarantees the endpoint URL is never present in this payload.
        return asText({
          chain,
          endpoint_kind: out.endpointKind,
          ...(out.error !== undefined ? { error: out.error } : { result: out.result }),
        });
      } catch (e) {
        // The client/http layer guarantee the message references chain +
        // endpoint kind only (never the URL); we add nothing URL-derived here.
        return asErrorText(
          `rpc_call failed for chain "${chain}": ${(e as Error).message}`,
        );
      }
    },
  });
}
