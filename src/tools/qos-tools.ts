/**
 * MCP tools backed by the QoS subgraph client.
 *
 * Registers three read-only tools:
 *   - get_query_volume            — counts per deployment over a window
 *   - get_indexer_qos             — latency / success / blocks-behind for self
 *   - get_top_queried_deployments — ranked discovery feed
 *
 * Tools share a `time_range` shape (hours / days / epochs) and return their
 * JSON payloads as a single text content block — the simplest CallToolResult
 * format that's both human-readable and machine-parseable.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { registerIndexerTool } from '../server/register.js';
import type { QosSubgraphClient } from '../clients/qos-subgraph.js';

/**
 * Reusable time-range schema. Mirrors {@link TimeRange} in src/types/qos.ts —
 * keep these two in sync.
 */
const timeRangeSchema = z.union([
  z.object({ hours: z.number().positive() }).strict(),
  z.object({ days: z.number().positive() }).strict(),
  z
    .object({
      epochs: z.number().int().positive(),
      seconds_per_epoch: z.number().positive().optional(),
    })
    .strict(),
]);

export interface RegisterQosToolsDeps {
  client: QosSubgraphClient;
  config: Config;
}

/**
 * Pack a JSON payload as a single text content block. MCP allows multiple
 * content parts, but for structured-data tools a single JSON string is
 * easiest for downstream LLMs to parse.
 */
function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerQosTools(server: McpServer, deps: RegisterQosToolsDeps): void {
  const { client, config } = deps;

  // ---------------------------------------------------------------------------
  // get_query_volume
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_query_volume',
    permissionClass: 'read',
    description:
      'Query counts per deployment from the QoS Oracle subgraph, aggregated ' +
      'over daily buckets (the oracle\'s native granularity — windows shorter ' +
      'than 1 day round up). Omit deployment_id to get all deployments. ' +
      'query_count is a BigInt-as-string; parse via BigInt(row.query_count). ' +
      'time_range accepts { hours: N }, { days: N }, or ' +
      '{ epochs: N, seconds_per_epoch?: N }.',
    inputSchema: {
      deployment_id: z.string().min(1).optional(),
      time_range: timeRangeSchema,
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const rows = await client.getQueryVolume(
        {
          deploymentId: args.deployment_id,
          timeRange: args.time_range,
        },
        { signal: extra.signal },
      );
      return jsonResult({ rows });
    },
  });

  // ---------------------------------------------------------------------------
  // get_indexer_qos
  //
  // Uses config.indexerAddress — operators only ever query QoS for their own
  // indexer (the gateway-side data for other indexers isn't actionable from
  // this MCP).
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_indexer_qos',
    permissionClass: 'read',
    description:
      "Indexer-side QoS metrics (latency, success rate, blocks-behind) for " +
      'the configured indexer, weighted-averaged across days by ' +
      'dataPointCount. With deployment_id: returns one row aggregated over ' +
      'AllocationDailyDataPoint. Without it: returns one network-wide row ' +
      'aggregated over IndexerDailyDataPoint. Numeric fields are BigDecimal-/' +
      'BigInt-as-string. time_range accepts { hours: N }, { days: N }, or ' +
      '{ epochs: N, seconds_per_epoch?: N }.',
    inputSchema: {
      deployment_id: z.string().min(1).optional(),
      time_range: timeRangeSchema,
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const rows = await client.getIndexerQoS(
        {
          indexerAddress: config.indexerAddress,
          deploymentId: args.deployment_id,
          timeRange: args.time_range,
        },
        { signal: extra.signal },
      );
      return jsonResult({
        indexer_address: config.indexerAddress,
        rows,
      });
    },
  });

  // ---------------------------------------------------------------------------
  // get_top_queried_deployments
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_top_queried_deployments',
    permissionClass: 'read',
    description:
      'Rank deployments by total query volume over a daily time window. ' +
      'Useful for discovery — high-volume deployments are revenue ' +
      'opportunities. query_count is a BigInt-as-string. time_range accepts ' +
      '{ hours: N }, { days: N }, or { epochs: N, seconds_per_epoch?: N }.',
    inputSchema: {
      limit: z.number().int().positive().max(1000).default(20),
      time_range: timeRangeSchema,
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const rows = await client.getTopQueriedDeployments(
        {
          limit: args.limit,
          timeRange: args.time_range,
        },
        { signal: extra.signal },
      );
      return jsonResult({ rows });
    },
  });
}
