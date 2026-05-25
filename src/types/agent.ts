/**
 * Type definitions for the Indexer Agent Management API.
 *
 * The indexer-agent process exposes a GraphQL control plane (default port
 * 18000) for queueing/approving allocation actions and managing per-deployment
 * indexing rules and cost models. These types mirror the subset of the agent
 * schema we surface as MCP tools.
 *
 * Token amounts are represented as decimal strings (BigInt-as-string) to avoid
 * JS number precision loss for GRT wei values.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionType = 'allocate' | 'unallocate' | 'reallocate';

export type ActionStatus =
  | 'queued'
  | 'approved'
  | 'pending'
  | 'success'
  | 'failed'
  | 'canceled';

/**
 * A single entry in the indexer-agent's action queue.
 *
 * Fields are intentionally permissive (`?` on most) because the agent only
 * populates the subset relevant to the action's type and lifecycle stage.
 * For example, `allocate` actions carry `deploymentID` + `amount` but no
 * `allocationID` or `poi`; `unallocate` carries `allocationID` + `poi` but
 * not `amount`. `transaction` and `failureReason` appear only after the
 * action has been executed by the agent.
 */
export interface Action {
  /** Stable identifier assigned by the agent (numeric string). */
  id: string;
  type: ActionType;
  /** IPFS hash (`Qm…`) of the target subgraph deployment. */
  deploymentID: string;
  /** On-chain allocation id (0x…); present for unallocate/reallocate. */
  allocationID?: string;
  /** GRT amount in wei, as a decimal string. */
  amount?: string;
  /** Proof of Indexing (32-byte hex string). */
  poi?: string;
  status: ActionStatus;
  /** Originator tag — e.g. `indexerAgent`, `indexerCli`, or this MCP. */
  source: string;
  /** Free-form rationale supplied by the source. */
  reason?: string;
  /** Lower number = higher priority; default 0. */
  priority?: number;
  /** Transaction hash once the action has been broadcast. */
  transaction?: string;
  /** Populated when status === 'failed'. */
  failureReason?: string;
}

/**
 * Shape accepted by the agent's `queueActions` mutation. A queue entry must
 * always supply `type`, `deploymentID`, `source`, `reason`, and `priority`;
 * the other fields are gated on action type. We mirror this in the optional
 * fields rather than splitting per-type to keep the client surface small.
 */
export interface ActionInput {
  type: ActionType;
  deploymentID: string;
  allocationID?: string;
  /** Decimal string of GRT wei. */
  amount?: string;
  poi?: string;
  source: string;
  reason: string;
  priority: number;
  status?: ActionStatus;
}

// ---------------------------------------------------------------------------
// Indexing rules
// ---------------------------------------------------------------------------

/**
 * `identifier` is interpreted based on `identifierType`:
 *   - `deployment` — IPFS hash of a specific deployment.
 *   - `subgraph`   — subgraph id (covers all of its versions).
 *   - `group`      — named ruleset bucket.
 * The literal string `'global'` with type `'group'` is the catch-all default
 * applied when no more specific rule matches.
 */
export type IndexingRuleIdentifierType = 'deployment' | 'subgraph' | 'group';

export type IndexingDecisionBasis = 'rules' | 'never' | 'always' | 'offchain';

/**
 * Indexer-agent rule controlling whether/how the agent allocates to a
 * deployment. `safety` and `custom` are open-shape passthroughs to keep this
 * compatible with agent versions that add new knobs (the design doc leaves
 * the exact rule schema partly underspecified).
 */
export interface IndexingRule {
  identifier: string;
  identifierType: IndexingRuleIdentifierType;
  /** Default allocation size in GRT wei, decimal string. */
  allocationAmount?: string;
  /** Epochs to keep the allocation open before auto-reallocating. */
  allocationLifetime?: number;
  decisionBasis: IndexingDecisionBasis;
  /** Require deployment to be supported on the protocol network. */
  requireSupported?: boolean;
  /** Bag of safety-related knobs (e.g. minStake, minAvgQueryFees). */
  safety?: Record<string, unknown>;
  /** Bag of operator-defined / forward-compat fields. */
  custom?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cost models
// ---------------------------------------------------------------------------

/**
 * Agora cost model for query pricing on a deployment. `model` is the Agora
 * source; `variables` is an optional JSON string of model parameters. The
 * special deployment id `'global'` sets the fallback applied to any
 * deployment without a more specific model.
 */
export interface CostModel {
  /** Deployment IPFS hash, or `'global'` for the default. */
  deployment: string;
  model: string;
  /** JSON-encoded parameter object. */
  variables?: string;
}
