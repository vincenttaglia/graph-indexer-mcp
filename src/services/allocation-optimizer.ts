/**
 * AllocationOptimizer service — Stage 3 §4.1.
 *
 * Orchestrates the allocation-optimization workflow across the seven data
 * sources stage 1 landed. The service is pure: it gathers state, computes a
 * proposed allocation plan, and returns a structured `OptimizationResult` —
 * it does NOT mutate anything. The composite tool wrapper that registers
 * `run_allocation_optimization` is responsible for queueing the resulting
 * actions to the indexer-agent after operator confirmation.
 *
 * APR formula (§3.1 of the implementation plan):
 *
 *   reward_share = (S / T) * issuance_per_year * (A_i / (A_total + A_i))
 *   apr          = reward_share / A_i
 *
 * where
 *   S       = curation signal on this deployment
 *   T       = total curation signal across all deployments
 *   A_i     = this indexer's proposed allocation on the deployment
 *   A_total = sum of OTHER indexers' allocations on the deployment, derived
 *             as `subgraphDeployment.stakedTokens - currentIndexerAllocation`.
 *
 * All on-chain quantities are kept as `bigint` to preserve precision for wei
 * amounts. APR is returned as a Number (decimal fraction, e.g. 0.12 = 12%).
 */

import type { GraphmanClient } from '../clients/graphman.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { IndexerAgentClient } from '../clients/indexer-agent.js';
import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { QosSubgraphClient } from '../clients/qos-subgraph.js';
import type {
  Allocation,
  GraphNetwork,
  Indexer,
  SubgraphDeployment,
} from '../types/network.js';
import type { SubgraphIndexingStatus } from '../types/graphnode.js';
import { BLOCKS_PER_YEAR } from '../utils/constants.js';
import { toQmDeploymentId } from '../utils/ipfs.js';

// ===========================================================================
// Public types
// ===========================================================================

/**
 * Tunable parameters that shape the optimizer's output.
 *
 * Token / signal amounts may be supplied either as `bigint` or as a decimal
 * string (BigInt-as-string). Percent caps are decimals in [0, 1].
 */
export interface OptimizerConfig {
  /** 0x-prefixed indexer address. Normalized to lowercase before queries. */
  indexerAddress: string;
  /** Hard cap on the number of concurrent active allocations. */
  maxAllocations: number;
  /** Per-allocation cap as a fraction of total stake. [0, 1]. */
  maxAllocationPct: number;
  /** Per-allocation cap for "risky" deployments. [0, 1]. */
  riskyDeploymentCapPct: number;
  /** Minimum curation signal (wei) to consider a deployment. */
  minSignal: bigint | string;
  /** Estimated total gas in GRT wei spent over an allocation's lifetime. */
  gasEstimateGrt: bigint | string;
  /** Deployments that bypass the candidate filter. */
  whitelist: string[];
  /** Deployments that must never be allocated to. */
  blacklist: string[];
  /** Existing allocations on these deployments are preserved untouched. */
  frozenlist: string[];
  /** Deployments to which the `riskyDeploymentCapPct` cap applies. */
  riskyDeployments: string[];
}

/**
 * One subgraph deployment considered by the optimizer along with the state
 * required for APR math and policy decisions.
 */
export interface OptimizationCandidate {
  deploymentId: string;
  signalledTokens: bigint;
  /** Total stake from ALL indexers on this deployment (incl. this indexer). */
  totalStakedTokens: bigint;
  /** This indexer's current allocation on this deployment; 0 if none. */
  currentAllocation: bigint;
  isHealthy: boolean;
  isSynced: boolean;
  /**
   * Pause state as reported by graph-node's `indexingStatuses.paused`. The
   * optimizer previously fetched this via graphman's `deployment.info`;
   * graph-node now surfaces it natively in the same query we already make
   * for sync/health, so the read path no longer needs graphman.
   */
  isPaused: boolean;
  isRisky: boolean;
  isFrozen: boolean;
  /** Optional QoS hint — only used as a tie-breaker, not in core APR. */
  queryVolume30d?: bigint;
}

/**
 * The optimizer's proposed end-state for a single deployment.
 *
 * `allocatedTokens === 0n` means "close any existing allocation on this
 * deployment" (i.e. the deployment falls off the plan).
 */
export interface ProposedAllocation {
  deploymentId: string;
  allocatedTokens: bigint;
  projectedAprFraction: number;
  rationale: string;
}

/**
 * One concrete action the operator could queue with the indexer-agent. The
 * service does NOT queue these itself.
 */
export interface AgentActionPlan {
  type: 'allocate' | 'unallocate' | 'reallocate';
  deploymentId: string;
  /** For allocate / reallocate: new allocation size in wei. */
  amount?: bigint;
  /** For unallocate / reallocate: id of the existing on-chain allocation. */
  allocationId?: string;
  reason: string;
}

export interface OptimizationStateSummary {
  /**
   * Total allocatable budget (= `indexer.tokenCapacity`): self-stake plus
   * delegated stake capped by the protocol delegation ratio. This is what
   * `availableStake`, per-deployment caps, and the gas-floor budget are
   * measured against — NOT the indexer's self-stake alone.
   */
  totalStake: bigint;
  /** Stake not pinned by frozen allocations — what the optimizer can deploy. */
  availableStake: bigint;
  /** Indexer's own stake (wei). Surfaced for operator-side sanity. */
  selfStake: bigint;
  /** Stake delegated to this indexer (wei). Surfaced for operator-side sanity. */
  delegatedStake: bigint;
  activeAllocationCount: number;
  candidatesConsidered: number;
  candidatesAfterFilter: number;
}

export interface OptimizationResult {
  state: OptimizationStateSummary;
  proposedAllocations: ProposedAllocation[];
  actions: AgentActionPlan[];
  warnings: string[];
  errors: string[];
}

export interface AllocationOptimizerDeps {
  networkClient: NetworkSubgraphClient;
  graphNodeClient: GraphNodeClient;
  /**
   * Optional — kept on the deps surface for forward compatibility / existing
   * wiring, but the optimizer's read path no longer touches graphman.
   * Pause state now comes from graph-node's `indexingStatuses.paused`,
   * which is part of the same fetch we already make for sync/health.
   * Graphman remains required to *execute* the mutation plan (pause /
   * unassign / unused_remove / etc.) but is not a dependency of the
   * optimization analysis.
   */
  graphmanClient?: GraphmanClient;
  qosClient: QosSubgraphClient;
  agentClient: IndexerAgentClient;
}

// ===========================================================================
// Implementation
// ===========================================================================

/**
 * Scale factor for marginal comparisons in the iterative-greedy allocator.
 * Marginal APR = R × D / (D + A)² is a fraction much smaller than 1 at
 * wei scale; we multiply by 10^27 to carry ~84 bits of fractional
 * precision through BigInt division. Two marginals computed at the same
 * SCALE are directly comparable as integers, which is what the inner
 * argmax loop needs.
 */
const MARGINAL_SCALE = 10n ** 27n;

