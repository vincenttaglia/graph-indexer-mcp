/**
 * Client for the QoS (Quality of Service) Oracle subgraph.
 *
 * The live oracle (Dtr9rETvwokot4BSXaD5tECanXfqfJKcvHuaaEgPDD2D on Gnosis)
 * exposes DAILY aggregates keyed by `dayNumber` (integer day index since
 * unix epoch) with snake_case BigDecimal metric fields. We query three
 * entity types:
 *
 *   - QueryDailyDataPoint     (per deployment, per day) — query volume.
 *   - IndexerDailyDataPoint   (per indexer, per day)    — indexer-wide QoS.
 *   - AllocationDailyDataPoint (per indexer × deployment, per day) — per-
 *                                allocation QoS, used when the caller asks
 *                                for QoS scoped to one deployment.
 *
 * Aggregation rules:
 *
 *   - Query counts: sum of `query_count` across days, kept in BigInt to
 *     preserve precision past Number.MAX_SAFE_INTEGER (~9.0e15) — 30-day
 *     volumes on top deployments easily exceed that.
 *
 *   - Latency / success-rate / blocks-behind: weighted average over
 *     `dataPointCount` so a low-traffic day with one anomalous query
 *     doesn't dominate the mean. Computed in BigInt-scaled arithmetic
 *     (multiply by 1e9 before sum, divide at the end) so we don't lose
 *     decimal precision on long windows.
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

/** Seconds in a day. */
const SECONDS_PER_DAY = 86_400;

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
  if ('days' in tr) return tr.days * SECONDS_PER_DAY;
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

/**
 * Convert a TimeRange into the number of whole DAYS to look back.
 *
 * The QoS Oracle's smallest bucket is one day, so anything shorter than a
 * day rounds UP to 1 (a request for "last 6 hours" would return zero rows
 * otherwise, surprising the operator). Long windows round normally.
 */
function timeRangeToDays(tr: TimeRange): number {
  const seconds = timeRangeToWindowSeconds(tr);
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_DAY));
}

// =============================================================================
// Public interface
// =============================================================================

/**
 * Optional per-call options for client methods. `signal` is forwarded to the
 * GraphQL client so caller-initiated cancellation aborts the in-flight fetch
 * (including between pagination iterations).
 */
export interface QosSubgraphCallOpts {
  signal?: AbortSignal;
}

export interface QosSubgraphClient {
  getQueryVolume(
    opts: {
      deploymentId?: string;
      timeRange: TimeRange;
    },
    callOpts?: QosSubgraphCallOpts,
  ): Promise<QueryVolumeRow[]>;

  getIndexerQoS(
    opts: {
      indexerAddress: string;
      deploymentId?: string;
      timeRange: TimeRange;
    },
    callOpts?: QosSubgraphCallOpts,
  ): Promise<IndexerQoSRow[]>;

  getTopQueriedDeployments(
    opts: {
      limit: number;
      timeRange: TimeRange;
    },
    callOpts?: QosSubgraphCallOpts,
  ): Promise<DeploymentVolumeRow[]>;
}

export interface CreateQosSubgraphClientOptions {
  endpoint: string;
}

// =============================================================================
// GraphQL queries
//
// Verified live against the QoS Oracle on Gnosis. Field names use the
// snake_case + dayNumber-keyed schema. Each query takes a `$earliestDay`
// integer threshold computed by the client.
// =============================================================================

/**
 * Page size and per-mode caps for daily data-point pagination.
 *
 * We use TWO different pagination strategies, chosen by row-count expectations:
 *
 *   - SCOPED queries (per indexer × deployment, or per deployment) return at
 *     most ~365 rows for a 1-year window — one row per day. Skip-based
 *     pagination is fine; we cap at 5,000 rows (5 pages) and that's plenty.
 *
 *   - BROAD queries (all deployments × N days) can return tens of thousands
 *     of rows. The Graph's hosted gateway hard-caps `skip` at 5,000, so
 *     skip-based pagination can't fetch beyond that — `truncated:true` would
 *     be silently mis-aggregated as "top-N from a sample". Use CURSOR
 *     pagination (`id_gt: $lastId`, `orderBy: id`) which has no depth limit,
 *     and cap at {@link MAX_BROAD_ROWS} as a safety net (still surfacing
 *     `truncated:true` if that cap is hit).
 */
const PAGE_SIZE = 1000;
/** Skip-paginated cap for scoped queries (per-deployment / per-indexer). */
const MAX_SCOPED_PAGES = 5;
/** Cursor-paginated cap for broad queries (network-wide query volume). */
const MAX_BROAD_ROWS = 50_000;
const MAX_BROAD_PAGES = Math.ceil(MAX_BROAD_ROWS / PAGE_SIZE);

