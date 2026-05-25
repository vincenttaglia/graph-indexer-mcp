/**
 * DiscoveryEngine — implements the §4.3 cleanup + discovery workflow.
 *
 * Two-pronged operation:
 *
 *   1. Cleanup half: walk every deployment graph-node knows about and flag
 *      ones that are no longer useful (no curation signal, unallocated and
 *      not on the whitelist, superseded by a newer subgraph version, or
 *      orphaned/paused). For each stale deployment, emit an ordered
 *      `CleanupAction.steps` plan (close_allocation → pause → unassign →
 *      unused_record → unused_remove). `drop_deployment` is intentionally
 *      NEVER auto-suggested — it's irreversible.
 *
 *   2. Discovery half: walk every well-signalled deployment the indexer is
 *      not currently allocated to or syncing. Gather supporting data
 *      (queryVolume30d, indexerCount, totalStake, entityCount, chain). Score
 *      each candidate using the §4.3 formula:
 *
 *         score = aprScore*0.4 + volumeScore*0.3 + signalScore*0.2 - costScore*0.1
 *
 *      Each component is normalized to [0..1] across the candidate set. Top
 *      N (`maxCandidates ?? 10`) by score get an `offchain` indexing-rule
 *      recommendation so the indexer can start syncing without committing
 *      to an allocation — the optimizer makes that call later.
 *
 * The service NEVER mutates anything. It produces a `DiscoveryResult` plan;
 * the composite tool wrapper executes individual steps only after operator
 * confirmation.
 *
 * Best-effort by design: if QoS or postgres errors, the service continues
 * without that data and records the failure in `errors`/`warnings`. Only a
 * fatal network-subgraph error short-circuits the run.
 */

import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { QosSubgraphClient } from '../clients/qos-subgraph.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { PostgresClient } from '../clients/postgres.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { IndexerAgentClient } from '../clients/indexer-agent.js';
import type {
  Allocation,
  GraphNetwork,
  SubgraphDeployment,
} from '../types/network.js';
import type { DeploymentInfo } from '../types/graphman.js';
import type { SubgraphIndexingStatus } from '../types/graphnode.js';

// =============================================================================
// Public types
// =============================================================================

export interface StaleDeployment {
  deploymentId: string;
  reason: 'no_signal' | 'unallocated' | 'superseded' | 'orphaned';
  /** Disk size if known (postgres available). */
  sizeBytes: bigint | null;
  /** Whether this is currently paused. */
  paused: boolean;
  /** Whether the indexer has any allocation on it. */
  hasAllocation: boolean;
  /** Whether it's on the frozen list (operator override — skip cleanup). */
  isFrozen: boolean;
}

export interface CleanupAction {
  deploymentId: string;
  /** Ordered sequence: close → pause → unassign → unused_record → unused_remove. */
  steps: Array<
    | 'close_allocation'
    | 'pause'
    | 'unassign'
    | 'unused_record'
    | 'unused_remove'
  >;
  rationale: string;
}

export interface Opportunity {
  deploymentId: string;
  signalledTokens: bigint;
  totalStakedTokens: bigint; // total across all indexers
  indexerCount: number; // how many indexers already on it
  queryVolume30d: bigint | null; // null if QoS unavailable or no data
  entityCount: bigint | null; // proxy for sync cost
  chain: string | null;
}

export interface ScoredOpportunity extends Opportunity {
  /** Per §4.3 scoring formula. */
  score: number;
  /** Components for transparency. */
  components: {
    aprScore: number; // normalized 0..1
    volumeScore: number; // normalized 0..1
    signalScore: number; // normalized 0..1
    costScore: number; // normalized 0..1 (cost is subtracted)
  };
  /** Projected APR if allocated at typical size. */
  projectedAprFraction: number;
}

export interface DiscoveryConfig {
  indexerAddress: string;
  minSignal: bigint;
  /** Used for APR projection (e.g., totalStake / maxAllocations). */
  typicalAllocationGrt: bigint;
  blocksPerYear: number;
  whitelist: string[];
  blacklist: string[];
  frozenlist: string[];
  /** Top-N to return / generate rules for. Default 10. */
  maxCandidates?: number;
}

