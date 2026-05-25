/**
 * Types for the QoS (Quality of Service) Oracle subgraph.
 *
 * The QoS Oracle aggregates per-query performance data emitted by gateways
 * into DAILY buckets and posts them on-chain. The live schema (verified
 * against Dtr9rETvwokot4BSXaD5tECanXfqfJKcvHuaaEgPDD2D on Gnosis) exposes
 * three core data-point entity types — all keyed by `dayNumber` (integer
 * day index) and storing metrics in snake_case BigDecimal fields:
 *
 *   - IndexerDailyDataPoint   — per indexer, per day
 *   - AllocationDailyDataPoint — per (indexer × deployment), per day
 *   - QueryDailyDataPoint     — per deployment, per day
 *
 * We re-expose three coarse-grained views:
 *
 *   - query volume rows (counts per deployment over a window)
 *   - indexer QoS rows (latency / success / blocks-behind for one indexer)
 *   - top-by-volume deployment rows (ranked by query count)
 *
 * Numeric fields the subgraph returns as BigDecimal/BigInt strings are
 * surfaced as plain `string` here so callers can do BigInt math without
 * losing precision past Number.MAX_SAFE_INTEGER (~9.0e15) — important
 * because 30-day query counts on top deployments already exceed that.
 */

/**
 * Flexible time window accepted by every QoS tool.
 *
 *   - `{ hours: N }`  — last N hours (operator-friendly). Rounded UP to a
 *                       whole day internally, since the on-chain bucketing
 *                       is daily and anything smaller would return zero.
 *   - `{ days: N }`   — last N days  (operator-friendly).
 *   - `{ epochs: N }` — last N epochs (aligns with on-chain bucketing).
 *
 * For `epochs`, the caller may pass `seconds_per_epoch` if it already knows
 * the chain's epoch length. If omitted, the QoS client falls back to a
 * sentinel (86400s) and writes a stderr warning. Stage 3 wiring will source
 * the real value from the Network Subgraph (A1).
 */
export type TimeRange =
  | { hours: number }
  | { days: number }
  | { epochs: number; seconds_per_epoch?: number };

/**
 * One row of query-volume data per deployment.
 *
 * `query_count` is the sum of `QueryDailyDataPoint.query_count` over the
 * window — returned as a BigInt-safe string so 30-day totals don't lose
 * precision (top deployments emit billions of queries per month).
 */
export interface QueryVolumeRow {
  /** Deployment IPFS hash (Qm...). */
  deployment_id: string;
  /**
   * Total queries served in the window — sum across all daily buckets,
   * BigInt-as-string. Use `BigInt(row.query_count)` to consume losslessly.
   */
  query_count: string;
  /** Chain id of the deployment if the subgraph reported it; `null` otherwise. */
  chain_id: string | null;
  /** ISO-8601 timestamp at the start of the resolved window. */
  window_start?: string;
  /** ISO-8601 timestamp at the end of the resolved window. */
  window_end?: string;
  /** Length of the resolved window, in seconds. */
  window_seconds: number;
  /** True if pagination hit the cap and the result is incomplete. */
  truncated?: boolean;
}

/**
 * QoS metrics for a specific indexer.
 *
 * When `deployment_id` is omitted in the request, returns one aggregated
 * row over `IndexerDailyDataPoint` (all the indexer's traffic, network-
 * wide). When provided, returns one row per matching
 * `AllocationDailyDataPoint` aggregate (i.e. one row total for that
 * (indexer, deployment) pair).
 *
 * Aggregation is a weighted average over `dataPointCount` so high-traffic
 * days dominate — gives a more representative view than a flat day-mean
 * when traffic spikes.
 *
 * Latency / success-rate / blocks-behind are returned as BigDecimal-as-
 * string. `query_count` and `data_point_count` are BigInt-as-string.
 */
export interface IndexerQoSRow {
  /** Lowercased 0x-prefixed indexer address. */
  indexer_address: string;
  /** Deployment IPFS hash (Qm...). `null` for the network-wide row. */
  deployment_id: string | null;
  /**
   * Weighted-by-`dataPointCount` average end-to-end indexer-side latency
   * in milliseconds, BigDecimal-as-string. `null` when no day in the
   * window had observations.
   */
  avg_latency_ms: string | null;
  /**
   * Fraction of successful queries in [0, 1] — weighted average of
   * `proportion_indexer_200_responses` over `dataPointCount`. BigDecimal-
   * as-string. `null` when no observations in window.
   */
  success_rate: string | null;
  /**
   * Weighted-by-`dataPointCount` average blocks behind chain head,
   * BigDecimal-as-string. `null` when no observations in window.
   */
  avg_blocks_behind: string | null;
  /** Total queries the gateway routed to this indexer in the window. BigInt-as-string. */
  query_count: string;
  /**
   * Number of underlying 5-minute data points aggregated into the daily
   * buckets — useful as a confidence proxy. BigInt-as-string.
   */
  data_point_count: string;
  /** Length of the resolved window, in seconds. */
  window_seconds: number;
  /** True if pagination hit the cap and the result is incomplete. */
  truncated?: boolean;
}

/**
 * One entry in the ranked "top deployments by query volume" list.
 * Volume is summed across all `QueryDailyDataPoint` rows in the window.
 *
 * If `truncated` is set on a row, the raw QoS scan hit its pagination cap
 * and the aggregated top-N may be missing a high-volume deployment whose
 * daily rows fell past the cap. Callers should propagate the flag to the
 * operator rather than treating the ranking as authoritative. The flag is
 * the same on every row in a given response (it describes the underlying
 * scan, not an individual deployment) — surfacing it per-row keeps the
 * shape array-flat for downstream consumers that map over rows.
 */
export interface DeploymentVolumeRow {
  deployment_id: string;
  /** Sum of `query_count` over the window. BigInt-as-string. */
  query_count: string;
  /** Chain id of the deployment if reported; `null` otherwise. */
  chain_id: string | null;
  /** Rank in the returned list, 1-indexed. */
  rank: number;
  /** Length of the resolved window, in seconds. */
  window_seconds: number;
  /** True if pagination hit the cap and the underlying scan is incomplete. */
  truncated?: boolean;
}
