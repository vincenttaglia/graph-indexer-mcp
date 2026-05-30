/**
 * MCP tool backed by the IPFS client: `get_subgraph_manifest` (see plan §6.1).
 *
 * Registrar follows the deps-interface + `registerIndexerTool` style of
 * `src/tools/network-tools.ts`. All tools here are `read`-class.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { IpfsClient } from '../clients/ipfs.js';

export interface ManifestToolDeps {
  client: IpfsClient;
}

export function registerManifestTools(
  server: McpServer,
  deps: ManifestToolDeps,
): void {
  // TODO(leaf-A): register `get_subgraph_manifest` (permission class: `read`)
  // per plan §6.1:
  //   - Input: `{ deployment_id: z.string().min(1) }` (accepts Qm… or 0x…bytes32).
  //   - Handler:
  //       1. `extra.signal.throwIfAborted()`.
  //       2. `const cid = toQmDeploymentId(deployment_id)` (validates+normalizes).
  //       3. `const raw = await deps.client.cat(cid, { signal: extra.signal })`.
  //       4. Parse YAML→JSON (the `yaml` dep); return
  //          `{ deployment_id: cid, manifest: <parsed>, manifest_raw: raw }`,
  //          or on parse error `{ …, manifest: null, manifest_raw: raw, parse_error }`
  //          (never discard the raw bytes).
  //   - Use `registerIndexerTool` + `asText(payload)` like network-tools.ts.
  void server;
  void deps;
}