const QUERY_VOLUME_BY_DEPLOYMENT = /* GraphQL */ `
  query QueryVolumeByDeployment(
    $earliestDay: Int!
    $deploymentId: String!
    $first: Int!
    $skip: Int!
  ) {
    queryDailyDataPoints(
      first: $first
      skip: $skip
      orderBy: dayNumber
      orderDirection: desc
      where: { subgraphDeployment: $deploymentId, dayNumber_gte: $earliestDay }
    ) {
      id
      query_count
      subgraphDeployment {
        id
      }
      chain_id
    }
  }
`;

/**
 * Network-wide query-volume scan. Uses CURSOR pagination via `id_gt: $lastId`
 * with `orderBy: id` so we can page past the Graph gateway's 5,000-row `skip`
 * cap. The shape of the result is identical to the scoped variant — callers
 * aggregate by `subgraphDeployment.id` regardless.
 */
const QUERY_VOLUME_ALL = /* GraphQL */ `
  query QueryVolumeAll($earliestDay: Int!, $first: Int!, $lastId: String!) {
    queryDailyDataPoints(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { dayNumber_gte: $earliestDay, id_gt: $lastId }
    ) {
      id
      query_count
      subgraphDeployment {
        id
      }
      chain_id
    }
  }
`;

const ALLOCATION_QOS_QUERY = /* GraphQL */ `
  query AllocationQoS(
    $earliestDay: Int!
    $indexer: String!
    $deploymentId: String!
    $first: Int!
    $skip: Int!
  ) {
    allocationDailyDataPoints(
      first: $first
      skip: $skip
      orderBy: dayNumber
      orderDirection: desc
      where: {
        indexer: $indexer
        subgraphDeployment: $deploymentId
        dayNumber_gte: $earliestDay
      }
    ) {
      id
      dataPointCount
      avg_indexer_latency_ms
      proportion_indexer_200_responses
      avg_indexer_blocks_behind
      query_count
    }
  }
`;

const INDEXER_QOS_QUERY = /* GraphQL */ `
  query IndexerQoS(
    $earliestDay: Int!
    $indexer: String!
    $first: Int!
    $skip: Int!
  ) {
    indexerDailyDataPoints(
      first: $first
      skip: $skip
      orderBy: dayNumber
      orderDirection: desc
      where: { indexer: $indexer, dayNumber_gte: $earliestDay }
    ) {
      id
      dataPointCount
      avg_indexer_latency_ms
      proportion_indexer_200_responses
      avg_indexer_blocks_behind
      query_count
    }
  }
`;

// =============================================================================
// Raw response shapes (what the subgraph returns before we normalize)
// =============================================================================

interface RawQueryVolumePoint {
  id: string;
  query_count: string;
  subgraphDeployment: { id: string } | null;
  chain_id: string | null;
}

interface RawIndexerOrAllocationPoint {
  id: string;
  dataPointCount: string;
  avg_indexer_latency_ms: string | null;
  proportion_indexer_200_responses: string | null;
  avg_indexer_blocks_behind: string | null;
  query_count: string;
}

// =============================================================================
// BigInt helpers
//
// Metric values arrive as BigDecimal strings like "595.6016109280203...". We
// scale them to integer-space (multiply by 1e9, truncate) before summing so
// the weighted average preserves ~9 decimal places of precision. The final
// divide-and-format step renders the result back as a BigDecimal-as-string.
// =============================================================================

/** Decimal places preserved during weighted-average accumulation. */
const SCALE_DECIMALS = 9;
const SCALE_BI = 10n ** BigInt(SCALE_DECIMALS);

/**
 * Parse a BigInt-shaped string ("123" or "123.456") into a BigInt by
 * truncating any decimal part. Returns 0n on invalid input.
 */
