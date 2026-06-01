import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerIndexerTool } from '../server/register.js';
import type { GraphNodeClient } from '../clients/graph-node.js';

export interface GraphNodeToolsDeps {
  client: GraphNodeClient;
}

const deploymentIdSchema = z
  .string()
  .min(1, 'deployment_id is required')
  .describe('Subgraph deployment IPFS hash (Qm...).');

/**
 * Register Graph Node status MCP tools.
 *
 * Three read-only tools are registered:
 *   - `get_indexing_statuses` — bulk health/sync snapshot for many deployments.
 *   - `get_deployment_health` — detailed status for one deployment.
 *   - `get_entity_count`      — convenience accessor for the entity count.
 *
 * NOTE: `get_subgraph_size` is intentionally NOT registered here — that tool
 * requires direct Postgres access and lives in `src/tools/postgres-tools.ts`
 * (Track A5).
 */
export function registerGraphNodeTools(
  server: McpServer,
  deps: GraphNodeToolsDeps,
): void {
  const { client } = deps;

  // -------------------------------------------------------------------------
  // get_indexing_statuses
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_indexing_statuses',
    permissionClass: 'read',
    description:
      'Return indexing health and sync progress for subgraph deployments on graph-node. ' +
      'By default returns EVERY deployment graph-node is indexing — leave `deployment_ids` ' +
      'unset for that. To narrow to specific deployments, pass their IPFS hashes (Qm… or ' +
      '0x… bytes32) in `deployment_ids`. ' +
      'Each entry includes health (healthy/unhealthy/failed), sync state, per-chain block ' +
      'progress, fatal/non-fatal errors, and entity count.',
    inputSchema: {
      // Accept the full range of "no filter" shapes some MCP hosts emit when
      // they force every parameter to be present: `null`, `[null]`, `[]`, or a
      // mixed array. `.nullable()` admits a bare null; the element schema is
      // nullable so `[null]` passes validation. The handler below strips nulls
      // and collapses any empty/all-null result to "every deployment".
      deployment_ids: z
        .array(deploymentIdSchema.nullable())
        .nullable()
        .optional()
        .describe(
          'Deployment IPFS hashes (Qm… or 0x… bytes32) to narrow the results to. Leave unset to return every deployment graph-node is indexing; null or an empty array are also treated as "all".',
        ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Normalize the "no filter" shapes to undefined so the client takes its
      // "all deployments" path. A non-empty list of real hashes filters.
      const ids = (args.deployment_ids ?? []).filter(
        (id): id is string => typeof id === 'string',
      );
      const statuses = await client.getIndexingStatuses(
        ids.length > 0 ? ids : undefined,
        { signal: extra.signal },
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: statuses.length, statuses }, null, 2),
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // get_deployment_health
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_deployment_health',
    permissionClass: 'read',
    description:
      'Return detailed indexing health for a single deployment, including fatal/non-fatal ' +
      'errors, per-chain sync progress, and entity count. Returns `null` when the ' +
      'deployment is not tracked by this graph-node.',
    inputSchema: {
      deployment_id: deploymentIdSchema,
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const status = await client.getDeploymentHealth(args.deployment_id, {
        signal: extra.signal,
      });
      if (!status) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  deployment_id: args.deployment_id,
                  status: null,
                  message: 'Deployment not found on this graph-node.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      };
    },
  });

  // -------------------------------------------------------------------------
  // get_entity_count
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_entity_count',
    permissionClass: 'read',
    description:
      'Return the total entity count for a deployment as a decimal string ' +
      '(graph-node returns BigInt). Useful as a quick proxy for relative deployment size; ' +
      'use `get_subgraph_size` for actual disk usage. Returns `null` when the deployment ' +
      'is not tracked.',
    inputSchema: {
      deployment_id: deploymentIdSchema,
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const entityCount = await client.getEntityCount(args.deployment_id, {
        signal: extra.signal,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                deployment_id: args.deployment_id,
                entity_count: entityCount,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
