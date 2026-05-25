/**
 * Type definitions for the dual-mode graphman client. Field names mirror
 * the graphman GraphQL schema's `deployment.info` shape where possible;
 * fields we're not yet sure of are marked optional so the client can return
 * partial data without misrepresenting state.
 *
 * TODO: verify against live graphman schema — the GraphQL surface is still
 * young and the exact response shape may differ across graph-node versions.
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

/**
 * Raw result of a graphman CLI invocation. Returned by every CLI-fallback
 * method on GraphmanClient so handlers can choose how to present output.
 */
export interface GraphmanCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Full argv of the underlying graphman invocation, for logging/debugging. */
  command: string[];
}

/** One stream (stdout or stderr) after size-capping for MCP transport. */
export interface CappedStream {
  /** Possibly-truncated text (tail kept — errors typically appear at the end). */
  text: string;
  /** True if the original was longer than the cap and bytes were dropped. */
  truncated: boolean;
}
