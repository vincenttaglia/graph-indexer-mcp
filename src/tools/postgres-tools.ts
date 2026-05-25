import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerTool } from '../server/register.js';
import type { PostgresClient, SubgraphSize } from '../clients/postgres.js';

export interface PostgresToolDeps {
  /**
   * Postgres client, or `null` when `GRAPH_NODE_POSTGRES_URL` was not set. We
   * still register the tools in the null case so they appear in the tool list
   * and surface a clear configuration error at call time.
   */
  client: PostgresClient | null;
}

/**
 * Register Postgres-backed read tools:
 *   - `get_subgraph_size`        — disk usage of one deployment
 *   - `get_all_subgraph_sizes`   — ranked disk usage across all deployments
 */
export function registerPostgresTools(
  server: McpServer,
  deps: PostgresToolDeps,
): void {
  const notConfigured = () => ({
    content: [
      {
        type: 'text' as const,
        text: 'Postgres not configured — set GRAPH_NODE_POSTGRES_URL',
      },
    ],
    isError: true,
  });

  registerIndexerTool(server, {
    name: 'get_subgraph_size',
    permissionClass: 'read',
    description:
      'Return the on-disk size of a deployment by summing pg_total_relation_size over every table in its sgdN schema. Reads the graph-node Postgres database directly.',
    inputSchema: { deployment_id: z.string() },
    handler: async (args, extra) => {
      // Honor caller cancellation at entry AND between query boundaries.
      // node-postgres doesn't natively observe AbortSignal for in-flight
      // queries — see TODO(stage4) on PostgresCallOpts — so a single
      // long-running query can't be cancelled mid-flight today; the signal
      // is checked before each underlying query in the client.
      extra.signal.throwIfAborted();
      if (!deps.client) return notConfigured();
      const result = await deps.client.getSubgraphSize(args.deployment_id, {
        signal: extra.signal,
      });
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: `No deployment_schemas entry found for "${args.deployment_id}".`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                deployment_id: result.deploymentId,
                namespace: result.namespace,
                size_bytes: result.sizeBytes,
                size_human: formatBytes(result.sizeBytes),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  registerIndexerTool(server, {
    name: 'get_all_subgraph_sizes',
    permissionClass: 'read',
    description:
      'Return on-disk size for every deployment known to graph-node, ranked descending by size. Useful for capacity planning and cleanup decisions.',
    handler: async (_args, extra) => {
      // Honor caller cancellation at entry AND between per-deployment queries
      // inside the client. See note above re: pg AbortSignal.
      extra.signal.throwIfAborted();
      if (!deps.client) return notConfigured();
      const sizes = await deps.client.getAllSubgraphSizes({ signal: extra.signal });
      const payload = sizes.map((s) => ({
        deployment_id: s.deploymentId,
        namespace: s.namespace,
        size_bytes: s.sizeBytes,
        size_human: formatBytes(s.sizeBytes),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    },
  });
}

// Re-export so callers wiring the server can construct deps without importing
// the client module separately if they prefer.
export type { SubgraphSize };

/**
 * Format a byte count as a human-readable string (B / KB / MB / GB / TB).
 *
 * Accepts `bigint` or a string (BigInt-safe) so callers don't lose precision
 * for multi-TB deployments. The scaling math uses Number only after we've
 * reduced the value to a manageable magnitude via integer division.
 */
export function formatBytes(bytes: bigint | string): string {
  let value: bigint;
  try {
    value = typeof bytes === 'bigint' ? bytes : BigInt(bytes);
  } catch {
    return `${String(bytes)} B`;
  }

  const negative = value < 0n;
  if (negative) value = -value;

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  const KB = 1024n;

  // Find the largest unit where value / 1024^i still has an integer portion.
  let unitIndex = 0;
  let divisor = 1n;
  while (unitIndex < units.length - 1 && value / (divisor * KB) > 0n) {
    divisor *= KB;
    unitIndex++;
  }

  if (unitIndex === 0) {
    return `${negative ? '-' : ''}${value.toString()} B`;
  }

  // Scale to two decimal places without losing precision: multiply by 100,
  // integer-divide by the divisor, then format.
  const scaled = (value * 100n) / divisor;
  const whole = scaled / 100n;
  const frac = scaled % 100n;
  const fracStr = frac.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr} ${units[unitIndex]}`;
}
