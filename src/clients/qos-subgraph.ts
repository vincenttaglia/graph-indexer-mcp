/**
 * Client for the QoS (Quality of Service) subgraph.
 *
 * Wraps the Stage 0 GraphQL client with three coarse-grained read methods:
 *   - getQueryVolume        — query counts, optionally scoped to one deployment
 *   - getIndexerQoS         — latency / success / blocks-behind for the indexer
 *   - getTopQueriedDeployments — ranked list, useful for discovery
 *
 * Each method accepts a flexible TimeRange and the client converts it to a
 * window-seconds value that gets passed to the subgraph as `windowStart =
 * now - windowSeconds`.
 *
 * NOTE on epochs: the real `seconds_per_epoch` is per-chain and lives in the
 * Network Subgraph (A1). Stage 3 will wire that in so callers can pass
 * `{ epochs: N }` without knowing the chain's epoch length. Until then,
 * `timeRangeToWindowSeconds` falls back to a sentinel and writes a stderr
 * warning so the approximation is visible in logs.
 */

import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import type {
  DeploymentVolumeRow,
  IndexerQoSRow,
  QueryVolumeRow,
  TimeRange,
} from '../types/qos.js';

// =============================================================================
// Time range helper
// =============================================================================

/** Sentinel epoch length used when the caller didn't supply one. ~24h. */
const DEFAULT_SECONDS_PER_EPOCH = 86_400;

/**
 * Convert a TimeRange into a window length in seconds.
 *
 * For `{ epochs }` without an explicit `seconds_per_epoch`, falls back to
 * {@link DEFAULT_SECONDS_PER_EPOCH} and writes a one-line stderr warning so
 * the approximation shows up in operator logs.
 *
 * Real `seconds_per_epoch` values come from the Network Subgraph (A1) and
 * will be wired by Stage 3.
 */
export function timeRangeToWindowSeconds(tr: TimeRange): number {
  if ('hours' in tr) return tr.hours * 3600;
  if ('days' in tr) return tr.days * 86_400;
  // epochs branch
  const secondsPerEpoch = tr.seconds_per_epoch;
  if (secondsPerEpoch === undefined) {
    process.stderr.write(
      `[qos-subgraph] warn: time_range.epochs used without seconds_per_epoch — ` +
        `falling back to ${DEFAULT_SECONDS_PER_EPOCH}s (~24h). ` +
        `Stage 3 will wire the real per-chain value from the Network Subgraph.\n`,
    );
    return tr.epochs * DEFAULT_SECONDS_PER_EPOCH;
  }
  return tr.epochs * secondsPerEpoch;
}

// =============================================================================
// Public interface
// =============================================================================

export interface QosSubgraphClient {
  getQueryVolume(opts: {
    deploymentId?: string;
    timeRange: TimeRange;
  }): Promise<QueryVolumeRow[]>;

  getIndexerQoS(opts: {
    indexerAddress: string;
    deploymentId?: string;
    timeRange: TimeRange;
  }): Promise<IndexerQoSRow[]>;

  getTopQueriedDeployments(opts: {
    limit: number;
    timeRange: TimeRange;
  }): Promise<DeploymentVolumeRow[]>;
}

export interface CreateQosSubgraphClientOptions {
  endpoint: string;
}

// =============================================================================
// GraphQL queries
//
// These query shapes are reasonable interpretations of a gateway-style QoS
// subgraph; field names will likely need adjustment once we have a live
// schema to probe. Each query takes a `windowStart` unix timestamp (seconds)
// computed as `now - windowSeconds`.
//
// TODO: verify against live schema
// =============================================================================

const QUERY_VOLUME_QUERY = /* GraphQL */ `
  query QueryVolume($windowStart: Int!, $deploymentId: String) {
    queryDataPoints(
      first: 1000
      orderBy: timestamp
      orderDirection: desc
      where: { timestamp_gte: $windowStart, subgraphDeployment: $deploymentId }
    ) {
      subgraphDeployment
      queryCount
      successCount
      failureCount
      timestamp
    }
  }
`;

const QUERY_VOLUME_QUERY_ALL = /* GraphQL */ `
  query QueryVolumeAll($windowStart: Int!) {
    queryDataPoints(
      first: 1000
      orderBy: timestamp
      orderDirection: desc
      where: { timestamp_gte: $windowStart }
    ) {
      subgraphDeployment
      queryCount
      successCount
      failureCount
      timestamp
    }
  }
`;

const INDEXER_QOS_QUERY = /* GraphQL */ `
  query IndexerQoS(
    $windowStart: Int!
    $indexer: String!
    $deploymentId: String
  ) {
    indexerDataPoints(
      first: 1000
      orderBy: timestamp
      orderDirection: desc
      where: {
        timestamp_gte: $windowStart
        indexer: $indexer
        subgraphDeployment: $deploymentId
      }
    ) {
      indexer
      subgraphDeployment
      avgLatencyMs
      p95LatencyMs
      successRate
      avgBlocksBehind
      queryCount
      timestamp
    }
  }
`;