export interface DiscoveryResult {
  stale: StaleDeployment[];
  cleanup: CleanupAction[];
  opportunities: ScoredOpportunity[];
  /** Suggested indexing rules to add for top scored opportunities. */
  ruleRecommendations: Array<{
    deploymentId: string;
    decisionBasis: 'rules' | 'always' | 'never' | 'offchain';
    /** Wei BigInt-as-string. */
    allocationAmount: string;
    rationale: string;
  }>;
  warnings: string[];
  errors: string[];
}

export interface DiscoveryEngineDeps {
  networkClient: NetworkSubgraphClient;
  qosClient: QosSubgraphClient;
  graphNodeClient: GraphNodeClient;
  /** Optional — when null, on-disk size enrichment is skipped. */
  postgresClient: PostgresClient | null;
  graphmanClient: GraphmanClient;
  agentClient: IndexerAgentClient;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CANDIDATES = 10;

/** Concurrency cap for per-deployment fan-outs (graphman info, allocations, etc.). */
const FANOUT_CONCURRENCY = 8;

// =============================================================================
// Implementation
// =============================================================================

export class DiscoveryEngine {
  constructor(private readonly deps: DiscoveryEngineDeps) {}

  async run(
    config: DiscoveryConfig,
    opts?: { signal?: AbortSignal },
  ): Promise<DiscoveryResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    const lowerAddr = config.indexerAddress.toLowerCase();
    const whitelist = new Set(config.whitelist.map((s) => s.toLowerCase()));
    const blacklist = new Set(config.blacklist.map((s) => s.toLowerCase()));
    const frozenlist = new Set(config.frozenlist.map((s) => s.toLowerCase()));

    throwIfAborted(opts?.signal);

    // ------------------------------------------------------------------------
    // Fetch the foundational state in parallel. Network subgraph failures are
    // fatal (everything downstream depends on signalled-deployments and
    // active-allocation joins). Graph-node / agent failures degrade gracefully.
    // ------------------------------------------------------------------------
    let signalledPage;
    let activeAllocations: Allocation[] = [];
    let networkParams: GraphNetwork | null = null;
    let indexingStatuses: SubgraphIndexingStatus[] = [];

    try {
      const [sig, alloc, net] = await Promise.all([
        this.deps.networkClient.getSignalledDeployments(config.minSignal.toString()),
        this.deps.networkClient.getActiveAllocations(lowerAddr),
        this.deps.networkClient.getNetworkParameters(),
      ]);
      signalledPage = sig;
      activeAllocations = alloc.items;
      networkParams = net;
      if (sig.truncated) {
        warnings.push(
          `network subgraph: signalled-deployment query was truncated; ` +
            `discovery considers only the first page (likely 20k rows).`,
        );
      }
      if (alloc.truncated) {
        warnings.push(
          `network subgraph: indexer's active-allocation query was truncated; ` +
            `cleanup classification may miss some allocations.`,
        );
      }
    } catch (err) {
      errors.push(`network subgraph fatal: ${describeError(err)}`);
      return {
        stale: [],
        cleanup: [],
        opportunities: [],
        ruleRecommendations: [],
        warnings,
        errors,
      };
    }

    throwIfAborted(opts?.signal);

    try {
      indexingStatuses = await this.deps.graphNodeClient.getIndexingStatuses();
    } catch (err) {
      warnings.push(
        `graph-node: getIndexingStatuses failed (${describeError(err)}); ` +
          `cleanup half will operate without local sync state.`,
      );
    }

    throwIfAborted(opts?.signal);

    const signalledIds = new Set(signalledPage.items.map((d) => d.id));
    const signalledById = new Map<string, SubgraphDeployment>(
      signalledPage.items.map((d) => [d.id, d]),
    );
    const allocatedDeploymentIds = new Set(
      activeAllocations.map((a) => a.subgraphDeployment.id),
    );
    const syncingIds = new Set(indexingStatuses.map((s) => s.subgraph));

