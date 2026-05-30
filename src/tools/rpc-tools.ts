/**
 * MCP tool backed by the RPC client: `rpc_call` (see plan §6.2).
 *
 * This tool OWNS the read-only method allowlist (the security boundary). The
 * client only resolves the endpoint and POSTs. Registrar follows the
 * deps-interface + `registerIndexerTool` style of `src/tools/network-tools.ts`.
 * `read`-class.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import type { RpcClient } from '../clients/rpc.js';

export interface RpcToolDeps {
  client: RpcClient;
  config: Config;
}

export function registerRpcTools(server: McpServer, deps: RpcToolDeps): void {
  // TODO(leaf-B): register `rpc_call` (permission class: `read`) per plan §6.2.
  //   - Define the fixed READ_ALLOWLIST constant HERE (the security boundary):
  //       eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getBlockByHash,
  //       eth_call, eth_getBalance, eth_getCode, eth_getStorageAt,
  //       eth_getTransactionCount, eth_getLogs, eth_getTransactionByHash,
  //       eth_getTransactionReceipt, eth_gasPrice, eth_maxPriorityFeePerGas,
  //       eth_feeHistory, eth_estimateGas, net_version, web3_clientVersion.
  //     Anything else → refuse: "method X is not permitted (read-only allowlist)".
  //   - Input:
  //       { chain: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  //         method: z.string(),
  //         params: z.array(z.unknown()).default([]),
  //         source: z.enum(['local','remote','auto']).default('auto') }
  //   - Handler: `extra.signal.throwIfAborted()`, enforce allowlist, then
  //     `deps.client.call(chain, method, params, source, { signal: extra.signal })`.
  //     Return `{ chain, endpoint_kind, result }` or `{ …, error }`. NEVER return
  //     the endpoint URL. Endpoint resolution (incl. unknown-chain refusal and
  //     rpcAllowRemote enforcement) is done by the client.
  //   - Use `registerIndexerTool` + `asText(payload)` like network-tools.ts.
  void server;
  void deps;
}