const INDEXER_QOS_QUERY_ALL = /* GraphQL */ `
  query IndexerQoSAll($windowStart: Int!, $indexer: String!) {
    indexerDataPoints(
      first: 1000
      orderBy: timestamp
      orderDirection: desc
      where: { timestamp_gte: $windowStart, indexer: $indexer }
    ) {
      indexer
      subgraphDeployment
      avgLatencyMs
      p95LatencyMs
      successRate
      avgBlocksBehind
      queryCount
      timestamp
    }
  }
`;

const TOP_DEPLOYMENTS_QUERY = /* GraphQL */ `
  query TopDeployments($windowStart: Int!, $limit: Int!) {
    deploymentVolumes(
      first: $limit
      orderBy: queryCount
      orderDirection: desc
      where: { timestamp_gte: $windowStart }
    ) {
      subgraphDeployment
      queryCount
    }
  }
`;

// =============================================================================
// Raw response shapes (what the subgraph returns before we normalize)
// =============================================================================

interface RawQueryPoint {
  subgraphDeployment: string;
  queryCount: string | number;
  successCount?: string | number | null;
  failureCount?: string | number | null;
  timestamp: string | number;
}

interface RawIndexerPoint {
  indexer: string;
  subgraphDeployment: string;
  avgLatencyMs?: string | number | null;
  p95LatencyMs?: string | number | null;
  successRate?: string | number | null;
  avgBlocksBehind?: string | number | null;
  queryCount?: string | number | null;
  timestamp: string | number;
}

interface RawDeploymentVolume {
  subgraphDeployment: string;
  queryCount: string | number;
}

function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

function numOrZero(v: string | number | null | undefined): number {
  return num(v) ?? 0;
}

// =============================================================================
// Factory
// =============================================================================

export function createQosSubgraphClient(
  opts: CreateQosSubgraphClientOptions,
): QosSubgraphClient {
  const gql: TypedGraphqlClient = createGraphqlClient({
    endpoint: opts.endpoint,
    label: 'qos-subgraph',
  });

  function windowBounds(timeRange: TimeRange): {
    windowSeconds: number;
    windowStart: number;
    windowEnd: number;
  } {
    const windowSeconds = timeRangeToWindowSeconds(timeRange);
    const windowEnd = Math.floor(Date.now() / 1000);
    const windowStart = windowEnd - windowSeconds;
    return { windowSeconds, windowStart, windowEnd };
  }

  return {
    async getQueryVolume({ deploymentId, timeRange }) {
      const { windowSeconds, windowStart, windowEnd } = windowBounds(timeRange);
      const data = deploymentId
        ? await gql.request<{ queryDataPoints: RawQueryPoint[] }>(QUERY_VOLUME_QUERY, {
            windowStart,
            deploymentId,
          })
        : await gql.request<{ queryDataPoints: RawQueryPoint[] }>(QUERY_VOLUME_QUERY_ALL, {
            windowStart,
          });

      const windowStartIso = new Date(windowStart * 1000).toISOString();
      const windowEndIso = new Date(windowEnd * 1000).toISOString();
      return data.queryDataPoints.map((p) => ({
        deployment_id: p.subgraphDeployment,
        query_count: numOrZero(p.queryCount),
        success_count: num(p.successCount),
        failure_count: num(p.failureCount),
        window_start: windowStartIso,
        window_end: windowEndIso,
        window_seconds: windowSeconds,
      }));
    },

    async getIndexerQoS({ indexerAddress, deploymentId, timeRange }) {
      const { windowSeconds, windowStart } = windowBounds(timeRange);
      const indexer = indexerAddress.toLowerCase();
      const data = deploymentId
        ? await gql.request<{ indexerDataPoints: RawIndexerPoint[] }>(INDEXER_QOS_QUERY, {
            windowStart,
            indexer,
            deploymentId,
          })
        : await gql.request<{ indexerDataPoints: RawIndexerPoint[] }>(
            INDEXER_QOS_QUERY_ALL,
            { windowStart, indexer },
          );

      return data.indexerDataPoints.map((p) => ({
        indexer_address: p.indexer,
        deployment_id: p.subgraphDeployment,
        avg_latency_ms: num(p.avgLatencyMs),
        p95_latency_ms: num(p.p95LatencyMs),
        success_rate: num(p.successRate),
        avg_blocks_behind: num(p.avgBlocksBehind),
        query_count: num(p.queryCount),
        window_seconds: windowSeconds,
      }));
    },

    async getTopQueriedDeployments({ limit, timeRange }) {
      const { windowSeconds, windowStart } = windowBounds(timeRange);
      const data = await gql.request<{ deploymentVolumes: RawDeploymentVolume[] }>(
        TOP_DEPLOYMENTS_QUERY,
        { windowStart, limit },
      );
      return data.deploymentVolumes.map((d, idx) => ({
        deployment_id: d.subgraphDeployment,
        query_count: numOrZero(d.queryCount),
        rank: idx + 1,
        window_seconds: windowSeconds,
      }));
    },
  };
}
