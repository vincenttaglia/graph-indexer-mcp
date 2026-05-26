/**
 * Type definitions for Graph Node's Status GraphQL API (port 8030).
 *
 * Numeric block fields (`number`, `entityCount`) are returned by graph-node as
 * GraphQL `BigInt`, which arrives over the wire as a JSON string. Keeping
 * them as `string` here avoids precision loss; callers can `BigInt(...)` if
 * they need arithmetic.
 *
 * Source schema fields are documented at
 * https://github.com/graphprotocol/graph-node/blob/master/server/index-node/src/schema.graphql
 */

/** A block reference returned by the status API. */
export interface Block {
  /** Block number as a decimal string (graph-node returns BigInt). */
  number: string;
  /** 0x-prefixed block hash. */
  hash: string;
}

/**
 * An error reported by graph-node while indexing a deployment.
 *
 * `deterministic` distinguishes deterministic failures (handler exceptions,
 * non-deterministic operations, etc. — re-running would produce the same
 * failure) from transient ones (RPC outages, race conditions).
 */
export interface SubgraphError {
  message: string;
  /** Block at which the error occurred, if known. */
  block?: Block;
  /** Mapping handler name that raised the error, if known. */
  handler?: string;
  deterministic: boolean;
}

/** Per-chain indexing progress for a deployment. */
export interface ChainIndexingStatus {
  /** Chain name as reported by graph-node (e.g. `mainnet`, `arbitrum-one`). */
  network: string;
  /** Tip of the chain as observed by graph-node. */
  chainHeadBlock?: Block;
  /** First block this deployment indexed (its start block). */
  earliestBlock?: Block;
  /** Most recent block this deployment has processed. */
  latestBlock?: Block;
  /** Last block at which the deployment was `healthy` (only set when degraded). */
  lastHealthyBlock?: Block;
}

/**
 * Top-level health record for a single deployment.
 *
 *  - `healthy`   — no errors; indexing normally.
 *  - `unhealthy` — non-fatal errors encountered; still progressing.
 *  - `failed`    — fatal error; indexing has halted.
 */
export interface SubgraphIndexingStatus {
  /** Deployment IPFS hash (Qm...). */
  subgraph: string;
  /** True once the deployment has reached chain head. */
  synced: boolean;
  health: 'healthy' | 'unhealthy' | 'failed';
  /** Set only when `health === 'failed'`. */
  fatalError?: SubgraphError;
  /** Always an array; empty when there are no non-fatal errors. */
  nonFatalErrors: SubgraphError[];
  /** One entry per chain this deployment reads from (almost always one). */
  chains: ChainIndexingStatus[];
  /** Total entities stored, as a decimal string (graph-node returns BigInt). */
  entityCount: string;
  /** Whether the deployment is currently paused (graph-node-side). */
  paused: boolean;
  /** Index-node assignment (e.g. "default", "index_node_0"); null when unassigned. */
  node: string | null;
  /** Optional block-history retention setting reported by graph-node. */
  historyBlocks: number | null;
}
