/**
 * Resource: `indexer://overview`
 *
 * Live aggregated infrastructure summary across the five data sources Claude
 * relies on for situational awareness. Designed to be the first thing Claude
 * pulls when asked an open-ended question like "how is my indexer doing right
 * now" — it answers without forcing a flurry of individual tool calls.
 *
 * Aggregation strategy is best-effort:
 *
 *   - Each source is awaited independently; one source failing does NOT
 *     prevent the others from being reported. Sources that fail surface their
 *     error message under `partialErrors.<source>`, with credentials scrubbed
 *     so a malformed gateway URL embedded in an error string cannot leak the
 *     API key.
 *
 *   - Postgres is optional. When `graphNodePostgresUrl` is unset, the client
 *     is `null` and we report `diskUsageBytes: null` WITHOUT recording an
 *     error — absence is the configured state, not a failure.
 *
 *   - Graphman has no list-all method (see `src/clients/graphman.ts`), so we
 *     derive "paused deployments" by iterating the graph-node deployment list
 *     and calling `getDeploymentInfo(id)` per hash. Per-hash failures are
 *     swallowed and counted as "not paused" — surfacing 100 individual error
 *     entries would make the overview useless. Aggregate graphman failure
 *     (e.g., graphman API down entirely) is surfaced via `partialErrors`.
 *
 * All on-chain BigInt values are serialized as decimal strings. The aggregated
 * "totalAllocated" is summed from active allocations rather than read from
 * `Indexer.allocatedTokens` so the active-only view stays consistent with the
 * `allocations.active` count.
 *
 * Stage 4 will add caching with a TTL. For now every read fans out fresh.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { registerIndexerResource, type ToolExtra } from '../server/register.js';
import type { Config } from '../config.js';
import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { PostgresClient } from '../clients/postgres.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { SubgraphIndexingStatus } from '../types/graphnode.js';
import { sanitizeEndpoint } from '../utils/graphql-client.js';

export interface OverviewResourceDeps {
  config: Config;
  networkClient: NetworkSubgraphClient;
  graphNodeClient: GraphNodeClient;
  postgresClient: PostgresClient | null;
  graphmanClient: GraphmanClient;
}

const URI = 'indexer://overview';

interface AllocationsSummary {
  active: number;
  totalGrt: string;
}

interface DeploymentsSummary {
  total: number;
  healthy: number;
  syncing: number;
  failed: number;
  paused: number;
}

interface OverviewPayload {
  indexerAddress: string;
  stake: string | null;
  allocations: AllocationsSummary | null;
  deployments: DeploymentsSummary | null;
  diskUsageBytes: string | null;
  partialErrors: Record<string, string>;
}

/**
 * Strip URL credentials and gateway API keys from error messages. Errors from
 * `graphql-request` often inline the full request URL; we delegate to
 * `sanitizeEndpoint` so username, password, query, hash, and the gateway
 * `/api/<key>/...` segment are all handled by the same canonical redactor used
 * for log labels. Any non-URL text is preserved verbatim.
 */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/https?:\/\/[^\s"')]+/gi, (match) => sanitizeEndpoint(match));
}

function sumBigIntStrings(values: ReadonlyArray<string>): string {
  let total = 0n;
  for (const v of values) {
    try {
      total += BigInt(v);
    } catch {
      // Skip anything that isn't a clean decimal integer rather than blowing
      // up the whole overview. Bad values are rare but possible if the
      // network subgraph schema drifts.
    }
  }
  return total.toString();
}

function classifyDeployments(statuses: ReadonlyArray<SubgraphIndexingStatus>): {
  total: number;
  healthy: number;
  syncing: number;
  failed: number;
} {
  let healthy = 0;
  let syncing = 0;
  let failed = 0;
  for (const s of statuses) {
    if (s.health === 'failed') {
      failed++;
    } else if (s.health === 'healthy') {
      // "syncing" means healthy-but-not-yet-synced; once `synced` is true the
      // deployment is fully caught up. This is the same distinction the
      // `get_indexing_statuses` tool relies on.
      if (s.synced) healthy++;
      else syncing++;
    } else {
      // 'unhealthy' (non-fatal errors only) — count alongside syncing rather
      // than failed, since the deployment can still recover without operator
      // action.
      syncing++;
    }
  }
  return { total: statuses.length, healthy, syncing, failed };
}

interface NetworkSummary {
  stake: string;
  allocations: AllocationsSummary;
}