/**
 * Sentinel marginal value used to give a candidate "claim me first"
 * priority. Two cases:
 *
 *   - D=0 deployments: reward = R × A / (0 + A) = R is constant in A for
 *     A > 0, so the true marginal at A=0 is undefined (R/0). We treat it
 *     as +∞ so the candidate wins one chunk; on the next iteration its
 *     marginal drops to 0 (R × 0 / A² = 0) and it never wins again. This
 *     yields the desired "claim once, no more" behavior.
 *   - Whitelisted candidates: operator policy forces them into the plan
 *     for at least one chunk; thereafter they water-fill on their real
 *     marginal alongside the rest.
 *
 * 2^200 is comfortably larger than any realistic R × D × MARGINAL_SCALE,
 * which at wei scale (~10^29 for both R and D) tops out near 10^85 ≈ 2^283
 * in the absolute worst case, but with the (D+A)² denominator the effective
 * value stays well below 2^200 for any realistic state. If the sentinel
 * ever collided with a real marginal it would still be a tie-break, not a
 * correctness violation.
 */
const MAX_MARGINAL = 1n << 200n;

/**
 * Marginal-APR-times-MARGINAL_SCALE for a candidate at current allocation A.
 *
 * Total reward: reward(A) = R × A / (D + A)
 * Marginal:     d reward / dA = R × D / (D + A)²
 *
 * Returns 0 if the candidate has no reward potential at A. Returns
 * MAX_MARGINAL for the "claim me first" cases described above.
 */
function computeMarginal(R: bigint, D: bigint, A: bigint, whitelisted: boolean): bigint {
  if (R === 0n) return 0n;
  // Whitelist priority: guarantee at least one chunk by signaling MAX at A=0.
  if (whitelisted && A === 0n) return MAX_MARGINAL;
  if (D === 0n) {
    // Constant total reward at A > 0; claim once, then stop.
    return A === 0n ? MAX_MARGINAL : 0n;
  }
  const denom = D + A;
  return (R * D * MARGINAL_SCALE) / (denom * denom);
}

/** Convert a `bigint | string` to bigint, treating strings as decimal. */
function toBigInt(v: bigint | string | undefined | null): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  // Strings may arrive empty when a subgraph field is missing — treat as 0.
  if (v === '') return 0n;
  return BigInt(v);
}

/** Convert a bigint ratio (numer / denom) to a Number, clamping denom>0. */
function bigintRatioToNumber(numer: bigint, denom: bigint): number {
  if (denom === 0n) return 0;
  // Scale by 1e18 so we keep ~18 decimals of precision before crossing into
  // Number. Number has 15–17 significant decimal digits, which is enough.
  const SCALE = 1_000_000_000_000_000_000n;
  const scaled = (numer * SCALE) / denom;
  return Number(scaled) / Number(SCALE);
}

/**
 * Compute the projected APR (decimal fraction) for a candidate at a given
 * proposed allocation amount.
 *
 *   reward_share = (S / T) * issuance_per_year * (A_i / (A_total + A_i))
 *   apr          = reward_share / A_i
 *               = (S / T) * issuance_per_year / (A_total + A_i)
 *
 * The simplification (cancel A_i) is intentional: it makes the APR finite for
 * the A_i → 0 probe used in ranking and avoids a division by an
 * operator-supplied amount that could be zero.
 *
 * All BigInt math until the final ratio → Number conversion.
 */
export function calculateApr(args: {
  signal: bigint;
  totalSignal: bigint;
  issuancePerYear: bigint;
  proposedAllocation: bigint;
  otherIndexersAllocation: bigint;
}): number {
  const { signal, totalSignal, issuancePerYear, proposedAllocation, otherIndexersAllocation } =
    args;
  if (totalSignal === 0n) return 0;
  const totalAlloc = otherIndexersAllocation + proposedAllocation;
  if (totalAlloc === 0n) return 0;
  // numer = S * issuance_per_year, denom = T * (A_total + A_i)
  const numer = signal * issuancePerYear;
  const denom = totalSignal * totalAlloc;
  return bigintRatioToNumber(numer, denom);
}

/**
 * Per-deployment cap (in wei) given total stake and risk classification.
 */
function perDeploymentCap(
  totalStake: bigint,
  isRisky: boolean,
  config: OptimizerConfig,
): bigint {
  const pct = isRisky ? config.riskyDeploymentCapPct : config.maxAllocationPct;
  // Compute via 1e6 PPM ratio so we stay in bigint.
  const ppm = BigInt(Math.max(0, Math.min(1, pct)) * 1_000_000 | 0);
  return (totalStake * ppm) / 1_000_000n;
}

function isSyncedAt(status: SubgraphIndexingStatus | undefined): boolean {
  return Boolean(status?.synced);
}

function isHealthyAt(status: SubgraphIndexingStatus | undefined): boolean {
  return status?.health === 'healthy';
}

function isPausedAt(status: SubgraphIndexingStatus | undefined): boolean {
  // graph-node surfaces `paused` natively on `indexingStatuses`. When a
  // status entry is missing (the deployment isn't tracked locally) we
  // conservatively report "not paused" — the surrounding health gate
  // already excludes those candidates (no status → isHealthyAt returns
  // false), so this default only matters for the rare path where the
  // candidate has a status row but no `paused` field populated.
  return Boolean(status?.paused);
}

export class AllocationOptimizer {
  constructor(private readonly deps: AllocationOptimizerDeps) {}

  /**
   * Execute the full §4.1 workflow. Returns a structured result; never
   * throws unless the indexer entity itself can't be found (a config error
   * the operator must fix). Per-source failures degrade gracefully and are
   * recorded in `errors`.
   */
  async run(
    config: OptimizerConfig,
    opts?: { signal?: AbortSignal },
  ): Promise<OptimizationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    opts?.signal?.throwIfAborted?.();

    // ---------------------------------------------------------------------
    // 1. Gather state in parallel — degrade per-source.
    // ---------------------------------------------------------------------
    const sigOpt = opts?.signal ? { signal: opts.signal } : undefined;

    const [
      indexerRes,
      activeAllocsRes,
      signalledDeploymentsRes,
      networkParamsRes,
    ] = await Promise.allSettled([
      this.deps.networkClient.getIndexer(config.indexerAddress, sigOpt),
      this.deps.networkClient.getActiveAllocations(config.indexerAddress, sigOpt),
      this.deps.networkClient.getSignalledDeployments(
        String(toBigInt(config.minSignal)),
        sigOpt,
      ),
      this.deps.networkClient.getNetworkParameters(sigOpt),
    ]);

    opts?.signal?.throwIfAborted?.();

    const indexer: Indexer | null =
      indexerRes.status === 'fulfilled' ? indexerRes.value : null;
    if (indexerRes.status === 'rejected') {
      errors.push(`network.getIndexer failed: ${errString(indexerRes.reason)}`);
    }
    if (!indexer) {
      // Without the indexer entity we have no stake — return an empty plan
      // with a clear warning rather than throwing, so callers can surface it.
      warnings.push(
        `indexer "${config.indexerAddress}" not found in network subgraph — ` +
          'cannot produce an allocation plan',
      );
      return {
        state: {
          totalStake: 0n,
          availableStake: 0n,
          selfStake: 0n,
          delegatedStake: 0n,
          activeAllocationCount: 0,
          candidatesConsidered: 0,
          candidatesAfterFilter: 0,
        },
        proposedAllocations: [],
        actions: [],
        warnings,
        errors,
      };
    }

    const activeAllocations: Allocation[] =
      activeAllocsRes.status === 'fulfilled' ? activeAllocsRes.value.items : [];
    if (activeAllocsRes.status === 'fulfilled' && activeAllocsRes.value.truncated) {
      warnings.push(
        'active allocations list truncated by pagination cap — plan may not see ' +
          'every existing allocation',
      );
    } else if (activeAllocsRes.status === 'rejected') {
      errors.push(
        `network.getActiveAllocations failed: ${errString(activeAllocsRes.reason)}`,
      );
    }