function parseBigInt(s: string | null | undefined): bigint {
  if (s === null || s === undefined) return 0n;
  try {
    const trimmed = s.split('.')[0] ?? '0';
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

/**
 * Parse a BigDecimal string ("595.6016109...") into BigInt scaled by
 * {@link SCALE_BI}. The fractional part is truncated to {@link SCALE_DECIMALS}
 * digits. Returns 0n on invalid input. Negative values return 0n (every
 * QoS metric is non-negative).
 */
function parseBigDecimalScaled(s: string | null | undefined): bigint {
  if (s === null || s === undefined) return 0n;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed.startsWith('-')) return 0n;
  const [intPart = '0', fracPartRaw = ''] = trimmed.split('.');
  const fracPart = fracPartRaw
    .slice(0, SCALE_DECIMALS)
    .padEnd(SCALE_DECIMALS, '0');
  try {
    return BigInt(intPart) * SCALE_BI + BigInt(fracPart || '0');
  } catch {
    return 0n;
  }
}

/**
 * Format a scaled BigInt back to a BigDecimal string with up to
 * {@link SCALE_DECIMALS} fractional digits (trailing zeros trimmed).
 */
function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / SCALE_BI;
  const fracPart = abs % SCALE_BI;
  if (fracPart === 0n) return `${negative ? '-' : ''}${intPart.toString()}`;
  const fracStr = fracPart.toString().padStart(SCALE_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracStr}`;
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
   * Resolve a TimeRange into the `dayNumber` threshold (inclusive) used by
   * every query, plus the original `windowSeconds` for callers to compute
   * rates.
   *
   * `currentDay` is `floor(now / 86400)` — the standard unix-day index.
   * `earliestDay = currentDay - days + 1` so a request for `{ days: 1 }`
   * returns today only, and `{ days: 7 }` returns today + 6 prior days.
   */
  function windowBounds(timeRange: TimeRange): {
    windowSeconds: number;
    windowStart: number;
    windowEnd: number;
    earliestDay: number;
  } {
    const windowSeconds = timeRangeToWindowSeconds(timeRange);
    const days = timeRangeToDays(timeRange);
    const windowEnd = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(windowEnd - windowSeconds);
    const currentDay = Math.floor(Date.now() / (SECONDS_PER_DAY * 1000));
    const earliestDay = currentDay - days + 1;
    return { windowSeconds, windowStart, windowEnd, earliestDay };
  }

  /**
   * Skip-paginated fetch for SCOPED queries (per indexer × deployment, per
   * deployment). Daily granularity bounds the row count to ~365/year, so the
   * Graph gateway's 5,000-row `skip` cap is comfortably above the natural
   * ceiling. Caps at {@link MAX_SCOPED_PAGES} pages.
   *
   * Returns the flattened rows plus a `truncated` flag so callers can surface
   * incomplete data. The optional `signal` is forwarded to every page request
   * AND checked between pages so an abort observed after one page doesn't
   * trigger the next request.
   */
  async function paginate<TRow>(
    query: string,
    baseVars: Record<string, unknown>,
    rowsKey: string,
    signal?: AbortSignal,
  ): Promise<{ rows: TRow[]; truncated: boolean }> {
    const rows: TRow[] = [];
    const reqOpts = signal ? { signal } : undefined;
    for (let page = 0; page < MAX_SCOPED_PAGES; page++) {
      signal?.throwIfAborted();
      const data = await gql.request<Record<string, TRow[]>>(
        query,
        {
          ...baseVars,
          first: PAGE_SIZE,
          skip: page * PAGE_SIZE,
        },
        reqOpts,
      );
      const batch = data[rowsKey] ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return { rows, truncated: false };
      }
    }
    // Reached MAX_SCOPED_PAGES with a full final page — assume more data exists.
    return { rows, truncated: true };
  }

  /**
   * Cursor-paginated fetch for BROAD queries (network-wide query volume).
   *
   * The Graph gateway caps `skip` at 5,000 rows, so skip-pagination on a
   * busy 30-day window across thousands of deployments silently drops rows
   * and downstream aggregates become "top-N from a sample" instead of a
   * true top-N. Cursor-pagination (`id_gt: $lastId`, `orderBy: id asc`) has
   * no depth limit, but we still cap total rows at {@link MAX_BROAD_ROWS}
   * as a safety net; if the cap is hit we surface `truncated: true` AND
   * emit a stderr warning at the client boundary so operators see the
   * pagination ceiling rather than discovering it via wrong rankings.
   *
   * `TRow` must have a string `id` field (the per-entity primary key,
   * unique within the entity type) — every QoS Oracle entity exposes one.
   */
  async function paginateByCursor<TRow extends { id: string }>(
    query: string,
    baseVars: Record<string, unknown>,
    rowsKey: string,
    signal?: AbortSignal,
  ): Promise<{ rows: TRow[]; truncated: boolean }> {
    const rows: TRow[] = [];
    const reqOpts = signal ? { signal } : undefined;
    let lastId = '';
    for (let page = 0; page < MAX_BROAD_PAGES; page++) {
      signal?.throwIfAborted();
      const data = await gql.request<Record<string, TRow[]>>(
        query,
        {
          ...baseVars,
          first: PAGE_SIZE,
          lastId,
        },
        reqOpts,
      );
      const batch = data[rowsKey] ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return { rows, truncated: false };
      }
      // Advance the cursor. The last row's id is the largest in the batch
      // (orderBy: id asc), so `id_gt: lastId` on the next page picks up
      // exactly where this one stopped — no gaps, no duplicates.
      const tail = batch[batch.length - 1];
      if (!tail || tail.id === lastId) {
        // Defensive: if the gateway returns a non-advancing cursor we'd
        // infinite-loop. Stop here and surface as truncated.
        process.stderr.write(
          `[qos-subgraph] warn: cursor pagination stalled at id=${lastId} ` +
            `after ${rows.length} rows — surfacing as truncated.\n`,
        );
        return { rows, truncated: true };
      }
      lastId = tail.id;
    }
    // Reached MAX_BROAD_ROWS with a full final page — more data exists.
    process.stderr.write(
      `[qos-subgraph] warn: broad query hit MAX_BROAD_ROWS=${MAX_BROAD_ROWS} ` +
        `(query="${rowsKey}"); result is incomplete — surfacing truncated:true. ` +
        `Aggregations (e.g. top-N rankings) may be missing high-volume rows.\n`,
    );
    return { rows, truncated: true };
  }

  /**
   * Aggregate QueryDailyDataPoint rows by deployment, summing `query_count`
   * via BigInt and picking the most-recent `chain_id` per deployment.
   */
  function aggregateQueryVolume(
    raw: RawQueryVolumePoint[],
  ): Map<string, { queryCount: bigint; chainId: string | null }> {
    const byDeployment = new Map<
      string,
      { queryCount: bigint; chainId: string | null }
    >();
    for (const p of raw) {
      const depId = p.subgraphDeployment?.id;
      if (!depId) continue;
      let agg = byDeployment.get(depId);
      if (!agg) {
        agg = { queryCount: 0n, chainId: p.chain_id };
        byDeployment.set(depId, agg);
      }
      agg.queryCount += parseBigInt(p.query_count);
      // Prefer the first-seen non-null chain id; the order is by dayNumber
      // desc, so this picks the most recent reported chain.
      if (agg.chainId === null && p.chain_id !== null) {
        agg.chainId = p.chain_id;
      }
    }
    return byDeployment;
  }

  /**
   * Compute the indexer-QoS aggregate from a set of daily data points.
   * Weighted averages are computed in scaled BigInt space to avoid float
   * drift across many days.
   */
  function aggregateIndexerQoS(
    raw: RawIndexerOrAllocationPoint[],
  ): {
    avg_latency_ms: string | null;
    success_rate: string | null;
    avg_blocks_behind: string | null;
    query_count: string;
    data_point_count: string;
  } {
    let weightSum = 0n;
    let weightedLatencyNum = 0n;
    let weightedSuccessNum = 0n;
    let weightedBlocksNum = 0n;
    let hasLatency = false;
    let hasSuccess = false;
    let hasBlocks = false;
    let queryCountSum = 0n;

    for (const p of raw) {
      const dpc = parseBigInt(p.dataPointCount);
      const qc = parseBigInt(p.query_count);
      queryCountSum += qc;

      // Skip rows that don't contribute a weight — they'd otherwise be
      // silently dropped from the weighted mean but still affect counts.
      if (dpc <= 0n) continue;
      weightSum += dpc;

      if (p.avg_indexer_latency_ms !== null) {
        weightedLatencyNum += parseBigDecimalScaled(p.avg_indexer_latency_ms) * dpc;
        hasLatency = true;
      }
      if (p.proportion_indexer_200_responses !== null) {
        weightedSuccessNum +=
          parseBigDecimalScaled(p.proportion_indexer_200_responses) * dpc;
        hasSuccess = true;
      }
      if (p.avg_indexer_blocks_behind !== null) {
        weightedBlocksNum +=
          parseBigDecimalScaled(p.avg_indexer_blocks_behind) * dpc;
        hasBlocks = true;
      }
    }

    const dataPointCountSum = weightSum;
    const divide = (num: bigint): string => formatScaled(num / weightSum);

    return {
      avg_latency_ms: hasLatency && weightSum > 0n ? divide(weightedLatencyNum) : null,
      success_rate: hasSuccess && weightSum > 0n ? divide(weightedSuccessNum) : null,
      avg_blocks_behind: hasBlocks && weightSum > 0n ? divide(weightedBlocksNum) : null,
      query_count: queryCountSum.toString(),
      data_point_count: dataPointCountSum.toString(),
    };
  }

  return {
    async getQueryVolume({ deploymentId, timeRange }, callOpts) {
      const { windowSeconds, windowStart, windowEnd, earliestDay } =
        windowBounds(timeRange);
      // Scoped (single-deployment) path is bounded to days-per-window rows,
      // so skip-pagination is fine. Broad (no deploymentId) path can blow
      // past the gateway's skip cap — use cursor pagination so we don't
      // silently drop deployments from the network-wide volume scan.
      const { rows: raw, truncated } =
        deploymentId !== undefined
          ? await paginate<RawQueryVolumePoint>(
              QUERY_VOLUME_BY_DEPLOYMENT,
              { earliestDay, deploymentId },
              'queryDailyDataPoints',
              callOpts?.signal,
            )
          : await paginateByCursor<RawQueryVolumePoint>(
              QUERY_VOLUME_ALL,
              { earliestDay },
              'queryDailyDataPoints',
              callOpts?.signal,
            );

      const windowStartIso = new Date(windowStart * 1000).toISOString();
      const windowEndIso = new Date(windowEnd * 1000).toISOString();
      const byDeployment = aggregateQueryVolume(raw);

      return Array.from(byDeployment.entries()).map(([deployment, agg]) => ({
        deployment_id: deployment,
        query_count: agg.queryCount.toString(),
        chain_id: agg.chainId,
        window_start: windowStartIso,
        window_end: windowEndIso,
        window_seconds: windowSeconds,
        ...(truncated ? { truncated: true } : {}),
      }));
    },

    async getIndexerQoS({ indexerAddress, deploymentId, timeRange }, callOpts) {
      const { windowSeconds, earliestDay } = windowBounds(timeRange);
      const indexer = indexerAddress.toLowerCase();

      // Per-deployment QoS draws from AllocationDailyDataPoint (one row per
      // (indexer, deployment, day)); network-wide QoS draws from
      // IndexerDailyDataPoint (one row per (indexer, day)). Both share the
      // same metric field names so the aggregator is shared.
      const { rows: raw, truncated } =
        deploymentId !== undefined
          ? await paginate<RawIndexerOrAllocationPoint>(
              ALLOCATION_QOS_QUERY,
              { earliestDay, indexer, deploymentId },
              'allocationDailyDataPoints',
              callOpts?.signal,
            )
          : await paginate<RawIndexerOrAllocationPoint>(
              INDEXER_QOS_QUERY,
              { earliestDay, indexer },
              'indexerDailyDataPoints',
              callOpts?.signal,
            );

      // No daily points at all — return an empty array so callers don't see
      // a synthetic zero row that would skew downstream "is this indexer
      // healthy" checks.
      if (raw.length === 0) return [];

      const agg = aggregateIndexerQoS(raw);

      return [
        {
          indexer_address: indexer,
          deployment_id: deploymentId ?? null,
          ...agg,
          window_seconds: windowSeconds,
          ...(truncated ? { truncated: true } : {}),
        },
      ];
    },

    async getTopQueriedDeployments({ limit, timeRange }, callOpts) {
      const { windowSeconds, earliestDay } = windowBounds(timeRange);
      // Network-wide scan: use cursor pagination so we don't fall foul of
      // the gateway's 5,000-row `skip` cap. A busy 30-day window across
      // thousands of deployments × 30 days easily exceeds that, and a
      // skip-truncated input would silently produce a wrong top-N (the
      // highest-volume deployment can sit anywhere in id-space, not just
      // the most-recent dayNumber slice).
      const { rows: raw, truncated } = await paginateByCursor<RawQueryVolumePoint>(
        QUERY_VOLUME_ALL,
        { earliestDay },
        'queryDailyDataPoints',
        callOpts?.signal,
      );

      const byDeployment = aggregateQueryVolume(raw);
      const ranked = Array.from(byDeployment.entries())
        .map(([deployment, agg]) => ({
          deployment_id: deployment,
          queryCount: agg.queryCount,
          chain_id: agg.chainId,
        }))
        .sort((a, b) => {
          // Sort BigInt desc — `Number(big - big)` would lose precision so
          // do it in BigInt space and convert to -1/0/1.
          if (a.queryCount < b.queryCount) return 1;
          if (a.queryCount > b.queryCount) return -1;
          return 0;
        })
        .slice(0, limit);

      // If the raw fetch was truncated, the aggregated top-N may be missing
      // a high-volume deployment whose rows happened to land past the cap.
      // Surface that explicitly so callers (DiscoveryEngine, qos-tools) can
      // warn the operator rather than treating the ranking as authoritative.
      return ranked.map((r, idx) => ({
        deployment_id: r.deployment_id,
        query_count: r.queryCount.toString(),
        chain_id: r.chain_id,
        rank: idx + 1,
        window_seconds: windowSeconds,
        ...(truncated ? { truncated: true } : {}),
      }));
    },
  };
}