    // ------------------------------------------------------------------------
    // CLEANUP HALF
    // ------------------------------------------------------------------------
    const { stale, cleanup } = await this.runCleanup({
      indexingStatuses,
      signalledIds,
      allocatedDeploymentIds,
      frozenlist,
      whitelist,
      warnings,
      errors,
      signal: opts?.signal,
    });

    throwIfAborted(opts?.signal);

    // ------------------------------------------------------------------------
    // DISCOVERY HALF
    // ------------------------------------------------------------------------
    const { opportunities, ruleRecommendations } = await this.runDiscovery({
      config,
      signalled: signalledPage.items,
      signalledById,
      allocatedDeploymentIds,
      syncingIds,
      blacklist,
      whitelist,
      networkParams,
      warnings,
      errors,
      signal: opts?.signal,
    });

    return {
      stale,
      cleanup,
      opportunities,
      ruleRecommendations,
      warnings,
      errors,
    };
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  private async runCleanup(args: {
    indexingStatuses: SubgraphIndexingStatus[];
    signalledIds: Set<string>;
    allocatedDeploymentIds: Set<string>;
    frozenlist: Set<string>;
    whitelist: Set<string>;
    warnings: string[];
    errors: string[];
    signal: AbortSignal | undefined;
  }): Promise<{ stale: StaleDeployment[]; cleanup: CleanupAction[] }> {
    const {
      indexingStatuses,
      signalledIds,
      allocatedDeploymentIds,
      frozenlist,
      whitelist,
      warnings,
      errors,
      signal,
    } = args;

    if (indexingStatuses.length === 0) {
      return { stale: [], cleanup: [] };
    }

    // Best-effort: fetch the full deployment size catalog up-front so we don't
    // hit postgres once per stale deployment. Postgres is optional.
    const sizesById = new Map<string, bigint>();
    if (this.deps.postgresClient) {
      try {
        const sizes = await this.deps.postgresClient.getAllSubgraphSizes();
        for (const s of sizes) {
          sizesById.set(s.deploymentId, BigInt(s.sizeBytes));
        }
      } catch (err) {
        warnings.push(
          `postgres: getAllSubgraphSizes failed (${describeError(err)}); ` +
            `disk-size enrichment skipped for cleanup.`,
        );
      }
    }

    throwIfAborted(signal);

    // Best-effort: fetch graphman deployment info for the synced set (so we
    // know pause/assignment state). Concurrency-capped to avoid hammering
    // graphman with a request per deployment.
    const infoById = new Map<string, DeploymentInfo>();
    // TODO(signal): thread AbortSignal through client methods when Stage 0
    // polish lands. Today aborts are bounded between items via
    // `throwIfAborted`, not in-flight client calls.
    await mapPool(
      indexingStatuses,
      FANOUT_CONCURRENCY,
      async (status) => {
        throwIfAborted(signal);
        try {
          const info = await this.deps.graphmanClient.getDeploymentInfo(status.subgraph);
          infoById.set(status.subgraph, info);
        } catch (err) {
          // Per-deployment failures aren't fatal; we just lose pause/node
          // state for that one. Record one warning per first occurrence.
          if (infoById.size === 0 && !warnings.some((w) => w.startsWith('graphman:'))) {
            warnings.push(
              `graphman: getDeploymentInfo failed for at least one deployment ` +
                `(${describeError(err)}); cleanup pause/assignment state may be incomplete.`,
            );
          }
        }
      },
    );

    throwIfAborted(signal);

    // Best-effort: subgraph→deployment relationship for `superseded` detection.
    // The current network-subgraph client has no batch lookup (Subgraph by
    // deployment id), so this is a known gap — see the design note at the
    // bottom of this method. We document it once in `warnings` rather than
    // attempting unreliable heuristics.
    let supersededSupported = false;
    if (!supersededSupported) {
      warnings.push(
        `superseded detection is not yet implemented: the network-subgraph ` +
          `client doesn't expose a Subgraph→deployment lookup, so we cannot ` +
          `reliably classify deployments as deprecated by a newer version.`,
      );
    }

    const stale: StaleDeployment[] = [];
    const cleanup: CleanupAction[] = [];

    for (const status of indexingStatuses) {
      const deploymentId = status.subgraph;
      const idLower = deploymentId.toLowerCase();

      const info = infoById.get(deploymentId);
      const paused = info?.paused ?? false;
      // graph-node lacks an "assigned node" view; use graphman's `node` field
      // when present. Treat empty / `removed` as unassigned.
      const node = info?.node;
      const unassigned = info ? !node || node === 'removed' : false;
      const hasAllocation = allocatedDeploymentIds.has(deploymentId);
      const hasSignal = signalledIds.has(deploymentId);
      const isFrozen = frozenlist.has(idLower);
      const isWhitelisted = whitelist.has(idLower);

      // Skip the whole sync state — graph-node is still pulling a fresh
      // deployment and we shouldn't propose tearing it down mid-flight.
      if (!status.synced) continue;

      // Classify. First match wins; ordering reflects priority (no signal is
      // the most actionable; orphaned trumps unallocated since it's
      // infrastructure-level).
      //
      // `orphaned` requires conjunctive evidence — a deployment that is
      // *only* paused (with no other corroborating signal) might be a
      // deliberate maintenance pause and must NOT be proposed for cleanup.
      // Stronger evidence:
      //   - unassigned (no node assigned by graphman), OR
      //   - paused AND (no allocation AND no signal) — i.e. paused on
      //     something the indexer has no remaining stake in.
      // graphman exposes `node` on DeploymentInfo, so `unassigned` is a
      // reliable signal when info was fetched. When info is missing we err
      // on the safe side: `unassigned` is false, so a deployment we only
      // know is paused won't be flagged unless allocation+signal also went
      // away.
      let reason: StaleDeployment['reason'] | null = null;
      if (unassigned) {
        reason = 'orphaned';
      } else if (paused && !hasAllocation && !hasSignal) {
        reason = 'orphaned';
      } else if (paused) {
        // Paused alone is not enough. Surface a warning so operators can
        // decide manually, but never auto-propose cleanup.
        warnings.push(
          `deployment ${deploymentId} is paused but still has ` +
            `${hasAllocation ? 'an active allocation' : 'no allocation'} ` +
            `and ${hasSignal ? 'curation signal' : 'no signal'}; ` +
            `treating as deliberate maintenance — skipping cleanup.`,
        );
        continue;
      } else if (!hasSignal) {
        reason = 'no_signal';
      } else if (!hasAllocation && !isWhitelisted) {
        reason = 'unallocated';
      }
      // 'superseded' is left out until the subgraph-version lookup lands.

      if (!reason) continue;

      const sizeBytes = sizesById.get(deploymentId) ?? null;
      stale.push({
        deploymentId,
        reason,
        sizeBytes,
        paused,
        hasAllocation,
        isFrozen,
      });

      if (isFrozen) {
        warnings.push(
          `frozen deployment ${deploymentId}: classified ${reason} but ` +
            `skipping cleanup per operator override.`,
        );
        continue;
      }

      cleanup.push(this.buildCleanupAction({ deploymentId, reason, hasAllocation, paused }));
    }

    // Surface a warning if we somehow assembled no cleanup actions despite
    // finding stale deployments — usually means every stale entry is frozen.
    if (stale.length > 0 && cleanup.length === 0) {
      warnings.push(
        `found ${stale.length} stale deployment(s) but produced no cleanup ` +
          `actions — all are frozen or otherwise excluded.`,
      );
    }

    // Silence unused-binding noise from the strict TS config.
    void errors;

    return { stale, cleanup };
  }