    const signalledDeployments: SubgraphDeployment[] =
      signalledDeploymentsRes.status === 'fulfilled'
        ? signalledDeploymentsRes.value.items
        : [];
    if (
      signalledDeploymentsRes.status === 'fulfilled' &&
      signalledDeploymentsRes.value.truncated
    ) {
      warnings.push(
        'signalled deployments list truncated by pagination cap — some ' +
          'candidates may be missing',
      );
    } else if (signalledDeploymentsRes.status === 'rejected') {
      errors.push(
        `network.getSignalledDeployments failed: ${errString(signalledDeploymentsRes.reason)}`,
      );
    }

    let networkParams: GraphNetwork | null = null;
    if (networkParamsRes.status === 'fulfilled') {
      networkParams = networkParamsRes.value;
    } else {
      errors.push(
        `network.getNetworkParameters failed: ${errString(networkParamsRes.reason)}`,
      );
    }

    // ---------------------------------------------------------------------
    // Build the candidate universe BEFORE the per-deployment queries we
    // need so we can fetch graph-node + graphman + qos by id-set.
    //
    // Internal canonical form is Qm (IPFS CIDv0). Network-subgraph IDs
    // arrive in bytes32 form (`0x…`); graph-node's `indexingStatuses`
    // response is in Qm form. Normalizing every internal key/set to Qm at
    // the gather boundary makes every downstream lookup
    // (`statusById.get(id)`, set membership, etc.) consistent — the prior
    // bug was a bytes32 candidate id missing every Qm-keyed status entry,
    // dropping every candidate and recommending all-allocations-closed.
    //
    // `qmToOriginalId` preserves the operator's original ID format for
    // diagnostic use only. User-facing output (proposedAllocations[].
    // deploymentId, actions[].deploymentId, warnings) is always emitted
    // in the Qm canonical form so MCP clients see a single consistent
    // encoding regardless of what the operator passed in — matching
    // graph-node + graphman + indexer-agent, which all use Qm natively.
    // The map is kept so future internal diagnostics can still recover
    // the original encoding if needed.
    // ---------------------------------------------------------------------
    const qmToOriginalId = new Map<string, string>();
    /**
     * Normalize a deployment id to Qm canonical form for internal lookups.
     *
     * Strict by design: throws on anything that isn't valid bytes32 (`0x…`)
     * or Qm (`Qm…`) form. Callers MUST catch and skip the bad id rather
     * than admit it into `candidateIds` / downstream maps — admitting a raw
     * unnormalized string would forward it to `graphNodeClient
     * .getIndexingStatuses(...)`, which rejects the entire batch on one
     * invalid id, leaving `statusById` empty and the §4.1 health/sync
     * gate dropping every candidate (regression: a typo in `whitelist`
     * would silently close every allocation).
     */
    const normalizeToQm = (raw: string): string => {
      const qm = toQmDeploymentId(raw); // throws on garbage
      if (!qmToOriginalId.has(qm)) qmToOriginalId.set(qm, raw);
      return qm;
    };
    const originalOf = (qm: string): string => qmToOriginalId.get(qm) ?? qm;

    /**
     * Helper for the config-list normalization pattern: try to normalize
     * each raw id, push a per-source warning + skip on failure, return
     * the resulting Qm-form Set.
     */
    const normalizeSet = (raws: readonly string[], sourceLabel: string): Set<string> => {
      const out = new Set<string>();
      for (const raw of raws) {
        try {
          out.add(normalizeToQm(raw));
        } catch {
          warnings.push(
            `${sourceLabel} entry ${JSON.stringify(raw)} is not a valid ` +
              `deployment ID (expected 0x<64-hex> or Qm<base58-44>); skipping.`,
          );
        }
      }
      return out;
    };

    const whitelist = normalizeSet(config.whitelist, 'Whitelist');
    const blacklist = normalizeSet(config.blacklist, 'Blacklist');
    const frozenSet = normalizeSet(config.frozenlist, 'Frozenlist');
    const riskySet = normalizeSet(config.riskyDeployments, 'RiskyDeployments');

    const currentByDeployment = new Map<string, Allocation>();
    for (const alloc of activeAllocations) {
      let qm: string;
      try {
        qm = normalizeToQm(alloc.subgraphDeployment.id);
      } catch {
        // An active allocation from the network subgraph with a malformed
        // deployment id is an upstream-data bug. Skip rather than poison
        // the candidate batch — the run still produces a plan for valid
        // allocations and surfaces the bad row in warnings.
        warnings.push(
          `Active allocation ${JSON.stringify(alloc.id)} has a malformed ` +
            `deployment id ${JSON.stringify(alloc.subgraphDeployment.id)} ` +
            `(expected 0x<64-hex> or Qm<base58-44>); skipping.`,
        );
        continue;
      }
      // Keep the largest active allocation per deployment if there are
      // multiple (shouldn't happen, but the schema doesn't forbid it).
      const existing = currentByDeployment.get(qm);
      if (
        !existing ||
        toBigInt(alloc.allocatedTokens) > toBigInt(existing.allocatedTokens)
      ) {
        currentByDeployment.set(qm, alloc);
      }
    }

    // Start the candidate pool from signalled deployments (the "discovery"
    // axis) and union with whitelist + current allocations so we don't drop
    // a deployment just because it dipped under minSignal between runs.
    //
    // Malformed signalled-deployment ids are skipped with a warning —
    // including one in `candidateIdList` would taint the graph-node batch
    // (single bad id rejects the whole request) and drop every other
    // candidate's status lookup downstream.
    const candidateIds = new Set<string>();
    for (const dep of signalledDeployments) {
      try {
        candidateIds.add(normalizeToQm(dep.id));
      } catch {
        warnings.push(
          `Signalled deployment id ${JSON.stringify(dep.id)} from the network ` +
            `subgraph is malformed (expected 0x<64-hex> or Qm<base58-44>); ` +
            `skipping.`,
        );
      }
    }
    for (const id of whitelist) candidateIds.add(id);
    for (const id of currentByDeployment.keys()) candidateIds.add(id);

    const candidatesConsidered = candidateIds.size;

    // ---------------------------------------------------------------------
    // Per-deployment data: graph-node indexing status (pause + sync + health
    // in one shot) and QoS volume. Run in parallel; degrade per-source.
    //
    // The optimizer used to call graphman.getDeploymentInfo once per
    // candidate just to read `paused`. graph-node now exposes that field on
    // its `indexingStatuses` query (and we select it explicitly), so the
    // read path no longer touches graphman at all. Graphman remains
    // required only for executing the resulting mutation plan.
    // ---------------------------------------------------------------------
    // All Qm-form. The graph-node client also normalizes its inputs, but
    // passing Qm here keeps cache keys consistent with the response form.
    const candidateIdList = Array.from(candidateIds);

    const [statusesRes, qosRes] = await Promise.allSettled([
      this.deps.graphNodeClient.getIndexingStatuses(candidateIdList, sigOpt),
      this.deps.qosClient.getTopQueriedDeployments(
        {
          limit: 200,
          timeRange: { days: 30 },
        },
        sigOpt,
      ),
    ]);

