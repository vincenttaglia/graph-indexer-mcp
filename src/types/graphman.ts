/**
 * Type definitions for the graphman GraphQL client. Field names mirror the
 * graphman GraphQL schema (graph-node `graphman-api-expand` branch); fields
 * the API marks optional are optional here so the client can return partial
 * data without misrepresenting state.
 */

export interface DeploymentInfo {
  /** IPFS hash of the deployment, e.g. `Qm…`. */
  id: string;
  /** True if indexing is currently paused. */
  paused: boolean;
  /** Postgres shard the deployment lives in (e.g. `primary`, `shard1`). */
  shard?: string;
  /** Indexed network/chain name (e.g. `mainnet`, `arbitrum-one`). */
  chain?: string;
  /** graph-node instance the deployment is assigned to. */
  node?: string;
  /** Highest block indexed for this deployment. */
  latestBlock?: number;
  /** Sync/health summary — typically `healthy` | `unhealthy` | `failed`. */
  health?: string;
}

export type ExecutionState = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ExecutionStatus {
  /** Server-issued execution id returned by long-running mutations (e.g. restart). */
  id: string;
  /** Current state of the async command. */
  state: ExecutionState;
  /** Error detail if `state === 'FAILED'`. */
  error?: string;
}

/** One stream (stdout or stderr) after size-capping for MCP transport. */
export interface CappedStream {
  /** Possibly-truncated text (tail kept — errors typically appear at the end). */
  text: string;
  /** True if the original was longer than the cap and bytes were dropped. */
  truncated: boolean;
}

// =============================================================================
// Mutation result shapes
// =============================================================================

/**
 * Result of `deployment.reassign`, which returns a `ReassignResponse` union:
 * `Ok { success }` or `CompletedWithWarnings { success, warnings }`. We flatten
 * both into a single discriminated-by-presence result.
 */
export interface ReassignResult {
  success: boolean;
  /** Present only when the server completed the reassignment with warnings. */
  warnings?: string[];
}

/**
 * Result of `deployment.deleteDeployment` (our "drop"): the list of deployment
 * locator strings that were deleted.
 */
export interface DropResult {
  deletedLocators: string[];
}

/** Outcome kind for a single block checked by `chain.checkBlocks`. */
export type CheckBlockOutcomeKind =
  | 'Matched'
  | 'Diverged'
  | 'NotFound'
  | 'DuplicatesDeleted'
  | 'DuplicatesSkipped';

/** A single block outcome returned by a synchronous `checkBlocks` call. */
export interface CheckedBlock {
  /** The block number that was checked, when known. */
  number?: number;
  /** The outcome of the check. */
  outcome: CheckBlockOutcomeKind;
  /** Block hashes involved in the outcome (e.g. conflicting duplicate hashes). */
  hashes: string[];
  /** Human-readable diff, present only when the block diverged. */
  diff?: string;
}

/**
 * The synchronous result of `chain.checkBlocks` (by-hash / by-number). The
 * `diverged` count is the number of cache entries deleted because they
 * diverged from the provider.
 */
export interface CheckBlocksResult {
  diverged: number;
  blocks: CheckedBlock[];
}

/**
 * Discriminated result of `chain.checkBlocks`. by-hash / by-number return a
 * synchronous `result`; by-range runs in the background and returns an
 * `executionId`.
 */
export type CheckBlocksResponse =
  | { kind: 'result'; result: CheckBlocksResult }
  | { kind: 'execution'; executionId: string };

/**
 * Statistics returned by `chain.clearCallCache` in its stale-eviction
 * (`ttlDays`) mode.
 */
export interface StaleCallCacheStats {
  /** Effective TTL in days actually used for deletion. */
  effectiveTtlDays: number;
  /** Number of cache entries deleted from the call cache. */
  cacheEntriesDeleted: number;
  /** Number of contract entries deleted from the call meta. */
  contractsDeleted: number;
}

/**
 * Discriminated result of `chain.clearCallCache`. Range / removeEntireCache
 * modes return `empty`; the stale-eviction (`ttlDays`) mode returns `stale`
 * statistics.
 */
export type ClearCallCacheResponse =
  | { kind: 'empty'; success: boolean }
  | { kind: 'stale'; stats: StaleCallCacheStats };
