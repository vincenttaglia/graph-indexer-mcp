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
  totalStake: bigint;
  /** Stake not pinned by frozen allocations — what the optimizer can deploy. */
  availableStake: bigint;
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
 * Newton's-method square root for BigInt. Returns floor(sqrt(n)).
 *
 * Used by the water-filling distribution to invert the closed-form
 *   A_i(λ) = sqrt(R_i × D_i / λ) − D_i
 * at BigInt precision. Number's IEEE 754 sqrt would lose precision for
 * wei-scale inputs (typically 18+ decimal digits past the precision limit
 * of 53-bit mantissa); a converging BigInt sqrt keeps the equilibrium
 * exact to the last wei.
 *
 * Exported for direct unit testing (round-trip on perfect squares,
 * monotonicity).
 */
export function bigIntSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('bigIntSqrt: negative input');
  if (n < 2n) return n;
  // Newton's method. Seed with x = n (upper bound) and iterate
  // y = (x + n/x) / 2 until y >= x — at which point x is floor(sqrt(n)).
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
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
  // conservatively report "not paused" — the surrounding sync/health gate
  // already excludes those candidates, so this only matters for
  // not-yet-synced deployments the operator forced via whitelist.
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
    // `qmToOriginalId` preserves the operator's original ID format so
    // user-facing output (proposedAllocations[].deploymentId,
    // actions[].deploymentId) round-trips back to the form they gave us.
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

    // Build pauseById directly from the indexing-status fetch above —
    // single source of truth, no graphman call. When the status fetch
    // failed entirely, every candidate falls back to `paused = false` so
    // the rest of the run still produces a plan instead of incorrectly
    // excluding everything (the failure is already in `errors`).
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
    // `getDeployment` query accepts either form (and our network-subgraph
    // client passes through), but we pass the operator's original form
    // when possible so the hit/miss diagnostics match what they configured.
    const missingIds = candidateIdList.filter(
      (id) => !signalledById.has(id) && !blacklist.has(id),
    );
    if (missingIds.length > 0) {
      const hydrateResults = await Promise.allSettled(
        missingIds.map((id) =>
          this.deps.networkClient.getDeployment(originalOf(id), sigOpt),
        ),
      );
      for (let i = 0; i < missingIds.length; i++) {
        const id = missingIds[i]!;
        const res = hydrateResults[i]!;
        const displayId = originalOf(id);
        if (res.status === 'fulfilled') {
          if (res.value) {
            signalledById.set(id, res.value);
          } else {
            warnings.push(
              `network.getDeployment("${displayId}") returned null — candidate has ` +
                'no signal/stake data; skipping APR contribution',
            );
          }
        } else {
          errors.push(
            `network.getDeployment("${displayId}") failed: ${errString(res.reason)}`,
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
      const synced = isSyncedAt(status);
      const healthy = isHealthyAt(status);
      const paused = pauseById.get(id) ?? false;

      // Health / sync / pause gates — whitelist does NOT override these; it's
      // unsafe to allocate to a deployment we can't serve.
      if (!synced || !healthy || paused) continue;

      const current = currentByDeployment.get(id);
      const currentAllocation = current ? toBigInt(current.allocatedTokens) : 0n;

      const candidate: OptimizationCandidate = {
        // User-facing field: keep the operator's original ID format so
        // downstream consumers (proposedAllocations, actions, indexer-agent
        // queue) see the same shape the operator gave us. Internal lookups
        // happen against `id` (Qm); only the output is denormalized.
        deploymentId: originalOf(id),
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
    const totalStake = toBigInt(indexer.stakedTokens);
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
    // (currentByDeployment is keyed by Qm); candidate.deploymentId is the
    // operator's original form, so we look the candidate up via the
    // original-id reverse map rather than equality on `id`.
    const frozenProposals: ProposedAllocation[] = [];
    let frozenStakeUsed = 0n;
    for (const [id, alloc] of currentByDeployment) {
      if (!frozenSet.has(id)) continue;
      const amount = toBigInt(alloc.allocatedTokens);
      frozenStakeUsed += amount;
      const original = originalOf(id);
      // Use the candidate snapshot if we have one — otherwise build a minimal
      // fall-back so the projected APR still reflects the chain state.
      const cand = candidates.find((c) => c.deploymentId === original);
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
        deploymentId: original,
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
    // `currentByDeployment` and `frozenSet` are keyed by Qm; the proposal
    // emits `deploymentId` in the operator's original form. Pass the
    // reverse map so diffActions can join on Qm internally while still
    // emitting actions with the original-form id (matching what consumers
    // — indexer-agent queue, action UI — receive elsewhere).
    // ---------------------------------------------------------------------
    const actions = this.diffActions({
      currentByDeployment,
      proposedAllocations,
      frozenSet,
      toQm: normalizeToQm,
      originalOf,
    });

    return {
      state: {
        totalStake,
        availableStake,
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
   * Water-filling allocator with cap binding.
   *
   * Strategy:
   *   1. Rank candidates by APR at the per-deployment cap (saturation-aware
   *      — fresh D=0 deployments don't artificially top the list because
   *      APR = R/cap is the realistic full-allocation yield, not R/probe).
   *      Whitelisted candidates float to the top.
   *   2. Pick top `maxAllocations - frozenSlots` candidates.
   *   3. Bisection-solve for the Lagrange multiplier λ such that the summed
   *      water-filled allocations equal `availableStake`. Each
   *        A_i = max(0, sqrt(R_i × D_i / λ) − D_i)
   *      clamped to [0, cap_i]. This is the canonical marginal-APR-equalizing
   *      distribution that maximizes total annual rewards under the cap
   *      constraint, since
   *        reward_i(A_i) = R_i × A_i / (D_i + A_i)
   *        marginal_i    = R_i × D_i / (D_i + A_i)²
   *      and setting marginal_i = λ across all unbound picks gives the
   *      closed form above.
   *   4. Drop any allocation whose projected annual reward is less than
   *      `2 * gasEstimateGrt`.
   *
   * Fresh deployments (D=0) correctly receive zero water-filled allocation
   * because indexer reward at D=0 is constant in A_i — the indexer already
   * captures 100% of R, and adding stake doesn't increase rewards.
   * Distributing budget to them is a pure loss.
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

    // -- 1. Rank by APR at the per-deployment cap. --
    //
    // Cap-aware ranking is saturation-aware: a fresh D=0 deployment with
    // S=100 ranks by R/cap (e.g. ~10.8% APR) instead of R/probe (~271%
    // with probe=availableStake/100). A saturated D=117k S=2037 ranks by
    // R/(D+cap) ≈ 39.5%, which is the actual yield if we filled the cap.
    // This puts the user's real high-yield current allocations at the top
    // instead of letting fresh-deployment artifacts crowd them out.

    interface Ranked {
      candidate: OptimizationCandidate;
      rankApr: number;
      whitelisted: boolean;
      otherIndexers: bigint;
      /** Cached per-deployment cap so we don't recompute it during sizing. */
      cap: bigint;
    }

    const whitelistSet = new Set(config.whitelist);
    const ranked: Ranked[] = candidates.map((c) => {
      const otherIndexers =
        c.totalStakedTokens - c.currentAllocation > 0n
          ? c.totalStakedTokens - c.currentAllocation
          : 0n;
      const cap = perDeploymentCap(totalStake, c.isRisky, config);
      const rankApr = calculateApr({
        signal: c.signalledTokens,
        totalSignal,
        issuancePerYear,
        proposedAllocation: cap,
        otherIndexersAllocation: otherIndexers,
      });
      return {
        candidate: c,
        rankApr,
        whitelisted: whitelistSet.has(c.deploymentId),
        otherIndexers,
        cap,
      };
    });

    // Whitelisted first, then by descending cap-APR. Tie-break on query
    // volume so we prefer deployments with proven gateway traffic.
    ranked.sort((a, b) => {
      if (a.whitelisted !== b.whitelisted) return a.whitelisted ? -1 : 1;
      if (a.rankApr !== b.rankApr) return b.rankApr - a.rankApr;
      const av = a.candidate.queryVolume30d ?? 0n;
      const bv = b.candidate.queryVolume30d ?? 0n;
      if (av !== bv) return av > bv ? -1 : 1;
      return 0;
    });

    // -- 2. Pick the top `remainingSlots` (with whitelist priority already
    // baked into the ordering). --
    const picks = ranked.slice(0, remainingSlots);

    // -- 3. Bisection water-filling distribution.
    //
    // For each pick precompute R_i = (S_i / T) × issuance, in wei. The
    // water-filling closed form A_i(λ) = sqrt(R_i × D_i / λ) − D_i then
    // gives the allocation that equalizes marginal APR at λ. We bisect λ
    // until summed A_i (clamped to [0, cap_i]) hits availableStake.

    interface Pick {
      ranked: Ranked;
      /** R_i = (S_i × issuancePerYear) / T, in wei. */
      R: bigint;
      /** D_i = other indexers' stake on this deployment, in wei. */
      D: bigint;
      /** cap_i = per-deployment cap, in wei. */
      cap: bigint;
    }

    const pickInputs: Pick[] = picks.map((r) => ({
      ranked: r,
      // (S × issuancePerYear) / T. S and issuancePerYear are wei-scale; T
      // is wei-scale too, so the division gives wei-scale R.
      R: (r.candidate.signalledTokens * issuancePerYear) / totalSignal,
      D: r.otherIndexers,
      cap: r.cap,
    }));

    const amounts = bisectLambda(pickInputs, availableStake);

    const gas = toBigInt(config.gasEstimateGrt);
    const proposals: ProposedAllocation[] = [];
    for (let i = 0; i < pickInputs.length; i++) {
      const p = pickInputs[i]!;
      const amount = amounts[i]!;
      if (amount === 0n) continue; // D=0 (fresh) or bisection assigned zero
      const cand = p.ranked.candidate;

      // Project APR at the actual chosen size.
      const projectedAprFraction = calculateApr({
        signal: cand.signalledTokens,
        totalSignal,
        issuancePerYear,
        proposedAllocation: amount,
        otherIndexersAllocation: p.D,
      });

      // Gas-floor check: skip if projected annual reward < 2× gas (Finding 3).
      // Reward_i(A_i) = R_i × A_i / (D_i + A_i). All BigInt wei.
      const totalAlloc = p.D + amount;
      const projectedRewardWei =
        totalAlloc === 0n ? 0n : (p.R * amount) / totalAlloc;
      if (gas > 0n && projectedRewardWei < gas * 2n) {
        warnings.push(
          `skipped ${cand.deploymentId}: projected annual reward < 2× gas budget`,
        );
        continue;
      }

      const atCap = amount >= p.cap;
      const rationale = [
        p.ranked.whitelisted ? 'whitelisted' : `ranked #${proposals.length + 1} by cap APR`,
        cand.isRisky ? 'risky cap applied' : null,
        atCap
          ? `cap-bound at ${shareLabel(p.cap, totalStake)} of total stake`
          : 'water-filling equilibrium (marginal APR ≈ λ)',
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
    /**
     * Convert a deploymentId (in either canonical encoding) to Qm form for
     * map/set lookups. Internal keys are Qm throughout (see gatherState).
     */
    toQm: (s: string) => string;
    /**
     * Recover the operator's original deployment-id encoding for a given Qm
     * key. Used so emitted actions match the form callers passed in.
     */
    originalOf: (qm: string) => string;
  }): AgentActionPlan[] {
    const { currentByDeployment, proposedAllocations, frozenSet, toQm, originalOf } = args;

    // proposedById is keyed by Qm so the "in current, not in proposed"
    // sweep below can use the Qm key from currentByDeployment without
    // having to denormalize each entry first.
    const proposedById = new Map<string, ProposedAllocation>();
    for (const p of proposedAllocations) proposedById.set(toQm(p.deploymentId), p);

    const actions: AgentActionPlan[] = [];

    // New / changed allocations.
    for (const p of proposedAllocations) {
      const qm = toQm(p.deploymentId);
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

    // Allocations to close (not in proposal at all). `id` here is the Qm
    // canonical key; we emit the original-form id so the action matches
    // what the operator sees in the rest of the report.
    for (const [id, current] of currentByDeployment) {
      if (frozenSet.has(id)) continue;
      if (proposedById.has(id)) continue;
      actions.push({
        type: 'unallocate',
        deploymentId: originalOf(id),
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

// ===========================================================================
// Water-filling
// ===========================================================================

/**
 * A bisection input: per-pick R (reward coefficient = S/T × issuance),
 * D (other-indexers' stake on the deployment), and per-deployment cap.
 */
interface WaterFillPick {
  R: bigint;
  D: bigint;
  cap: bigint;
}

/**
 * Scale factor used to carry λ at sub-wei precision during bisection.
 * λ has units of wei-rewards-per-wei-allocation, which is a dimensionless
 * decimal much smaller than 1. We multiply by 1e18 so bigint arithmetic
 * keeps ~18 fractional digits without underflow.
 */
const LAMBDA_SCALE = 10n ** 18n;

/**
 * Closed-form per-pick allocation for a given λ. For each pick:
 *   A_i(λ) = max(0, sqrt(R_i × D_i / λ) − D_i), clamped to [0, cap_i].
 *
 * Fresh deployments (D_i = 0) get zero by construction: indexer reward
 * R_i × A_i / (D_i + A_i) = R_i when D_i = 0, independent of A_i — adding
 * stake doesn't increase the reward, so water-filling correctly skips them.
 */
function allocationAtLambda(picks: WaterFillPick[], lambdaScaled: bigint): bigint[] {
  return picks.map(({ R, D, cap }) => {
    if (D === 0n || R === 0n || lambdaScaled <= 0n) return 0n;
    // A_i = sqrt(R × D × LAMBDA_SCALE / lambdaScaled) − D
    const numer = R * D * LAMBDA_SCALE;
    const radicand = numer / lambdaScaled;
    const sqrtVal = bigIntSqrt(radicand);
    const Ai = sqrtVal > D ? sqrtVal - D : 0n;
    return Ai > cap ? cap : Ai;
  });
}

function totalAllocatedAtLambda(picks: WaterFillPick[], lambdaScaled: bigint): bigint {
  let sum = 0n;
  for (const a of allocationAtLambda(picks, lambdaScaled)) sum += a;
  return sum;
}

/**
 * Bisect λ until summed water-filled allocations equal availableStake.
 * Higher λ → tighter constraint → smaller allocations.
 * Lower  λ → looser constraint  → larger allocations.
 *
 * Bracket [1, hi] where hi is the max marginal-at-zero across picks
 * (R_i × LAMBDA_SCALE / D_i for picks with D_i > 0). At λ ≥ hi every
 * unclamped A_i is 0; at λ → 0 every A_i → cap. The total is monotonic
 * non-increasing in λ, so bisection converges.
 *
 * Returns the per-pick allocations at the final λ. If the picks' capped
 * sum is itself less than availableStake, the function returns the all-cap
 * vector (the caps are the binding constraint, not λ).
 */
export function bisectLambda(picks: WaterFillPick[], availableStake: bigint): bigint[] {
  if (picks.length === 0) return [];

  // Edge: every pick has D=0 (all fresh) → every A_i = 0 regardless of λ.
  // Return zeros directly; bisection would degenerate otherwise.
  let anyD = false;
  for (const p of picks) {
    if (p.D > 0n && p.R > 0n) {
      anyD = true;
      break;
    }
  }
  if (!anyD) return picks.map(() => 0n);

  // If the all-cap total (over D>0 picks only) fits in availableStake, the
  // caps are the binding constraint for those picks — λ → 0 and each D>0
  // pick gets its cap. D=0 picks always stay at zero (water-filling math:
  // their reward doesn't depend on A_i, so allocating to them is a pure
  // loss versus any other use of the budget — including leaving it idle).
  let effectiveCapsSum = 0n;
  for (const p of picks) {
    if (p.D > 0n && p.R > 0n) effectiveCapsSum += p.cap;
  }
  if (effectiveCapsSum <= availableStake) {
    return picks.map((p) => (p.D > 0n && p.R > 0n ? p.cap : 0n));
  }

  // Upper bound for λ: at this value every (unclamped) A_i is exactly 0,
  // because sqrt(R × D × LAMBDA_SCALE / hi) = D. Above this λ the sum is
  // strictly 0, so the answer is bracketed at or below hi.
  let hi = 1n;
  for (const { R, D } of picks) {
    if (D > 0n && R > 0n) {
      // marginal-at-zero = R / D, scaled.
      const marginalAtZeroScaled = (R * LAMBDA_SCALE) / D;
      if (marginalAtZeroScaled > hi) hi = marginalAtZeroScaled;
    }
  }
  let lo = 1n;

  // 80 iterations of bisection over a ~10^36-wide bracket gives ~10^-24
  // precision on the BigInt λ — far more than needed for wei-scale outputs.
  for (let i = 0; i < 80; i++) {
    if (hi - lo < 2n) break;
    const mid = (lo + hi) / 2n;
    const total = totalAllocatedAtLambda(picks, mid);
    if (total > availableStake) {
      // Allocations too large — need tighter λ.
      lo = mid + 1n;
    } else {
      // Allocations fit — try a looser λ to see if we can give more.
      hi = mid;
    }
  }

  return allocationAtLambda(picks, hi);
}