    opts?.signal?.throwIfAborted?.();

    // graph-node's `s.subgraph` is contractually always Qm — if anything
    // else shows up it's a graph-node bug, not a configuration issue.
    // Validate through the same strict normalizer used to build
    // `candidateIdList` above so map keys are guaranteed-consistent with
    // downstream lookups. Promote to `errors` (not `warnings`) so operators
    // see it, but keep going so the run still produces a result.
    const statusById = new Map<string, SubgraphIndexingStatus>();
    if (statusesRes.status === 'fulfilled') {
      for (const s of statusesRes.value) {
        try {
          const key = normalizeToQm(s.subgraph);
          statusById.set(key, s);
        } catch {
          errors.push(
            `graph-node returned a malformed deployment id ${JSON.stringify(s.subgraph)} ` +
              `on an indexing status (expected Qm<base58-44>); skipping.`,
          );
        }
      }
    } else {
      errors.push(
        `graphNode.getIndexingStatuses failed: ${errString(statusesRes.reason)}`,
      );
    }

    // Identify candidates that the bulk query didn't return a status for.
    // graph-node's bulk indexingStatuses may return partial results when the
    // candidate list is large (response-size / query-complexity limits at the
    // gateway or graph-node side). The filter below treats a missing status
    // as "unhealthy" and silently drops the candidate — which has bitten
    // operators on real deployments at cap with healthy state confirmed via
    // per-deployment health checks. Per-deployment fallbacks are reliable:
    // each call is a single-element query so size limits don't come into play.
    //
    // Build missing list, prioritized by source. Current allocations and
    // whitelist entries are the most operator-critical — fall back on them
    // before generic signalled candidates so a partial bulk response doesn't
    // silently drop the operator's existing allocations. A current that's
    // also whitelisted lands in `missingCurrent` (first hit wins); that's
    // fine — currents are at least as critical as whitelist.
    const missingCurrent: string[] = [];
    const missingWhitelist: string[] = [];
    const missingOther: string[] = [];
    for (const id of candidateIdList) {
      if (statusById.has(id)) continue;
      if (currentByDeployment.has(id)) missingCurrent.push(id);
      else if (whitelist.has(id)) missingWhitelist.push(id);
      else missingOther.push(id);
    }
    const missingStatusIdsAll = [
      ...missingCurrent,
      ...missingWhitelist,
      ...missingOther,
    ];

    if (missingStatusIdsAll.length > 0) {
      // Cap fallback fetches to avoid hammering graph-node when the bulk
      // query is severely truncated. The cap is well above the expected
      // worst case (a handful of missing statuses) so it should almost
      // never fire; when it does, the warning steers the operator toward
      // shrinking the candidate pool or upgrading graph-node.
      const FALLBACK_LIMIT = 50;
      const originalMissing = missingStatusIdsAll.length;
      let missingStatusIds = missingStatusIdsAll;
      let skippedFallback = 0;
      if (missingStatusIds.length > FALLBACK_LIMIT) {
        skippedFallback = missingStatusIds.length - FALLBACK_LIMIT;
        missingStatusIds = missingStatusIds.slice(0, FALLBACK_LIMIT);
      }

      if (skippedFallback > 0) {
        warnings.push(
          `graph-node bulk query was missing ${originalMissing} statuses; ` +
            `capping per-deployment fallback at ${FALLBACK_LIMIT} (prioritizing ` +
            `${missingCurrent.length} current allocations + ${missingWhitelist.length} whitelist; ` +
            `${skippedFallback} signalled candidates skipped and will be silently filtered). ` +
            `Reduce minSignal or lower MAX_ALLOCATIONS to shrink the candidate pool, ` +
            `or upgrade graph-node to a version with higher response limits.`,
        );
      }

      const fallbackResults = await Promise.allSettled(
        missingStatusIds.map((id) =>
          this.deps.graphNodeClient.getDeploymentHealth(id, sigOpt),
        ),
      );
      let fallbackHits = 0;
      let fallbackMisses = 0;
      for (let i = 0; i < missingStatusIds.length; i++) {
        const id = missingStatusIds[i]!;
        const res = fallbackResults[i]!;
        if (res.status === 'fulfilled' && res.value) {
          try {
            const key = normalizeToQm(res.value.subgraph);
            statusById.set(key, res.value);
            fallbackHits++;
          } catch {
            errors.push(
              `per-deployment status fallback for ${id} returned ` +
                `malformed subgraph id ${JSON.stringify(res.value.subgraph)}; skipping.`,
            );
          }
        } else {
          fallbackMisses++;
        }
      }
      if (fallbackHits > 0 || fallbackMisses > 0 || skippedFallback > 0) {
        warnings.push(
          `graph-node bulk indexingStatuses query was missing ${originalMissing} ` +
            `candidate statuses; per-deployment fallback recovered ${fallbackHits} ` +
            `(${fallbackMisses} have no graph-node status${skippedFallback > 0 ? `, ${skippedFallback} skipped by cap` : ''}). ` +
            `Large candidate lists may hit graph-node response limits — recovered ` +
            `candidates are included in the optimization.`,
        );
      }
    }

    // Build pauseById directly from the indexing-status fetch above —
    // single source of truth, no graphman call. When the status fetch
    // failed entirely, every candidate falls back to `paused = false` so
    // the rest of the run still produces a plan instead of incorrectly
    // excluding everything (the failure is already in `errors`). This
    // runs *after* the per-deployment fallback above so recovered
    // statuses contribute the correct `paused` state.
    const pauseById = new Map<string, boolean>();
    for (const id of candidateIdList) {
      pauseById.set(id, isPausedAt(statusById.get(id)));
    }

    const qosVolumeById = new Map<string, bigint>();
    if (qosRes.status === 'fulfilled') {
      for (const row of qosRes.value) {
        // query_count is a BigInt-as-string on the QoS client surface. Parse
        // directly via BigInt; truncate any fractional component and clamp
        // negatives/malformed strings to zero defensively.
        const raw = (row.query_count ?? '0').trim();
        const intPart = (raw.startsWith('-') ? '0' : raw.split('.')[0]) ?? '0';
        let v: bigint;
        try {
          v = BigInt(intPart);
        } catch {
          v = 0n;
        }
        // Normalize QoS deployment IDs to the same Qm canonical form used
        // for every other internal lookup. The Gateway QoS Oracle subgraph
        // schema defines `SubgraphDeployment.id` as the IPFS hash (CIDv0),
        // so this is usually a no-op — `toQmDeploymentId` is idempotent on
        // Qm input — but guards against a future schema change emitting
        // bytes32 and silently dropping every volume hint.
        let key: string;
        try {
          key = toQmDeploymentId(row.deployment_id);
        } catch {
          // Malformed id from the QoS surface — skip the row rather than
          // poisoning the map.
          continue;
        }
        qosVolumeById.set(key, v < 0n ? 0n : v);
      }
    } else {
      errors.push(`qos.getTopQueriedDeployments failed: ${errString(qosRes.reason)}`);
    }

    // ---------------------------------------------------------------------
    // 2. Filter candidates.
    // ---------------------------------------------------------------------
    // Index signalled deployments for fast lookup; for non-signalled ids
    // (whitelist or current alloc) we hydrate via a bounded parallel batch
    // of `getDeployment` calls below — otherwise signal/stake would be 0
    // and APR / A_total inputs would be garbage.
    const signalledById = new Map<string, SubgraphDeployment>();
    for (const dep of signalledDeployments) {
      try {
        // The candidate-pool build above already warned about any
        // malformed signalled-deployment id; silently skip the same ids
        // here so we don't double-warn.
        signalledById.set(normalizeToQm(dep.id), dep);
      } catch {
        // Already warned above.
      }
    }

