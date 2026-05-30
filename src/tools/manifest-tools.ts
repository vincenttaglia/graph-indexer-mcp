/**
 * MCP tool backed by the IPFS client: `get_subgraph_manifest` (see plan §6.1).
 *
 * Registrar follows the deps-interface + `registerIndexerTool` style of
 * `src/tools/network-tools.ts`. All tools here are `read`-class.
 */

import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { registerIndexerTool } from '../server/register.js';
import { toQmDeploymentId } from '../utils/ipfs.js';
import type { IpfsClient } from '../clients/ipfs.js';

export interface ManifestToolDeps {
  client: IpfsClient;
}

function asText(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerManifestTools(
  server: McpServer,
  deps: ManifestToolDeps,
): void {
  registerIndexerTool(server, {
    name: 'get_subgraph_manifest',
    permissionClass: 'read',
    description:
      'Fetch a subgraph deployment manifest from IPFS by deployment ID. ' +
      'Accepts either the Qm… (IPFS CIDv0) or 0x… (bytes32) encoding — the ID ' +
      'is normalized to its IPFS CID before fetching. Returns the parsed ' +
      'manifest (YAML→JSON) plus the raw manifest text. On YAML parse failure ' +
      'the raw bytes are still returned alongside a parse_error field.',
    inputSchema: {
      deployment_id: z.string().min(1),
    },
    handler: async ({ deployment_id }, extra) => {
      extra.signal.throwIfAborted();

      // Normalize the deployment ID to its IPFS CID (Qm form). Bad input
      // (neither Qm… nor 0x…bytes32) throws a clear error here; surface it as
      // a tool error result WITHOUT attempting any IPFS fetch.
      let cid: string;
      try {
        cid = toQmDeploymentId(deployment_id);
      } catch (e) {
        return asText(
          { error: (e as Error).message },
          true,
        );
      }

      const raw = await deps.client.cat(cid, { signal: extra.signal });

      // Parse YAML → JSON. `yaml.parse` returns plain data (no code exec). On
      // failure, never discard the raw bytes — return them plus parse_error so
      // the caller can still inspect the manifest content.
      let manifest: unknown = null;
      let parseError: string | undefined;
      try {
        manifest = parseYaml(raw);
      } catch (e) {
        parseError = (e as Error).message;
      }

      return asText({
        deployment_id: cid,
        manifest,
        manifest_raw: raw,
        ...(parseError ? { parse_error: parseError } : {}),
      });
    },
  });
}
