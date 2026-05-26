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

// Mirrors the canonical agent schema enum:
//   queued | approved | deploying | pending | success | failed | canceled
// (see graphprotocol/indexer indexer-management/client.ts)
export type ActionStatus =
  | 'queued'
  | 'approved'
  | 'deploying'
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
  /**
   * Stable identifier assigned by the agent. The agent's schema types
   * this as `Int!`; we type as `string | number` because JSON.parse hands
   * us a number but downstream consumers (and the agent's
   * `approveActions(actionIDs: [String!]!)` mutation) accept either form.
   */
  id: string | number;
  status: ActionStatus;
  type: ActionType;
  /** IPFS hash (`Qm…`) of the target subgraph deployment. */
  deploymentID: string;
  /** On-chain allocation id (0x…); present for unallocate/reallocate. */
  allocationID?: string | null;
  /** GRT amount in wei, as a decimal string. */
  amount?: string | null;
  /** Proof of Indexing (32-byte hex string). */
  poi?: string | null;
  /** Post-Horizon: public POI counterpart. */
  publicPOI?: string | null;
  /** Post-Horizon: block number the POI was computed at. */
  poiBlockNumber?: number | null;
  /** Post-Horizon: true when the action was queued with a forced POI. */
  force?: boolean | null;
  /** Lower number = higher priority; default 0. */
  priority?: number;
  /** Originator tag — e.g. `indexerAgent`, `indexerCli`, or this MCP. */
  source: string;
  /** Free-form rationale supplied by the source. */
  reason?: string;
  /** Transaction hash once the action has been broadcast. */
  transaction?: string | null;
  /** Populated when status === 'failed'. */
  failureReason?: string | null;
  /** ISO-8601 timestamp the agent assigned at queue time. */
  createdAt?: string;
  /** ISO-8601 timestamp of the most recent state change. */
  updatedAt?: string;
  /** Protocol-network chain alias the action was queued against. */
  protocolNetwork?: string;
  /** Whether the action targets the pre-Horizon staking contract. */
  isLegacy?: boolean;
}

/**
 * Shape accepted by the agent's `queueActions` mutation. A queue entry must
 * always supply `type`, `deploymentID`, `amount`, `source`, `reason`,
 * `priority`, `status`, `protocolNetwork`, and `isLegacy`. The POI bundle
 * (`poi`, `publicPOI`, `poiBlockNumber`, `force`) is optional and either
 * all-present or all-absent — see the `force_zero_poi` handling in
 * `src/tools/agent-tools.ts`.
 *
 * `status`, `protocolNetwork`, and `isLegacy` are REQUIRED on the wire
 * post-Horizon migration — the indexer-agent's `ActionInput!` GraphQL
 * type rejects the mutation if any of the three is missing.
 */
export interface ActionInput {
  type: ActionType;
  deploymentID: string;
  allocationID?: string;
  /**
   * Decimal string of GRT wei. Required even on `unallocate` (set to
   * `'0'`) — the agent's schema treats `amount` as a required string.
   */
  amount: string;
  /**
   * Pre-supplied POI hex string. Omit to let the agent compute one at
   * close time (default reward-claiming path). Set to the all-zero
   * sentinel only as part of the `force_zero_poi` bundle below.
   */
  poi?: string;
  /**
   * Post-Horizon: public POI counterpart to `poi`. Same omit-vs-zero
   * semantics. Set together with `poi`, `poiBlockNumber`, and `force`
   * (the four-field bundle) or not at all.
   */
  publicPOI?: string;
  /**
   * Post-Horizon: block number the supplied POI was computed at. `0`
   * when the POI is the all-zero sentinel. Set together with `poi`,
   * `publicPOI`, and `force` or not at all.
   */
  poiBlockNumber?: number;
  /**
   * Force the agent to accept the supplied POI without re-verification.
   * Always `true` when the four-field POI bundle is set; omitted
   * otherwise so the agent runs its normal POI computation.
   */
  force?: boolean;
  source: string;
  reason: string;
  priority: number;
  /** Required by the agent schema; the MCP always queues as 'queued'. */
  status: ActionStatus;
  /**
   * Required by the agent schema post-Horizon. The chain alias the
   * indexer-agent submits against, e.g. `arbitrum-one`. Sourced from
   * `config.protocolNetwork`.
   */
  protocolNetwork: string;
  /**
   * Required by the agent schema post-Horizon. For close/reallocate
   * actions, sourced from the allocation's `isLegacy` field on the
   * network subgraph. For new allocates, always `false` (Horizon-era).
   */
  isLegacy: boolean;
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
