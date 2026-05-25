/**
 * Types for the QoS (Quality of Service) subgraph.
 *
 * The QoS subgraph aggregates per-query performance data emitted by gateways
 * (latency, success rate, blocks-behind) into 5-minute buckets and posts them
 * on-chain. We re-expose three coarse-grained views:
 *
 *   - query volume rows (counts per deployment over a window)
 *   - indexer QoS rows (latency / success / blocks-behind for one indexer)
 *   - top-by-volume deployment rows (ranked by query count)
 *
 * The on-chain schema isn't fully pinned down in design docs, so the field
 * names below are reasonable interpretations of "what a gateway-style QoS
 * subgraph typically exposes." Once we have a live deployment to probe,
 * adjust field names / nesting accordingly.
 *
 * // TODO: verify against live schema
 */

/**
 * Flexible time window accepted by every QoS tool.
 *
 *   - `{ hours: N }`  — last N hours (operator-friendly)
 *   - `{ days: N }`   — last N days  (operator-friendly)
 *   - `{ epochs: N }` — last N epochs (aligns with on-chain bucketing)
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
 * One bucket of query-volume data — either per-deployment or summed across
 * deployments, depending on which tool produced it.
 *
 * `window_seconds` is the resolved length of the requested time range so
 * callers can compute rates (queries/sec) without re-deriving it.
 */
export interface QueryVolumeRow {
  /** Deployment IPFS hash (Qm...). Optional when caller summed across all. */
  deployment_id?: string;
  /** Total queries served in the window (sum across all 5-minute buckets). */
  query_count: number;
  /** Successful queries (status 200, no error) — summed across buckets. */
  success_count?: number;
  /** Failed queries (timeouts, 5xx, indexer rejections) — summed across buckets. */
  failure_count?: number;
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
 * QoS metrics for a specific indexer on a specific deployment.
 *
 * The gateway grades indexers on three axes that drive routing decisions:
 *   - latency (ms) — average / p95 response time
 *   - success rate (0..1) — fraction of queries that returned a 200 OK
 *   - blocks-behind — how far behind chain head this indexer was on average
 *
 * When `deployment_id` is omitted in the request, the QoS subgraph returns
 * one row per allocated deployment.
 */
export interface IndexerQoSRow {
  /** Lowercased 0x-prefixed indexer address. */
  indexer_address: string;
  /** Deployment IPFS hash (Qm...). */
  deployment_id: string;
  /**
   * Average end-to-end query latency in milliseconds, weighted by per-bucket
   * `queryCount` when available, otherwise a simple mean across buckets.
   */
  avg_latency_ms?: number;
  /**
   * 95th-percentile query latency in milliseconds. Approximated as the
   * weighted mean of per-bucket p95 values — a true p95 across buckets would
   * require raw samples, which the QoS subgraph doesn't expose.
   */
  p95_latency_ms?: number;
  /**
   * Fraction of successful queries in [0, 1]. Computed as
   * `success_count / query_count` when those counts are present; otherwise
   * the weighted mean of per-bucket `successRate`.
   */
  success_rate?: number;
  /**
   * Average blocks behind chain head, weighted by per-bucket `queryCount`
   * when available, otherwise a simple mean across buckets.
   */
  avg_blocks_behind?: number;
  /** Total queries (sum across buckets) the gateway routed to this indexer for this deployment. */
  query_count?: number;
  /** Sum of successful queries across buckets, when the subgraph exposes successCount. */
  success_count?: number;
  /** Sum of failed queries across buckets, when the subgraph exposes failureCount. */
  failure_count?: number;
  /** Length of the resolved window, in seconds. */
  window_seconds: number;
  /** True if pagination hit the cap and the result is incomplete. */
  truncated?: boolean;
}

/**
 * One entry in the ranked "top deployments by query volume" list.
 * Volume is summed across all indexers serving the deployment.
 */
export interface DeploymentVolumeRow {
  deployment_id: string;
  query_count: number;
  /** Rank in the returned list, 1-indexed. */
  rank: number;
  /** Length of the resolved window, in seconds. */
  window_seconds: number;
}