    // Hydrate whitelist/current-only candidates missing from the signalled
    // query (Finding 1). Run in parallel via allSettled so a single failed
    // lookup doesn't poison the batch — errors are logged best-effort.
    //
    // Internal candidateIdList is Qm-form; the network-subgraph
    // `getDeployment` query accepts either form (the client normalizes at
    // its boundary), so we pass the Qm canonical id — same shape we report
    // in all user-facing output for consistency.
    const missingIds = candidateIdList.filter(
      (id) => !signalledById.has(id) && !blacklist.has(id),
    );
    if (missingIds.length > 0) {
      const hydrateResults = await Promise.allSettled(
        missingIds.map((id) =>
          this.deps.networkClient.getDeployment(id, sigOpt),
        ),
      );
      for (let i = 0; i < missingIds.length; i++) {
        const id = missingIds[i]!;
        const res = hydrateResults[i]!;
        if (res.status === 'fulfilled') {
          if (res.value) {
            signalledById.set(id, res.value);
          } else {
            warnings.push(
              `network.getDeployment("${id}") returned null — candidate has ` +
                'no signal/stake data; skipping APR contribution',
            );
          }
        } else {
          errors.push(
            `network.getDeployment("${id}") failed: ${errString(res.reason)}`,
          );
        }
      }
    }

    opts?.signal?.throwIfAborted?.();

    const minSignal = toBigInt(config.minSignal);

    const candidates: OptimizationCandidate[] = [];
    for (const id of candidateIdList) {
      const isWhitelisted = whitelist.has(id);
      const isBlacklisted = blacklist.has(id);
      const isCurrentlyAllocated = currentByDeployment.has(id);

      // Blacklist always wins over whitelist — defensive choice. An operator
      // who put a deployment on both lists almost certainly meant "no".
      if (isBlacklisted) continue;

      const dep = signalledById.get(id);
      const signalledTokens = dep ? toBigInt(dep.signalledTokens) : 0n;
      const totalStakedTokens = dep ? toBigInt(dep.stakedTokens) : 0n;
      const deniedAt = dep ? dep.deniedAt : 0;

      // Rewards-denied deployments earn no indexing rewards even if signalled.
      if (deniedAt && deniedAt !== 0 && !isWhitelisted) continue;

      // Signal floor — whitelist OR a current allocation overrides it
      // (Finding 2). Without the current-allocation exemption a deployment
      // whose signal dips between runs gets force-unallocated mid-rebalance.
      if (signalledTokens < minSignal && !isWhitelisted && !isCurrentlyAllocated) {
        continue;
      }

      const status = statusById.get(id);
      const healthy = isHealthyAt(status);
      const paused = pauseById.get(id) ?? false;
      // `isSynced` is captured on the candidate for diagnostics/operator
      // visibility only — it is intentionally NOT part of the gate below.
      const synced = isSyncedAt(status);

      // Health + pause gates — whitelist does NOT override these; it's
      // unsafe to allocate to a deployment that's actively broken.
      //
      // We DO NOT gate on `synced` (graph-node's "caught up to chainhead"
      // flag). Synced flips false on a single-block lag — restart, RPC
      // blip, normal pacing — and a healthy lagging deployment is still
      // allocatable: it will earn future-epoch rewards once it catches up.
      // Closability for the current epoch (latestBlock >= epochStartBlock)
      // is the HealthMonitor's concern, not the optimizer's eligibility
      // check. Do NOT re-introduce a `synced` gate here without first
      // understanding why HealthMonitor.classify() owns that responsibility.
      if (!healthy || paused) continue;

      const current = currentByDeployment.get(id);
      const currentAllocation = current ? toBigInt(current.allocatedTokens) : 0n;

      const candidate: OptimizationCandidate = {
        // User-facing field: always emit the Qm (IPFS CIDv0) form regardless
        // of which encoding the operator supplied. graph-node + graphman +
        // indexer-agent all use Qm natively; emitting bytes32 here would
        // make downstream consumers (proposedAllocations, actions,
        // indexer-agent queue, action UI) inconsistent with the rest of the
        // MCP surface. Internal lookups still happen against `id`, which is
        // already the Qm canonical form.
        deploymentId: id,
        signalledTokens,
        totalStakedTokens,
        currentAllocation,
        isHealthy: healthy,
        isSynced: synced,
        isPaused: paused,
        isRisky: riskySet.has(id),
        isFrozen: frozenSet.has(id),
      };
      const qos = qosVolumeById.get(id);
      if (qos !== undefined) candidate.queryVolume30d = qos;
      candidates.push(candidate);
    }

    const candidatesAfterFilter = candidates.length;

    // ---------------------------------------------------------------------
    // 3. Compute optimization inputs.
    // ---------------------------------------------------------------------
    // totalStake is the indexer's MAXIMUM ALLOCATABLE STAKE — self + capped
    // delegation. This is what `availableStake`, per-deployment caps
    // (maxAllocationPct × totalStake), and the gas-floor budget should all
    // be measured against. Using self-stake alone (indexer.stakedTokens)
    // would budget against ~30% of the indexer's real allocation capacity
    // for any indexer with meaningful delegation.
    //
    // `tokenCapacity` already reflects the delegationRatio cap on the
    // network-subgraph side: capacity = self + min(delegated, self × delegationRatio).
    const totalStake = toBigInt(indexer.tokenCapacity);
    const selfStake = toBigInt(indexer.stakedTokens);
    const delegatedStake = toBigInt(indexer.delegatedTokens);
    const totalSignal = networkParams
      ? toBigInt(networkParams.totalTokensSignalled)
      : 0n;
    const issuancePerBlock = networkParams
      ? toBigInt(networkParams.networkGRTIssuancePerBlock)
      : 0n;
    const blocksPerYear = BigInt(BLOCKS_PER_YEAR);
    const issuancePerYear = issuancePerBlock * blocksPerYear;

    if (totalSignal === 0n) {
      warnings.push(
        'totalTokensSignalled is 0 — APR cannot be computed; returning empty plan',
      );
    }
    if (issuancePerYear === 0n) {
      warnings.push(
        'networkGRTIssuancePerBlock × BLOCKS_PER_YEAR is 0 — APR cannot be ' +
          'computed; returning empty plan',
      );
    }

    // Frozen allocations: keep them as-is, count their stake against
    // available, and surface them in the proposal so operators see the full
    // intended end state. `id` here is the Qm canonical form
    // (currentByDeployment is keyed by Qm); candidate.deploymentId is also
    // Qm so we look the candidate up directly via `id`.
    const frozenProposals: ProposedAllocation[] = [];
    let frozenStakeUsed = 0n;
    for (const [id, alloc] of currentByDeployment) {
      if (!frozenSet.has(id)) continue;
      const amount = toBigInt(alloc.allocatedTokens);
      frozenStakeUsed += amount;
      // Use the candidate snapshot if we have one — otherwise build a minimal
      // fall-back so the projected APR still reflects the chain state.
      const cand = candidates.find((c) => c.deploymentId === id);
      const projectedAprFraction = cand
        ? calculateApr({
            signal: cand.signalledTokens,
            totalSignal,
            issuancePerYear,
            proposedAllocation: amount,
            otherIndexersAllocation:
              cand.totalStakedTokens - cand.currentAllocation > 0n
                ? cand.totalStakedTokens - cand.currentAllocation
                : 0n,
          })
        : 0;
      frozenProposals.push({
        deploymentId: id,
        allocatedTokens: amount,
        projectedAprFraction,
        rationale: 'frozen — preserved per operator configuration',
      });
    }