  /**
   * Assemble the canonical cleanup step ordering per §4.3:
   *   close_allocation → pause → unassign → unused_record → unused_remove
   *
   *   - `close_allocation` is only included when the indexer still has an
   *     allocation; it must be retired before infrastructure-level cleanup.
   *     The actual close is queued via the optimizer/health flow, not this
   *     service. We include the step so the composite tool can sequence it.
   *   - `pause` is skipped when the deployment is already paused.
   *   - `unassign` always runs (idempotent at graphman level).
   *   - `unused_record` + `unused_remove` reclaim disk after the node is
   *     no longer writing to the schema.
   *   - `drop` is INTENTIONALLY OMITTED — it deletes the entire database
   *     namespace and the operator should invoke it manually if they really
   *     want the bytes gone forever.
   */
  private buildCleanupAction(opts: {
    deploymentId: string;
    reason: StaleDeployment['reason'];
    hasAllocation: boolean;
    paused: boolean;
  }): CleanupAction {
    const steps: CleanupAction['steps'] = [];
    if (opts.hasAllocation) steps.push('close_allocation');
    if (!opts.paused) steps.push('pause');
    steps.push('unassign', 'unused_record', 'unused_remove');

    return {
      deploymentId: opts.deploymentId,
      steps,
      rationale: this.cleanupRationale(opts),
    };
  }

