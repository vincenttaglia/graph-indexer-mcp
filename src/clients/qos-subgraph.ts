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

/**
 * Page size and cap used when walking the QoS subgraph. The subgraph emits
 * one bucket per 5 minutes per (indexer, deployment), so a 1-week window for
 * all deployments can easily exceed a single page. `PAGE_SIZE * MAX_PAGES`
 * sets the upper bound on raw bucket rows we'll fetch before flagging the
 * result `truncated: true`.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

const QUERY_VOLUME_QUERY = /* GraphQL */ `
  query QueryVolume(
    $windowStart: Int!
    $deploymentId: String
    $first: Int!
    $skip: Int!
  ) {
    queryDataPoints(
      first: $first
      skip: $skip
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
  query QueryVolumeAll($windowStart: Int!, $first: Int!, $skip: Int!) {
    queryDataPoints(
      first: $first
      skip: $skip
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
    $first: Int!
    $skip: Int!
  ) {
    indexerDataPoints(
      first: $first
      skip: $skip
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
  query IndexerQoSAll(
    $windowStart: Int!
    $indexer: String!
    $first: Int!
    $skip: Int!
  ) {
    indexerDataPoints(
      first: $first
      skip: $skip
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

  /**
   * Resolve a TimeRange into a `[windowStart, windowEnd]` pair of unix
   * seconds plus the original `windowSeconds`. `windowStart` is floored so
   * fractional inputs like `{ hours: 1.5 }` produce an `Int!`-compatible
   * value that GraphQL won't reject at validation time.
   */
  function windowBounds(timeRange: TimeRange): {
    windowSeconds: number;
    windowStart: number;
    windowEnd: number;
  } {
    const windowSeconds = timeRangeToWindowSeconds(timeRange);
    const windowEnd = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(windowEnd - windowSeconds);
    return { windowSeconds, windowStart, windowEnd };
  }

  /**
   * Page through a list-returning subgraph query until either the page is
   * short (no more rows) or we hit {@link MAX_PAGES}. Returns the flattened
   * rows plus a `truncated` flag so callers can surface incomplete data.
   */
  async function paginate<TRow>(
    query: string,
    baseVars: Record<string, unknown>,
    rowsKey: string,
  ): Promise<{ rows: TRow[]; truncated: boolean }> {
    const rows: TRow[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await gql.request<Record<string, TRow[]>>(query, {
        ...baseVars,
        first: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      });
      const batch = data[rowsKey] ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return { rows, truncated: false };
      }
    }
    // Reached MAX_PAGES with a full final page — assume more data exists.
    truncated = true;
    return { rows, truncated };
  }

  return {
    async getQueryVolume({ deploymentId, timeRange }) {
      const { windowSeconds, windowStart, windowEnd } = windowBounds(timeRange);
      const { rows: raw, truncated } =
        deploymentId !== undefined
          ? await paginate<RawQueryPoint>(
              QUERY_VOLUME_QUERY,
              { windowStart, deploymentId },
              'queryDataPoints',
            )
          : await paginate<RawQueryPoint>(
              QUERY_VOLUME_QUERY_ALL,
              { windowStart },
              'queryDataPoints',
            );

      const windowStartIso = new Date(windowStart * 1000).toISOString();
      const windowEndIso = new Date(windowEnd * 1000).toISOString();

      // Aggregate per-deployment across the 5-minute buckets in the window.
      interface Agg {
        query_count: number;
        success_count: number;
        failure_count: number;
        hasSuccess: boolean;
        hasFailure: boolean;
      }
      const byDeployment = new Map<string, Agg>();
      for (const p of raw) {
        const key = p.subgraphDeployment;
        let agg = byDeployment.get(key);
        if (!agg) {
          agg = {
            query_count: 0,
            success_count: 0,
            failure_count: 0,
            hasSuccess: false,
            hasFailure: false,
          };
          byDeployment.set(key, agg);
        }
        agg.query_count += numOrZero(p.queryCount);
        const s = num(p.successCount);
        if (s !== undefined) {
          agg.success_count += s;
          agg.hasSuccess = true;
        }
        const f = num(p.failureCount);
        if (f !== undefined) {
          agg.failure_count += f;
          agg.hasFailure = true;
        }
      }

      return Array.from(byDeployment.entries()).map(([deployment, agg]) => ({
        deployment_id: deployment,
        query_count: agg.query_count,
        success_count: agg.hasSuccess ? agg.success_count : undefined,
        failure_count: agg.hasFailure ? agg.failure_count : undefined,
        window_start: windowStartIso,
        window_end: windowEndIso,
        window_seconds: windowSeconds,
        ...(truncated ? { truncated: true } : {}),
      }));
    },

    async getIndexerQoS({ indexerAddress, deploymentId, timeRange }) {
      const { windowSeconds, windowStart } = windowBounds(timeRange);
      const indexer = indexerAddress.toLowerCase();
      const { rows: raw, truncated } =
        deploymentId !== undefined
          ? await paginate<RawIndexerPoint>(
              INDEXER_QOS_QUERY,
              { windowStart, indexer, deploymentId },
              'indexerDataPoints',
            )
          : await paginate<RawIndexerPoint>(
              INDEXER_QOS_QUERY_ALL,
              { windowStart, indexer },
              'indexerDataPoints',
            );

      // Aggregate per (indexer, deployment) across 5-minute buckets.
      //
      // Latency / blocks-behind are averaged across buckets, weighted by
      // per-bucket queryCount when available (so a low-traffic bucket can't
      // dominate the mean). When no bucket reports queryCount, fall back to
      // a simple unweighted mean.
      //
      // For success_rate we prefer aggregating raw counts (sum/sum) but the
      // current indexerDataPoints query doesn't request success/failure
      // counts — so success_rate is a weighted mean of per-bucket
      // successRate. Once the live schema is verified we can switch to true
      // count aggregation.
      interface Agg {
        indexer_address: string;
        deployment_id: string;
        weightedLatencySum: number;
        weightedP95Sum: number;
        weightedSuccessSum: number;
        weightedBlocksSum: number;
        weightSum: number;
        // Unweighted fallbacks
        latencySum: number;
        latencyCount: number;
        p95Sum: number;
        p95Count: number;
        successSum: number;
        successCount: number;
        blocksSum: number;
        blocksCount: number;
        queryCountSum: number;
        hasQueryCount: boolean;
      }
      const byKey = new Map<string, Agg>();
      for (const p of raw) {
        const key = `${p.indexer}|${p.subgraphDeployment}`;
        let agg = byKey.get(key);
        if (!agg) {
          agg = {
            indexer_address: p.indexer,
            deployment_id: p.subgraphDeployment,
            weightedLatencySum: 0,
            weightedP95Sum: 0,
            weightedSuccessSum: 0,
            weightedBlocksSum: 0,
            weightSum: 0,
            latencySum: 0,
            latencyCount: 0,
            p95Sum: 0,
            p95Count: 0,
            successSum: 0,
            successCount: 0,
            blocksSum: 0,
            blocksCount: 0,
            queryCountSum: 0,
            hasQueryCount: false,
          };
          byKey.set(key, agg);
        }
        const qc = num(p.queryCount);
        const weight = qc ?? 0;
        if (qc !== undefined) {
          agg.queryCountSum += qc;
          agg.hasQueryCount = true;
        }
        agg.weightSum += weight;

        const lat = num(p.avgLatencyMs);
        if (lat !== undefined) {
          agg.latencySum += lat;
          agg.latencyCount += 1;
          agg.weightedLatencySum += lat * weight;
        }
        const p95 = num(p.p95LatencyMs);
        if (p95 !== undefined) {
          agg.p95Sum += p95;
          agg.p95Count += 1;
          agg.weightedP95Sum += p95 * weight;
        }
        const sr = num(p.successRate);
        if (sr !== undefined) {
          agg.successSum += sr;
          agg.successCount += 1;
          agg.weightedSuccessSum += sr * weight;
        }
        const bb = num(p.avgBlocksBehind);
        if (bb !== undefined) {
          agg.blocksSum += bb;
          agg.blocksCount += 1;
          agg.weightedBlocksSum += bb * weight;
        }
      }

      return Array.from(byKey.values()).map((agg) => {
        const useWeighted = agg.weightSum > 0;
        const weightedOrMean = (
          weightedSum: number,
          sum: number,
          count: number,
        ): number | undefined => {
          if (useWeighted) return weightedSum / agg.weightSum;
          if (count === 0) return undefined;
          return sum / count;
        };
        return {
          indexer_address: agg.indexer_address,
          deployment_id: agg.deployment_id,
          avg_latency_ms: weightedOrMean(
            agg.weightedLatencySum,
            agg.latencySum,
            agg.latencyCount,
          ),
          p95_latency_ms: weightedOrMean(
            agg.weightedP95Sum,
            agg.p95Sum,
            agg.p95Count,
          ),
          success_rate: weightedOrMean(
            agg.weightedSuccessSum,
            agg.successSum,
            agg.successCount,
          ),
          avg_blocks_behind: weightedOrMean(
            agg.weightedBlocksSum,
            agg.blocksSum,
            agg.blocksCount,
          ),
          query_count: agg.hasQueryCount ? agg.queryCountSum : undefined,
          window_seconds: windowSeconds,
          ...(truncated ? { truncated: true } : {}),
        };
      });
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