    // Available stake = totalStake - frozen stake. Cannot go below 0.
    const availableStake =
      totalStake > frozenStakeUsed ? totalStake - frozenStakeUsed : 0n;
    if (availableStake < toBigInt(config.gasEstimateGrt)) {
      warnings.push(
        'available stake is less than the configured gas budget — no new ' +
          'allocations will be planned',
      );
    }

    // Remove frozen candidates from the optimization pool — they're already
    // accounted for and shouldn't compete for slots.
    const optimizable = candidates.filter((c) => !c.isFrozen);

    // ---------------------------------------------------------------------
    // 4. Optimize: rank by probe APR, then allocate by signal share with
    //    per-deployment and global caps.
    // ---------------------------------------------------------------------
    const newProposals = this.optimize({
      candidates: optimizable,
      config,
      totalStake,
      availableStake,
      totalSignal,
      issuancePerYear,
      frozenSlots: frozenProposals.length,
      warnings,
    });

    const proposedAllocations: ProposedAllocation[] = [
      ...frozenProposals,
      ...newProposals,
    ];

    // ---------------------------------------------------------------------
    // 5. Generate diff actions.
    //
    // `currentByDeployment`, `frozenSet`, and `proposal.deploymentId` are
    // all keyed in Qm canonical form, so the diff joins on `p.deploymentId`
    // directly with no per-entry normalization.
    // ---------------------------------------------------------------------
    const actions = this.diffActions({
      currentByDeployment,
      proposedAllocations,
      frozenSet,
    });