  private cleanupRationale(opts: {
    reason: StaleDeployment['reason'];
    hasAllocation: boolean;
    paused: boolean;
  }): string {
    const head = (() => {
      switch (opts.reason) {
        case 'no_signal':
          return 'deployment has no curation signal — not earning indexing rewards';
        case 'unallocated':
          return 'synced but unallocated and not on the whitelist — no protocol use';
        case 'superseded':
          return 'a newer version of this subgraph is deployed';
        case 'orphaned':
          return opts.paused
            ? 'deployment is paused and not generating rewards'
            : 'deployment is unassigned from any indexing node';
      }
    })();
    const closeNote = opts.hasAllocation
      ? ' close the open allocation before infrastructure teardown.'
      : '';
    return `${head};${closeNote} reclaim disk via pause→unassign→unused record/remove.`;
  }

  // ===========================================================================
  // DISCOVERY
  // ===========================================================================

  private async runDiscovery(args: {
    config: DiscoveryConfig;
    signalled: SubgraphDeployment[];
    signalledById: Map<string, SubgraphDeployment>;
    allocatedDeploymentIds: Set<string>;
    syncingIds: Set<string>;
    blacklist: Set<string>;
    whitelist: Set<string>;
    networkParams: GraphNetwork | null;
    warnings: string[];
    errors: string[];
    signal: AbortSignal | undefined;
  }): Promise<{
    opportunities: ScoredOpportunity[];
    ruleRecommendations: DiscoveryResult['ruleRecommendations'];
  }> {
    const {
      config,
      signalled,
      allocatedDeploymentIds,
      syncingIds,
      blacklist,
      whitelist,
      networkParams,
      warnings,
      errors,
      signal,
    } = args;

    // ------------------------------------------------------------------------
    // Filter candidates: drop already-allocated, already-syncing, rewards-
    // denied, and blacklisted.
    //
    // Blacklist is a *hard* deny — whitelist never overrides it. Whitelist's
    // only role downstream is to bypass the minimum-signal floor; it must
    // never resurrect a deployment the operator has explicitly forbidden.
    //
    // Rewards-denied deployments (`deniedAt !== 0`) earn zero indexing
    // rewards on-chain regardless of signal/volume, so promoting them via an
    // `offchain` rule would tie up sync resources for no reward. Filter them
    // out unconditionally and surface an aggregate warning.
    // ------------------------------------------------------------------------
    const candidates: SubgraphDeployment[] = [];
    let deniedDropped = 0;
    for (const dep of signalled) {
      if (allocatedDeploymentIds.has(dep.id)) continue;
      if (syncingIds.has(dep.id)) continue;
      const idLower = dep.id.toLowerCase();
      if (blacklist.has(idLower)) continue;
      // `deniedAt` is typed `number` per the network-subgraph schema but the
      // GraphQL endpoint occasionally returns it as a string. Normalize via
      // `Number(...)` so `'0'` is treated identically to `0`.
      const deniedAtNum = Number(dep.deniedAt ?? 0);
      if (Number.isFinite(deniedAtNum) && deniedAtNum !== 0) {
        deniedDropped++;
        continue;
      }
      candidates.push(dep);
    }

    if (deniedDropped > 0) {
      warnings.push(
        `${deniedDropped} signalled deployment(s) skipped because rewards ` +
          `are denied (deniedAt !== 0); they would earn zero indexing rewards.`,
      );
    }

    if (candidates.length === 0) {
      return { opportunities: [], ruleRecommendations: [] };
    }

    // ------------------------------------------------------------------------
    // Fetch 30-day query volume in a single QoS call (degrade gracefully).
    // ------------------------------------------------------------------------
    const queryVolumeById = new Map<string, bigint>();
    try {
      const volumes = await this.deps.qosClient.getQueryVolume({
        timeRange: { days: 30 },
      });
      for (const v of volumes) {
        if (v.deployment_id) {
          // `| 0` would truncate to a signed int32 (~2.1B max). Real-world
          // 30-day query counts on top deployments exceed that comfortably,
          // so use BigInt directly. `query_count` is typed `number` in the
          // QoS client; guard against NaN / Infinity / negatives.
          const n = Number(v.query_count);
          const safe = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
          queryVolumeById.set(v.deployment_id, BigInt(safe));
        }
      }
    } catch (err) {
      warnings.push(
        `qos: 30-day query volume fetch failed (${describeError(err)}); ` +
          `volumeScore will be zero for all candidates.`,
      );
    }

    throwIfAborted(signal);

    // ------------------------------------------------------------------------
    // Per-candidate enrichment: total stake, indexer count, entity count, chain.
    // Use Promise.allSettled inside a concurrency pool — one slow deployment
    // shouldn't block the rest.
    // ------------------------------------------------------------------------
    const opportunities: Opportunity[] = [];

    // TODO(signal): thread AbortSignal through client methods when Stage 0
    // polish lands. Today aborts are bounded between items via
    // `throwIfAborted`, not in-flight client calls.
    await mapPool(candidates, FANOUT_CONCURRENCY, async (dep) => {
      throwIfAborted(signal);

      let totalStakedTokens = 0n;
      let indexerCount = 0;
      try {
        const allocs = await this.deps.networkClient.getDeploymentAllocations(dep.id);
        const uniqueIndexers = new Set<string>();
        for (const a of allocs.items) {
          totalStakedTokens += safeBigInt(a.allocatedTokens);
          uniqueIndexers.add(a.indexer.id.toLowerCase());
        }
        indexerCount = uniqueIndexers.size;
      } catch (err) {
        warnings.push(
          `network subgraph: getDeploymentAllocations(${dep.id}) failed ` +
            `(${describeError(err)}); totalStake / indexerCount default to 0.`,
        );
      }

      const queryVolume30d = queryVolumeById.has(dep.id)
        ? (queryVolumeById.get(dep.id) ?? null)
        : null;

      // entityCount: best-effort. graph-node returns null when the
      // deployment isn't synced locally, which is expected for discovery
      // candidates. We surface that as `null` — costScore falls back to
      // signalledTokens as a coarse proxy in the normalizer.
      let entityCount: bigint | null = null;
      try {
        const ec = await this.deps.graphNodeClient.getEntityCount(dep.id);
        if (ec !== null) entityCount = safeBigInt(ec);
      } catch {
        // Swallow — entity count is a `nice to have`. Don't pollute warnings
        // with one entry per candidate.
      }

      // Chain: not currently surfaced on `SubgraphDeployment`. Best-effort
      // lookup via graphman info (only present for deployments graph-node
      // knows about — usually candidates aren't synced, so this is null).
      let chain: string | null = null;
      try {
        const info = await this.deps.graphmanClient.getDeploymentInfo(dep.id);
        chain = info.chain ?? null;
      } catch {
        // Expected: graphman often returns 404 for unknown deployments.
      }

      opportunities.push({
        deploymentId: dep.id,
        signalledTokens: safeBigInt(dep.signalledTokens),
        totalStakedTokens,
        indexerCount,
        queryVolume30d,
        entityCount,
        chain,
      });
    });

    if (opportunities.length === 0) {
      return { opportunities: [], ruleRecommendations: [] };
    }

    // ------------------------------------------------------------------------
    // Project APR and compute normalized scoring components.
    // ------------------------------------------------------------------------
    const aprByDeployment = new Map<string, number>();
    for (const opp of opportunities) {
      const apr = networkParams
        ? projectApr({
            signal: opp.signalledTokens,
            totalSignal: safeBigInt(networkParams.totalTokensSignalled),
            issuancePerBlock: safeBigInt(networkParams.networkGRTIssuancePerBlock),
            blocksPerYear: config.blocksPerYear,
            existingAllocation: opp.totalStakedTokens,
            typicalAllocation: config.typicalAllocationGrt,
          })
        : 0;
      aprByDeployment.set(opp.deploymentId, apr);
    }

    if (!networkParams) {
      warnings.push(
        `network parameters unavailable; projected APR defaulted to 0 for all candidates.`,
      );
    }

    const aprValues = opportunities.map(
      (o) => aprByDeployment.get(o.deploymentId) ?? 0,
    );
    const volumeValues = opportunities.map((o) =>
      bigIntToNumber(o.queryVolume30d ?? 0n),
    );
    const signalValues = opportunities.map((o) => bigIntToNumber(o.signalledTokens));
    // Cost: prefer entityCount. When a candidate has no entityCount (the
    // common case — discovery candidates aren't synced locally yet) we use
    // the median of the *known* entityCounts as a neutral proxy. This
    // preserves the dimensional correctness of the cost component (it
    // represents indexing/storage cost, not curation signal) and avoids
    // double-counting signal weight via the old fallback to signalledTokens.
    //
    // Known limitation: until Stage 4 caches entity counts at the network
    // level, candidates without local sync state get a flat median cost,
    // which slightly compresses the cost dimension. See `warnings` below.
    const knownEntityCounts = opportunities
      .map((o) => o.entityCount)
      .filter((c): c is bigint => c !== null)
      .map((c) => bigIntToNumber(c))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    const medianCost =
      knownEntityCounts.length === 0
        ? 0
        : (knownEntityCounts[Math.floor(knownEntityCounts.length / 2)] ?? 0);
    const missingEntityCount = opportunities.filter((o) => o.entityCount === null).length;
    if (missingEntityCount > 0) {
      warnings.push(
        `${missingEntityCount} candidate(s) have no local entity count; ` +
          `using median (${medianCost.toFixed(0)}) of ${knownEntityCounts.length} ` +
          `known candidate(s) as a neutral cost proxy. Pending Stage 4 caching ` +
          `of entity counts at the network level.`,
      );
    }
    const costValues = opportunities.map((o) =>
      o.entityCount !== null ? bigIntToNumber(o.entityCount) : medianCost,
    );

    const aprMax = Math.max(...aprValues, 0);
    const volumeMax = Math.max(...volumeValues, 0);
    const signalMax = Math.max(...signalValues, 0);
    const costMax = Math.max(...costValues, 0);

    const normalize = (v: number, max: number): number =>
      max <= 0 || !Number.isFinite(v) ? 0 : Math.max(0, Math.min(1, v / max));

    const scored: ScoredOpportunity[] = opportunities.map((opp, i) => {
      const aprScore = normalize(aprValues[i] ?? 0, aprMax);
      const volumeScore = normalize(volumeValues[i] ?? 0, volumeMax);
      const signalScore = normalize(signalValues[i] ?? 0, signalMax);
      const costScore = normalize(costValues[i] ?? 0, costMax);
      const score =
        aprScore * 0.4 + volumeScore * 0.3 + signalScore * 0.2 - costScore * 0.1;
      return {
        ...opp,
        score,
        components: { aprScore, volumeScore, signalScore, costScore },
        projectedAprFraction: aprValues[i] ?? 0,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const max = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const top = scored.slice(0, max);

    // ------------------------------------------------------------------------
    // Recommend offchain indexing rules — start syncing, don't allocate yet.
    // The optimizer decides whether/how much to allocate after the deployment
    // catches up.
    // ------------------------------------------------------------------------
    const ruleRecommendations: DiscoveryResult['ruleRecommendations'] = top.map(
      (opp) => ({
        deploymentId: opp.deploymentId,
        decisionBasis: 'offchain' as const,
        allocationAmount: config.typicalAllocationGrt.toString(),
        rationale:
          `score=${opp.score.toFixed(4)} ` +
          `(apr=${opp.components.aprScore.toFixed(3)}, ` +
          `vol=${opp.components.volumeScore.toFixed(3)}, ` +
          `sig=${opp.components.signalScore.toFixed(3)}, ` +
          `cost=${opp.components.costScore.toFixed(3)}); ` +
          `projected APR ${(opp.projectedAprFraction * 100).toFixed(2)}% at typical size. ` +
          `Start syncing offchain; allocate after the deployment is healthy.`,
      }),
    );

    void errors;
    return { opportunities: top, ruleRecommendations };
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // Node's idiom — preserves abort semantics for callers using AbortController.
    throw new Error('DiscoveryEngine.run aborted');
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function safeBigInt(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.trunc(v));
  }
  // String — strip decimals if present (the network subgraph occasionally
  // returns scientific notation in error responses).
  try {
    const trimmed = v.split('.')[0] ?? '0';
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

/**
 * Convert a BigInt to a Number for normalization. Values above
 * `Number.MAX_SAFE_INTEGER` (≈9.0e15) lose integer precision in JS — wei-
 * scale values (1e28) divided by a single 1e9 still land around 1e19, well
 * above safe-int range, which silently corrupts ordering.
 *
 * Iteratively divide by 10 in BigInt-space until the magnitude is within
 * safe-int range, then reapply the scale in floating-point. This keeps the
 * top ~15 significant digits exact and the overall magnitude correct —
 * sufficient for the [0..1] normalization callers do downstream.
 */
function bigIntToNumber(v: bigint): number {
  const negative = v < 0n;
  let scaled = negative ? -v : v;
  let shift = 0;
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  while (scaled > MAX) {
    scaled /= 10n;
    shift++;
  }
  const n = Number(scaled) * Math.pow(10, shift);
  return negative ? -n : n;
}

/**
 * Project annual APR for an additional allocation of `typicalAllocation` on a
 * deployment with the given signal share, per §3.1 (APR Calculation) of the
 * implementation plan.
 *
 *   reward_share = (S / T) * (issuance_per_block * blocksPerYear)
 *                          * (A_typical / (A_existing + A_typical))
 *   apr = reward_share / A_typical
 *
 * All amounts are in wei. We compute in floating-point because BigInt division
 * loses too much precision for fractional APRs — the result is a fraction in
 * [0, ~0.5] for realistic indexer-scale allocations.
 */
function projectApr(opts: {
  signal: bigint;
  totalSignal: bigint;
  issuancePerBlock: bigint;
  blocksPerYear: number;
  existingAllocation: bigint;
  typicalAllocation: bigint;
}): number {
  if (opts.totalSignal <= 0n || opts.typicalAllocation <= 0n) return 0;
  if (opts.issuancePerBlock <= 0n) return 0;

  const signalShare = bigIntToNumber(opts.signal) / bigIntToNumber(opts.totalSignal);
  const issuancePerYear =
    bigIntToNumber(opts.issuancePerBlock) * opts.blocksPerYear;
  const ourAlloc = bigIntToNumber(opts.typicalAllocation);
  const totalAllocAfter = bigIntToNumber(opts.existingAllocation) + ourAlloc;
  if (totalAllocAfter <= 0) return 0;
  const allocShare = ourAlloc / totalAllocAfter;
  const rewardShare = signalShare * issuancePerYear * allocShare;
  const apr = rewardShare / ourAlloc;
  return Number.isFinite(apr) && apr >= 0 ? apr : 0;
}

/**
 * Concurrency-bounded `Promise.all` — run `fn` over each input with at most
 * `concurrency` in flight at a time. Individual `fn` rejections propagate
 * (callers wrap `fn` to swallow per-item errors when needed).
 */
async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  const width = Math.max(1, Math.min(concurrency, n));
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < width; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = nextIndex++;
          if (i >= n) return;
          const item = items[i];
          if (item === undefined) return;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
