/**
 * Type definitions for the Indexer Agent Management API.
 *
 * The indexer-agent process exposes a GraphQL control plane (default port
 * 18000) for queueing/approving allocation actions and managing per-deployment
 * indexing rules and cost models. These types mirror the subset of the agent
 * schema we surface as MCP tools.
 *
 * Token amounts on the wire use different units depending on the field:
 *   - `ActionInput.amount` / `Action.amount` — **GRT decimal string** ("100",
 *     "0.5"). Confirmed against indexer-tools-v4's wizardStore.ts which sends
 *     `String(amountGrt)` directly and displays via `parseFloat → "X GRT"`.
 *   - `IndexingRule.allocationAmount` and other BigInt schema fields
 *     (`minSignal`, `maxSignal`, `minStake`, `minAverageQueryFees`) — **wei
 *     decimal string** (BigInt-as-string), per the indexer-cli `parseGRT()`
 *     convention used by the agent's `IndexingRuleInput` resolver.
 * Mixing the two — e.g. sending wei in `ActionInput.amount` — over-allocates
 * by 10^18× and was the symptom that prompted this dual-unit documentation.
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
  /**
   * GRT amount as a **decimal string** of whole GRT ("100", "0.5") — NOT
   * wei. See the file-header note on dual-unit fields.
   */
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
   * Decimal string of **whole GRT** (e.g. `'100'`, `'0.5'`) — NOT wei.
   * Required even on `unallocate` (set to `'0'`) — the agent's schema
   * treats `amount` as a required string. The indexer-agent reads this
   * field with `parseFloat`-equivalent semantics (see indexer-tools-v4
   * `wizardStore.ts`/`WizardStepExecute.vue`), so passing the wei value
   * over-allocates by 10^18×.
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
 * deployment. Mirrors the canonical agent schema's `IndexingRule` type
 * (graphprotocol/indexer indexer-management/client.ts).
 *
 * Schema-required fields (`!` in GraphQL) are typed as required here when
 * we always select them; otherwise they're optional in the TS shape so
 * partial selection sets stay representable. `autoRenewal`, `requireSupported`,
 * `safety`, `decisionBasis`, `identifier`, `identifierType`, and
 * `protocolNetwork` are non-null in the schema; the rest are nullable.
 *
 * BigInt-typed schema fields (`allocationAmount`, `minSignal`, `maxSignal`,
 * `minStake`, `minAverageQueryFees`) are decimal strings on the wire — see
 * the file header for the BigInt-as-string convention.
 */
export interface IndexingRule {
  identifier: string;
  identifierType: IndexingRuleIdentifierType;
  /** Default allocation size in GRT wei, decimal string (BigInt). */
  allocationAmount?: string | null;
  /** Epochs to keep the allocation open before auto-reallocating. */
  allocationLifetime?: number | null;
  /**
   * When true the agent reallocates automatically as the lifetime
   * expires; when false the allocation stays closed after expiry. Non-null
   * in the schema (`Boolean!`); marked optional here so partial selection
   * sets are representable.
   */
  autoRenewal?: boolean;
  /** Maximum concurrent allocations the agent is allowed to open. */
  parallelAllocations?: number | null;
  /** Cap on the percentage of total stake committed to this rule, 0..1. */
  maxAllocationPercentage?: number | null;
  /** Minimum curation signal (BigInt wei) for the rule to match. */
  minSignal?: string | null;
  /** Maximum curation signal (BigInt wei) for the rule to match. */
  maxSignal?: string | null;
  /** Minimum indexer stake (BigInt wei) required for the rule to match. */
  minStake?: string | null;
  /** Minimum trailing average query fee (BigInt wei) for the rule to match. */
  minAverageQueryFees?: string | null;
  /** Free-form operator-supplied tag forwarded to the agent. */
  custom?: string | null;
  decisionBasis: IndexingDecisionBasis;
  /** Require deployment to be supported on the protocol network. */
  requireSupported?: boolean;
  /**
   * Safety flag — when true the agent applies additional pre-flight
   * checks before opening / closing allocations on this deployment.
   * Non-null in the schema (`Boolean!`); marked optional here so partial
   * selection sets are representable.
   */
  safety?: boolean;
  /**
   * Protocol-network alias the rule applies to (e.g. `arbitrum-one`).
   * Non-null in the schema (`String!`). Required on the wire and on this
   * TS shape because we always select it.
   */
  protocolNetwork: string;
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