    return {
      state: {
        // totalStake is the indexer's allocation budget (tokenCapacity =
        // self + capped delegation). selfStake / delegatedStake are
        // surfaced separately so operators can see the decomposition.
        totalStake,
        availableStake,
        selfStake,
        delegatedStake,
        activeAllocationCount: activeAllocations.length,
        candidatesConsidered,
        candidatesAfterFilter,
      },
      proposedAllocations,
      actions,
      warnings,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Optimization core
  // -------------------------------------------------------------------------

  /**
   * Iterative-greedy water-filling allocator with cap binding.
   *
   * Replaces the previous rank-by-cap-APR → pick top-K → bisection pipeline.
   * The old pipeline burned slots on fresh D=0 deployments whose rank APR
   * (R/cap) looked attractive but whose realized water-filled contribution
   * was zero, crowding out the operator's saturated currents.
   *
   * Algorithm:
   *   1. Start with allocations = 0 for every candidate.
   *   2. Repeatedly pick the candidate with the highest *marginal* APR at
   *      its current allocation and add a chunk (= availableStake / 1000).
   *      Marginal = d/dA [R × A / (D + A)] = R × D / (D + A)².
   *   3. D=0 candidates have a sentinel marginal-at-zero ("MAX_MARGINAL") so
   *      they win the first slot if free, claim one chunk, then drop to
   *      marginal=0 and are never picked again. This costs one slot for one
   *      chunk — vastly better than burning a slot for a zero-result pick.
   *   4. Whitelisted candidates likewise receive MAX_MARGINAL at A=0 so they
   *      are guaranteed at least one chunk; thereafter they water-fill on
   *      their real marginal alongside everybody else.
   *   5. Stop when budget is exhausted, slots are full, or no candidate has
   *      positive marginal.
   *   6. Gas-floor reflow: after the main loop, identify allocations whose
   *      projected annual reward < 2× gas, zero them out, sum their stake
   *      as a "reflow budget", mark them gas-floor-rejected, and run
   *      iterative-greedy again on the surviving (non-rejected, non-capped)
   *      picks with the recovered budget. Repeat up to GAS_REFLOW_PASSES
   *      passes — usually 1-2 suffice. This prevents the stake that would
   *      otherwise sit idle from being silently under-allocated.
   *
   * Cap binding: each candidate has a per-deployment cap; allocations stop
   * growing past it. Slot binding: a candidate at A=0 cannot start unless
   * there is a free slot (slotsUsed < maxAllocations - frozenSlots).
   *
   * Complexity: O(N × K) BigInt-marginal computations where N = candidates,
   * K = number of chunks allocated (≤ CHUNKS = 1000). For typical mainnet
   * workloads (~300 candidates) this is ~300k BigInt ops — sub-second.
   */
  private optimize(args: {
    candidates: OptimizationCandidate[];
    config: OptimizerConfig;
    totalStake: bigint;
    availableStake: bigint;
    totalSignal: bigint;
    issuancePerYear: bigint;
    frozenSlots: number;
    warnings: string[];
  }): ProposedAllocation[] {
    const {
      candidates,
      config,
      totalStake,
      availableStake,
      totalSignal,
      issuancePerYear,
      frozenSlots,
      warnings,
    } = args;

    if (candidates.length === 0) {
      if (config.whitelist.length === 0) {
        warnings.push('no candidates survived the filter — proposing zero new allocations');
      }
      return [];
    }
    if (totalSignal === 0n || issuancePerYear === 0n) {
      return [];
    }
    if (availableStake === 0n) {
      warnings.push('no stake available for new allocations after frozen reservations');
      return [];
    }

    const remainingSlots = Math.max(0, config.maxAllocations - frozenSlots);
    if (remainingSlots === 0) {
      warnings.push(
        'maxAllocations is fully consumed by frozen allocations — no new slots',
      );
      return [];
    }

    // Build pick state: per-candidate R, D, cap, whitelist flag. R=0 (no
    // signal share — already caught upstream but defensive) candidates are
    // dropped so the marginal-zero loop terminates cleanly.
    const whitelistSet = new Set(config.whitelist);
    interface Pick {
      candidate: OptimizationCandidate;
      /** R_i = (S_i × issuancePerYear) / T, in wei. */
      R: bigint;
      /** D_i = other indexers' stake on this deployment, in wei. */
      D: bigint;
      /** cap_i = per-deployment cap, in wei. */
      cap: bigint;
      whitelisted: boolean;
    }
    const picks: Pick[] = [];
    for (const c of candidates) {
      const R = (c.signalledTokens * issuancePerYear) / totalSignal;
      if (R === 0n) continue;
      const D =
        c.totalStakedTokens - c.currentAllocation > 0n
          ? c.totalStakedTokens - c.currentAllocation
          : 0n;
      const cap = perDeploymentCap(totalStake, c.isRisky, config);
      picks.push({
        candidate: c,
        R,
        D,
        cap,
        whitelisted: whitelistSet.has(c.deploymentId),
      });
    }
    if (picks.length === 0) {
      return [];
    }

    // Iterative-greedy water-filling.
    //
    // Slot accounting: each candidate already holding an on-chain
    // allocation (currentAllocation > 0) is a pre-seating CANDIDATE — it
    // consumes a slot up-front and does not face the slot guard when it
    // claims its first chunk. Rationale: the indexer has already paid the
    // gas cost to open this allocation; the optimizer's job is to size it
    // correctly, not to evict it in favor of a fresh D=0 deployment
    // whose only edge is the MAX_MARGINAL "claim me first" sentinel.
    // Without this pre-seating, a tight maxAllocations (e.g. 15 fresh
    // candidates competing with 1 saturated current for 15 slots) would
    // let the fresh picks consume every slot and leave the current with
    // nothing — exactly the regression the iterative-greedy rewrite is
    // meant to fix.
    //
    // Slot cap enforcement: pre-seating is capped at `remainingSlots`.
    // When the indexer has more current allocations than the cap allows,
    // we rank currents by their marginal APR at their existing allocation
    // level (i.e., what they're actually earning per unit of stake right
    // now) and pre-seat only the top `remainingSlots`. The remaining
    // currents (the slot-overflow) go through the loop with
    // preSeated=false. They can still re-claim a slot if their
    // marginal-at-zero beats the field, but if not they correctly fall
    // out of the proposal and the diff emits unallocate actions — the
    // RIGHT answer when current count exceeds maxAllocations. Without
    // this cap, the optimizer would silently violate the operator's
    // configured `maxAllocations` setting (e.g. 32 currents → 32
    // positive proposals when maxAllocations=15).
    const allocations = new Array<bigint>(picks.length).fill(0n);

    // Score each current by its marginal APR at its existing allocation
    // level. This is the realized economic case for keeping the
    // allocation open as-is: high score = the indexer is currently
    // earning a lot per unit of stake. Non-currents score 0n (they're
    // not pre-seating candidates).
    const marginalAtCurrent: bigint[] = picks.map((p) =>
      p.candidate.currentAllocation > 0n
        ? computeMarginal(p.R, p.D, p.candidate.currentAllocation, false)
        : 0n,
    );

    // Sort currents by marginal-at-current descending; pre-seat top
    // remainingSlots. Ties broken by stable insertion order (no
    // additional tiebreak — the input order from `candidates` is
    // already deterministic upstream).
    const currentsByMarginal: { idx: number; score: bigint }[] = [];
    for (let i = 0; i < picks.length; i++) {
      if (picks[i]!.candidate.currentAllocation > 0n) {
        currentsByMarginal.push({ idx: i, score: marginalAtCurrent[i]! });
      }
    }
    currentsByMarginal.sort((a, b) => {
      if (a.score > b.score) return -1;
      if (a.score < b.score) return 1;
      return a.idx - b.idx;
    });

    const preSeatCap = remainingSlots;
    const preSeated = new Array<boolean>(picks.length).fill(false);
    const preSeatLimit = Math.min(currentsByMarginal.length, preSeatCap);
    for (let k = 0; k < preSeatLimit; k++) {
      preSeated[currentsByMarginal[k]!.idx] = true;
    }
    let slotsUsed = preSeatLimit;

    // Operator UX: warn when current count exceeds the slot cap. The
    // overflow currents will be evaluated for closure, which is correct
    // behavior but surprising if the operator doesn't realize their
    // maxAllocations setting is below the actual current count.
    if (currentsByMarginal.length > preSeatCap) {
      const overflow = currentsByMarginal.length - preSeatCap;
      warnings.push(
        `indexer has ${currentsByMarginal.length} current allocations but maxAllocations=${config.maxAllocations}; ` +
          `the ${overflow} lowest-marginal currents will be evaluated for closure. ` +
          `Increase maxAllocations if you want to keep all of them.`,
      );
    }
    let remaining = availableStake;

    const CHUNKS = 1000n;
    let chunkSize = remaining / CHUNKS;
    if (chunkSize < 1n) chunkSize = 1n;

    // Cap the loop iteration count defensively. With chunkSize ≥ 1 and
    // remaining decreasing by at least chunkSize each iteration (when an
    // allocation is made), this bounds at CHUNKS + |picks| (the +picks for
    // capped iterations where allocAmount < chunkSize).
    const MAX_ITERS = Number(CHUNKS) + picks.length + 1;

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      if (remaining <= 0n) break;
      let bestIdx = -1;
      let bestMarginal = 0n;
      for (let i = 0; i < picks.length; i++) {
        const p = picks[i]!;
        const A = allocations[i]!;
        if (A >= p.cap) continue;
        // Slot guard: a candidate at A=0 would open a new slot UNLESS
        // it's already pre-seated (had a current allocation on-chain).
        if (A === 0n && !preSeated[i] && slotsUsed >= remainingSlots) continue;
        const m = computeMarginal(p.R, p.D, A, p.whitelisted);
        if (m > bestMarginal) {
          bestMarginal = m;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;

      const p = picks[bestIdx]!;
      const A = allocations[bestIdx]!;
      const headroom = p.cap > A ? p.cap - A : 0n;
      let allocAmount = chunkSize < headroom ? chunkSize : headroom;
      if (allocAmount > remaining) allocAmount = remaining;
      if (allocAmount === 0n) {
        // Defensive: should not happen because the headroom and slot
        // guards above would have skipped this pick. Break to avoid an
        // infinite loop if it ever does.
        break;
      }
      // Only brand-new (no current) candidates consume a slot on their
      // first chunk. Pre-seated currents already counted upfront.
      if (A === 0n && !preSeated[bestIdx]) slotsUsed++;
      allocations[bestIdx] = A + allocAmount;
      remaining -= allocAmount;
    }

    // -----------------------------------------------------------------------
    // Gas-floor reflow pass.
    //
    // The previous design dropped any allocation whose projected reward fell
    // below 2× gas and let that stake go idle — silently under-allocating
    // the operator's budget (the user reported up to ~21% idle stake in
    // production runs). Reflow recovers that stake: identify gas-floor
    // skips, zero their allocation, sum the recovered amount as a reflow
    // budget, mark them rejected so they can't re-claim it, and run the
    // same iterative-greedy loop again on survivors (non-rejected,
    // non-capped) with the recovered budget. Repeat until no new skips
    // appear or we hit a defensive iteration cap.
    //
    // Slot guard: the reflow loop does NOT need to re-check slots for
    // already-allocated survivors (they're already inside the plan), and
    // gas-floor-rejected candidates are skipped explicitly. Pre-seated
    // currents that were zeroed by an upstream pass keep their original
    // slot reservation, so reflow can re-fund them if their post-reflow
    // marginal becomes attractive again (it usually won't, but it's
    // correct).
    // -----------------------------------------------------------------------
    const gas = toBigInt(config.gasEstimateGrt);
    const gasFloorRejected = new Array<boolean>(picks.length).fill(false);
    const GAS_REFLOW_PASSES = 5;
    let totalDropped = 0;
    let totalReflowedWei = 0n;
    if (gas > 0n) {
      for (let pass = 0; pass < GAS_REFLOW_PASSES; pass++) {
        let reflowBudget = 0n;
        let droppedThisPass = 0;
        const droppedIds: string[] = [];
        for (let i = 0; i < picks.length; i++) {
          if (gasFloorRejected[i]) continue;
          const amount = allocations[i]!;
          if (amount === 0n) continue;
          const p = picks[i]!;
          const totalAlloc = p.D + amount;
          const projectedRewardWei =
            totalAlloc === 0n ? 0n : (p.R * amount) / totalAlloc;
          if (projectedRewardWei < gas * 2n) {
            reflowBudget += amount;
            allocations[i] = 0n;
            gasFloorRejected[i] = true;
            droppedThisPass++;
            droppedIds.push(p.candidate.deploymentId);
          }
        }
        if (droppedThisPass === 0 || reflowBudget === 0n) break;

        totalDropped += droppedThisPass;
        totalReflowedWei += reflowBudget;
        warnings.push(
          `gas-floor reflow pass ${pass + 1}: dropped ${droppedThisPass} ` +
            `deployment(s) [${droppedIds.join(', ')}] with projected reward ` +
            `< 2× gas budget; redistributing ${(reflowBudget / 10n ** 18n).toString()} GRT ` +
            `to surviving candidates.`,
        );

        // Reflow inner loop: same iterative-greedy selection, but only
        // over non-rejected picks. Reuse the same chunkSize as the main
        // loop so the granularity stays consistent.
        let reflowRemaining = reflowBudget;
        const REFLOW_MAX_ITERS = Number(CHUNKS) + picks.length + 1;
        for (let iter = 0; iter < REFLOW_MAX_ITERS; iter++) {
          if (reflowRemaining <= 0n) break;
          let bestIdx = -1;
          let bestMarginal = 0n;
          for (let i = 0; i < picks.length; i++) {
            if (gasFloorRejected[i]) continue;
            const p = picks[i]!;
            const A = allocations[i]!;
            if (A >= p.cap) continue;
            // Slot guard: reflow only re-uses slots that survivors
            // already occupy. A candidate at A=0 here is either
            //   (a) pre-seated current whose slot is still reserved, or
            //   (b) a brand-new candidate that never won a chunk in the
            //       main loop because the slot cap or marginal-rank
            //       knocked it out.
            // For (b), respect the original slot guard. For (a),
            // pre-seated slot is already counted in slotsUsed.
            if (A === 0n && !preSeated[i] && slotsUsed >= remainingSlots) continue;
            const m = computeMarginal(p.R, p.D, A, p.whitelisted);
            if (m > bestMarginal) {
              bestMarginal = m;
              bestIdx = i;
            }
          }
          if (bestIdx < 0) break;

          const p = picks[bestIdx]!;
          const A = allocations[bestIdx]!;
          const headroom = p.cap > A ? p.cap - A : 0n;
          let allocAmount = chunkSize < headroom ? chunkSize : headroom;
          if (allocAmount > reflowRemaining) allocAmount = reflowRemaining;
          if (allocAmount === 0n) break;
          if (A === 0n && !preSeated[bestIdx]) slotsUsed++;
          allocations[bestIdx] = A + allocAmount;
          reflowRemaining -= allocAmount;
        }
      }
      if (totalDropped > 0) {
        warnings.push(
          `gas-floor reflow summary: ${totalDropped} deployment(s) dropped, ` +
            `${(totalReflowedWei / 10n ** 18n).toString()} GRT reflowed to ` +
            `surviving candidates across ${GAS_REFLOW_PASSES} max passes.`,
        );
      }
    }

    // Build proposals from the final allocations. The reflow loop above
    // already enforced the gas-floor invariant, so we trust allocations[]
    // here and only emit positive entries.
    const proposals: ProposedAllocation[] = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i]!;
      const amount = allocations[i]!;
      if (amount === 0n) continue;
      const cand = p.candidate;

      const projectedAprFraction = calculateApr({
        signal: cand.signalledTokens,
        totalSignal,
        issuancePerYear,
        proposedAllocation: amount,
        otherIndexersAllocation: p.D,
      });

      const atCap = amount >= p.cap;
      const rationale = [
        p.whitelisted ? 'whitelisted' : `iterative-greedy pick #${proposals.length + 1}`,
        cand.isRisky ? 'risky cap applied' : null,
        atCap
          ? `cap-bound at ${shareLabel(p.cap, totalStake)} of total stake`
          : 'iterative-greedy equilibrium (marginal APR equalized)',
      ]
        .filter((s): s is string => Boolean(s))
        .join('; ');

      proposals.push({
        deploymentId: cand.deploymentId,
        allocatedTokens: amount,
        projectedAprFraction,
        rationale,
      });
    }

    return proposals;
  }