async function fetchNetworkSummary(
  client: NetworkSubgraphClient,
  indexerAddress: string,
  signal: AbortSignal,
): Promise<NetworkSummary> {
  signal.throwIfAborted();
  const indexer = await client.getIndexer(indexerAddress);
  signal.throwIfAborted();
  const allocations = await client.getActiveAllocations(indexerAddress);

  return {
    stake: indexer?.stakedTokens ?? '0',
    allocations: {
      active: allocations.items.length,
      totalGrt: sumBigIntStrings(allocations.items.map((a) => a.allocatedTokens)),
    },
  };
}

async function fetchDeploymentsSummary(
  graphNodeClient: GraphNodeClient,
  graphmanClient: GraphmanClient,
  signal: AbortSignal,
  partialErrors: Record<string, string>,
): Promise<DeploymentsSummary> {
  signal.throwIfAborted();
  const statuses = await graphNodeClient.getIndexingStatuses();
  const classified = classifyDeployments(statuses);

  // Probe graphman per-deployment for paused state. We deliberately swallow
  // per-call failures here: a graphman call that 404s on an unknown deployment
  // would otherwise flood `partialErrors` with N entries. If EVERY probe
  // fails (e.g., graphman is unreachable), record a single aggregate error.
  let paused = 0;
  let probedAtLeastOnce = false;
  let allFailed = true;
  let lastErr: unknown = null;
  for (const status of statuses) {
    signal.throwIfAborted();
    probedAtLeastOnce = true;
    try {
      const info = await graphmanClient.getDeploymentInfo(status.subgraph);
      if (info.paused) paused++;
      allFailed = false;
    } catch (err) {
      lastErr = err;
    }
  }
  if (probedAtLeastOnce && allFailed && lastErr !== null) {
    partialErrors['graphman'] = sanitizeError(lastErr);
  }

  return { ...classified, paused };
}

async function fetchDiskUsage(
  postgresClient: PostgresClient,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const sizes = await postgresClient.getAllSubgraphSizes();
  return sumBigIntStrings(sizes.map((s) => s.sizeBytes));
}

export async function buildOverview(
  deps: OverviewResourceDeps,
  signal: AbortSignal,
): Promise<OverviewPayload> {
  const partialErrors: Record<string, string> = {};

  // Kick off every source in parallel. `Promise.allSettled` lets failures stay
  // contained — we inspect each result individually so partial successes are
  // preserved end-to-end.
  const [networkResult, deploymentsResult, diskResult] = await Promise.allSettled([
    fetchNetworkSummary(deps.networkClient, deps.config.indexerAddress, signal),
    fetchDeploymentsSummary(
      deps.graphNodeClient,
      deps.graphmanClient,
      signal,
      partialErrors,
    ),
    deps.postgresClient
      ? fetchDiskUsage(deps.postgresClient, signal)
      : Promise.resolve<string | null>(null),
  ]);

  let stake: string | null = null;
  let allocations: AllocationsSummary | null = null;
  if (networkResult.status === 'fulfilled') {
    stake = networkResult.value.stake;
    allocations = networkResult.value.allocations;
  } else {
    partialErrors['networkSubgraph'] = sanitizeError(networkResult.reason);
  }

  let deployments: DeploymentsSummary | null = null;
  if (deploymentsResult.status === 'fulfilled') {
    deployments = deploymentsResult.value;
  } else {
    partialErrors['graphNode'] = sanitizeError(deploymentsResult.reason);
  }

  let diskUsageBytes: string | null = null;
  if (diskResult.status === 'fulfilled') {
    diskUsageBytes = diskResult.value;
  } else {
    partialErrors['postgres'] = sanitizeError(diskResult.reason);
  }

  return {
    indexerAddress: deps.config.indexerAddress,
    stake,
    allocations,
    deployments,
    diskUsageBytes,
    partialErrors,
  };
}

export function registerOverviewResource(
  server: McpServer,
  deps: OverviewResourceDeps,
): void {
  registerIndexerResource(server, {
    name: 'indexer-overview',
    uri: URI,
    description:
      'Live aggregated infrastructure summary: stake, active allocation count ' +
      'and total GRT allocated, deployment health counts (healthy/syncing/' +
      'failed/paused), and total Postgres disk usage. Best-effort — sources ' +
      'that fail are reported under `partialErrors` while the others continue.',
    mimeType: 'application/json',
    handler: async (
      uri: URL,
      extra: ToolExtra,
    ): Promise<ReadResourceResult> => {
      const payload = await buildOverview(deps, extra.signal);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  });
}