  // -------------------------------------------------------------------------
  // Diff: current vs proposed → action queue
  // -------------------------------------------------------------------------

  /**
   * Compute the minimal action set that transforms the current allocation
   * state into the proposed state.
   *
   *   in proposed,   not in current        → allocate
   *   in current,    not in proposed       → unallocate (skip if frozen)
   *   in both, amount differs              → reallocate (skip if frozen)
   *
   * "Frozen" allocations are passed through unchanged: the proposal includes
   * them at their current size so they appear in `proposedAllocations`, but
   * we never emit reallocate/unallocate actions against them.
   */
  private diffActions(args: {
    currentByDeployment: Map<string, Allocation>;
    proposedAllocations: ProposedAllocation[];
    frozenSet: Set<string>;
  }): AgentActionPlan[] {
    const { currentByDeployment, proposedAllocations, frozenSet } = args;

    // Every input here is keyed in Qm canonical form: `currentByDeployment`
    // is built from `normalizeToQm(alloc.subgraphDeployment.id)`,
    // `frozenSet` is built via `normalizeSet`, and the optimizer now emits
    // `proposal.deploymentId` directly in Qm form (see the candidate
    // construction above). So the diff joins on `p.deploymentId` with no
    // per-entry normalization.
    const proposedById = new Map<string, ProposedAllocation>();
    for (const p of proposedAllocations) proposedById.set(p.deploymentId, p);

    const actions: AgentActionPlan[] = [];

    // New / changed allocations.
    for (const p of proposedAllocations) {
      const qm = p.deploymentId;
      if (frozenSet.has(qm)) continue;
      const current = currentByDeployment.get(qm);
      if (!current) {
        if (p.allocatedTokens > 0n) {
          actions.push({
            type: 'allocate',
            deploymentId: p.deploymentId,
            amount: p.allocatedTokens,
            reason: p.rationale,
          });
        }
        continue;
      }
      const currentAmount = toBigInt(current.allocatedTokens);
      if (currentAmount === p.allocatedTokens) continue;
      if (p.allocatedTokens === 0n) {
        actions.push({
          type: 'unallocate',
          deploymentId: p.deploymentId,
          allocationId: current.id,
          reason: 'optimizer dropped deployment from plan',
        });
      } else {
        actions.push({
          type: 'reallocate',
          deploymentId: p.deploymentId,
          allocationId: current.id,
          amount: p.allocatedTokens,
          reason: `resize from ${currentAmount.toString()} to ${p.allocatedTokens.toString()} wei: ${p.rationale}`,
        });
      }
    }

    // Allocations to close (not in proposal at all). `id` is the Qm
    // canonical key and the emitted `deploymentId` stays Qm — consistent
    // with the rest of the MCP surface (graph-node + graphman + indexer-
    // agent all use Qm natively).
    for (const [id, current] of currentByDeployment) {
      if (frozenSet.has(id)) continue;
      if (proposedById.has(id)) continue;
      actions.push({
        type: 'unallocate',
        deploymentId: id,
        allocationId: current.id,
        reason: 'optimizer dropped deployment from plan',
      });
    }

    return actions;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render a signal-share ratio as a short percentage for the rationale. */
function shareLabel(part: bigint, whole: bigint): string {
  if (whole === 0n) return '0%';
  const ratio = bigintRatioToNumber(part * 10_000n, whole);
  return `${(ratio / 100).toFixed(2)}%`;
}

