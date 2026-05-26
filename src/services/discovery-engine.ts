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
import type { SubgraphIndexingStatus } from '../types/graphnode.js';
import { BLOCKS_PER_YEAR } from '../utils/constants.js';
import { toQmDeploymentId } from '../utils/ipfs.js';

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
  /**
   * Optional — kept on the deps surface for forward compatibility and so
   * existing wiring continues to typecheck, but discovery's read path no
   * longer touches graphman. Pause + assigned-node both come from
   * graph-node's `indexingStatuses` (which we already fetch for sync state),
   * so cleanup classification and orphaned detection work without a
   * configured graphman API. Graphman remains required only to *execute*
   * the resulting mutation plan (pause / unassign / unused_remove / etc.).
   */
  graphmanClient?: GraphmanClient;
  agentClient: IndexerAgentClient;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CANDIDATES = 10;

/** Concurrency cap for per-deployment fan-outs (graphman info, allocations, etc.). */
const FANOUT_CONCURRENCY = 8;

/**
 * Normalize a deployment id to the canonical Qm form used by every
 * internal map / set in this service. Accepts either bytes32 (`0x…`) or
 * Qm (`Qm…`) encodings via `toQmDeploymentId`.
 *
 * Strict by design: throws on anything that isn't valid bytes32 or Qm
 * form. Callers MUST catch and skip the bad id rather than admit it
 * into the whitelist / blacklist / frozenlist / syncingIds / sizesById
 * lookup maps. The prior lenient fallback (lowercased raw input) silently
 * poisoned those maps with non-canonical keys and caused cross-encoding
 * lookups to miss, defeating the very normalization the service was
 * supposed to provide.
 */
function normalizeDeploymentId(raw: string): string {
  return toQmDeploymentId(raw); // throws on garbage
}

/**
 * Try to normalize `raw` into a config-list Set. On failure, push a
 * per-source warning and drop the entry. Returns the resulting Set so
 * call-site code stays compact.
 */
function normalizeConfigList(
  raws: readonly string[],
  sourceLabel: string,
  warnings: string[],
): Set<string> {
  const out = new Set<string>();
  for (const raw of raws) {
    try {
      out.add(normalizeDeploymentId(raw));
    } catch {
      warnings.push(
        `${sourceLabel} entry ${JSON.stringify(raw)} is not a valid ` +
          `deployment ID (expected 0x<64-hex> or Qm<base58-44>); skipping.`,
      );
    }
  }
  return out;
}

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
    // Normalize operator-supplied deployment lists to Qm canonical form so
    // they unify with internal Qm-keyed sets regardless of whether the
    // operator gave us bytes32 (`0x…`) or Qm (`Qm…`) ids. Lowercasing the
    // raw input was insufficient because the two encodings never compare
    // equal — a bytes32 entry in `frozenlist` would silently fail to match
    // a Qm-form `status.subgraph` during cleanup.
    //
    // Strict: malformed entries are dropped + warned per-source. A typo in
    // any of these lists used to silently poison every downstream lookup
    // (lowercase fallback → unique key that never matched anything).
    const whitelist = normalizeConfigList(config.whitelist, 'Whitelist', warnings);
    const blacklist = normalizeConfigList(config.blacklist, 'Blacklist', warnings);
    const frozenlist = normalizeConfigList(config.frozenlist, 'Frozenlist', warnings);

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

    const signal = opts?.signal;
    const sigOpt = signal ? { signal } : undefined;

    try {
      const [sig, alloc, net] = await Promise.all([
        this.deps.networkClient.getSignalledDeployments(
          config.minSignal.toString(),
          sigOpt,
        ),
        this.deps.networkClient.getActiveAllocations(lowerAddr, sigOpt),
        this.deps.networkClient.getNetworkParameters(sigOpt),
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
      // If the caller cancelled mid-fetch, the rejection is an AbortError —
      // propagate it instead of degrading to an empty DiscoveryResult, which
      // would silently look like "no work to do" and defeat the signal
      // threading. Only convert non-abort errors into the fatal-empty path.
      throwIfAborted(opts?.signal);
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
      indexingStatuses = await this.deps.graphNodeClient.getIndexingStatuses(
        undefined,
        sigOpt,
      );
    } catch (err) {
      // Propagate aborts before degrading. Otherwise a cancelled fetch
      // becomes a `cleanup half will operate without local sync state`
      // warning and the rest of the run continues.
      throwIfAborted(opts?.signal);
      warnings.push(
        `graph-node: getIndexingStatuses failed (${describeError(err)}); ` +
          `cleanup half will operate without local sync state.`,
      );
    }

    throwIfAborted(opts?.signal);

    // Internal canonical form is Qm (IPFS CIDv0).
    //
    // The network subgraph returns deployment ids in bytes32 (`0x…`) form;
    // graph-node's `indexingStatuses` returns them in Qm form. Without
    // unifying both sides every set membership check
    // (`syncingIds.has(dep.id)`, `allocatedDeploymentIds.has(status.subgraph)`)
    // silently misses across encodings — discovery would either re-pick
    // already-syncing deployments as opportunities or fail to classify
    // genuinely stale ones during cleanup.
    //
    // Strict normalization: a single malformed id from any one client
    // must NOT poison the lookup maps with a non-canonical key. Skip and
    // warn; the rest of the run proceeds normally.
    const signalledIds = new Set<string>();
    const signalledById = new Map<string, SubgraphDeployment>();
    for (const d of signalledPage.items) {
      try {
        const key = normalizeDeploymentId(d.id);
        signalledIds.add(key);
        signalledById.set(key, d);
      } catch {
        warnings.push(
          `Signalled deployment id ${JSON.stringify(d.id)} from the network ` +
            `subgraph is malformed (expected 0x<64-hex> or Qm<base58-44>); ` +
            `skipping.`,
        );
      }
    }
    const allocatedDeploymentIds = new Set<string>();
    for (const a of activeAllocations) {
      try {
        allocatedDeploymentIds.add(normalizeDeploymentId(a.subgraphDeployment.id));
      } catch {
        warnings.push(
          `Active allocation ${JSON.stringify(a.id)} has a malformed ` +
            `deployment id ${JSON.stringify(a.subgraphDeployment.id)} ` +
            `(expected 0x<64-hex> or Qm<base58-44>); skipping.`,
        );
      }
    }
    // graph-node's `s.subgraph` is contractually always Qm — if anything
    // else shows up it's a graph-node bug, not a configuration issue.
    // Promote to `errors` (not `warnings`) so operators see it, but keep
    // going so the run still produces a result.
    const syncingIds = new Set<string>();
    for (const s of indexingStatuses) {
      try {
        syncingIds.add(normalizeDeploymentId(s.subgraph));
      } catch {
        errors.push(
          `graph-node returned a malformed deployment id ${JSON.stringify(s.subgraph)} ` +
            `on an indexing status (expected Qm<base58-44>); skipping.`,
        );
      }
    }

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
    // hit postgres once per stale deployment. Postgres is optional. Keys are
    // normalized to Qm to unify with the cleanup loop's `status.subgraph`
    // (graph-node returns Qm natively).
    const sizesById = new Map<string, bigint>();
    if (this.deps.postgresClient) {
      try {
        const sizes = await this.deps.postgresClient.getAllSubgraphSizes(
          signal ? { signal } : undefined,
        );
        for (const s of sizes) {
          try {
            sizesById.set(normalizeDeploymentId(s.deploymentId), BigInt(s.sizeBytes));
          } catch {
            // Postgres returned a row whose deployment id can't be
            // normalized — almost certainly a stale `subgraphs.subgraph`
            // entry from a pre-Qm-canonicalization era. Skip the row
            // rather than fail the whole size-catalog build.
            warnings.push(
              `postgres: subgraph size row has malformed deployment id ` +
                `${JSON.stringify(s.deploymentId)} (expected 0x<64-hex> or ` +
                `Qm<base58-44>); size enrichment skipped for this entry.`,
            );
          }
        }
      } catch (err) {
        // Abort propagation precedes degradation: a cancelled postgres call
        // must not look like a postgres outage.
        throwIfAborted(signal);
        warnings.push(
          `postgres: getAllSubgraphSizes failed (${describeError(err)}); ` +
            `disk-size enrichment skipped for cleanup.`,
        );
      }
    }

    throwIfAborted(signal);

    // Pause now comes straight from the `indexingStatuses` result above —
    // graph-node's GraphQL schema exposes `paused` natively, so we no
    // longer fan out a graphman lookup per deployment. This makes cleanup
    // classification work entirely without a configured graphman API.
    //
    // Note on `status.node`: we deliberately do NOT drive cleanup off the
    // `node` field alone. It's exposed on the type for operator-facing
    // visibility (and surfaced in raw indexing-status output for manual
    // investigation), but as the sole trigger for `orphaned` it produces
    // false positives we can't tolerate:
    //   - Older graph-node versions omit the field; the client normalizer
    //     defaults it to `null` on a successful response, which would
    //     reclassify every synced deployment as orphaned overnight after
    //     such a server.
    //   - Transient unassignment during graph-node restarts / rebalances
    //     can briefly null the field for healthy deployments.
    // The conjunctive rule (paused + no-allocation + no-signal) is the
    // only one that emits cleanup actions; it requires corroborating
    // evidence the deployment is genuinely abandoned.

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
      // Normalize for membership checks: indexingStatuses come from
      // graph-node in Qm form; allocated/signalled/frozenlist/whitelist
      // sets are normalized to Qm at the gather boundary. Using the raw
      // `deploymentId` directly works only when both sides happen to be
      // Qm — `normalizeDeploymentId` makes that explicit and idempotent.
      //
      // graph-node should always emit Qm here; if it doesn't, we already
      // recorded an error during the syncingIds build above. Skip the
      // status row defensively — it can't classify against any of the
      // Qm-keyed lookup sets anyway.
      let idKey: string;
      try {
        idKey = normalizeDeploymentId(deploymentId);
      } catch {
        continue;
      }

      // Pause comes from the indexing-status fetch itself.
      const paused = status.paused;
      const hasAllocation = allocatedDeploymentIds.has(idKey);
      const hasSignal = signalledIds.has(idKey);
      const isFrozen = frozenlist.has(idKey);
      const isWhitelisted = whitelist.has(idKey);

      // Skip the whole sync state — graph-node is still pulling a fresh
      // deployment and we shouldn't propose tearing it down mid-flight.
      if (!status.synced) continue;

      // Classify. First match wins; ordering reflects priority (no signal is
      // the most actionable; orphaned trumps unallocated since it's
      // infrastructure-level).
      //
      // `orphaned` requires conjunctive evidence: paused AND no allocation
      // AND no signal — i.e. paused on something the indexer has no
      // remaining stake in. A deployment that is *only* paused might be a
      // deliberate maintenance pause and must NOT be proposed for cleanup.
      //
      // `status.node === null` on its own is intentionally NOT enough —
      // older graph-node versions omit the field (the client normalizer
      // defaults it to `null`), and transient unassignment during node
      // restarts is common. False-positive orphaned classification would
      // generate spurious cleanup steps for every synced deployment. The
      // field is still exposed on the type for operator-facing visibility;
      // operators investigating directly can see node:null in raw
      // indexing-status output.
      let reason: StaleDeployment['reason'] | null = null;
      if (paused && !hasAllocation && !hasSignal) {
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

      const sizeBytes = sizesById.get(idKey) ?? null;
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
          // Only emitted via the conjunctive rule (paused + no allocation +
          // no signal). The `paused` guard is therefore always true at this
          // point — keep the ternary defensive in case the rule widens
          // later, but lead with the paused phrasing.
          return opts.paused
            ? 'deployment is paused with no allocation and no signal — abandoned'
            : 'deployment classified orphaned via cleanup rules';
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
    // `signalled` items come from the network subgraph in bytes32 form;
    // every lookup set (allocated / syncing / blacklist) is in the Qm
    // canonical form. Normalize dep.id per iteration so set membership
    // works across encodings — the previous bytes32-vs-Qm mismatch was
    // silently re-picking already-syncing deployments as opportunities.
    for (const dep of signalled) {
      let key: string;
      try {
        key = normalizeDeploymentId(dep.id);
      } catch {
        // Already warned during the signalledIds build above; silently
        // skip here so the candidate is excluded without double-warning.
        continue;
      }
      if (allocatedDeploymentIds.has(key)) continue;
      if (syncingIds.has(key)) continue;
      if (blacklist.has(key)) continue;
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
    //
    // The QoS client paginates its underlying scan and surfaces a `truncated`
    // flag on every row if the pagination cap was hit (the flag describes
    // the scan, not the row). When set, the per-deployment volume map may
    // be missing some deployments entirely OR have undercounted volumes for
    // ones whose daily rows fell past the cap — `volumeScore` for affected
    // candidates would be biased toward 0. Surface as a discovery warning
    // so operators see the limitation in the result rather than silently
    // accepting a biased scoring run.
    // ------------------------------------------------------------------------
    const queryVolumeById = new Map<string, bigint>();
    let qosVolumeTruncated = false;
    try {
      const volumes = await this.deps.qosClient.getQueryVolume(
        { timeRange: { days: 30 } },
        signal ? { signal } : undefined,
      );
      for (const v of volumes) {
        if (v.truncated) qosVolumeTruncated = true;
        if (v.deployment_id) {
          // `query_count` is a BigInt-as-string on the QoS client surface,
          // so parse it directly via BigInt. Truncate any decimal part
          // defensively and guard against negative or malformed strings —
          // a bad row should not poison the whole map.
          //
          // Normalize the key to Qm canonical form. The Gateway QoS Oracle
          // subgraph stores `SubgraphDeployment.id` as the IPFS hash, so
          // this is usually idempotent — but candidate lookups below use
          // bytes32-form `dep.id`, so we ALSO normalize via the same path
          // when reading so encodings unify. Skip rows whose id can't be
          // normalized rather than poisoning the map.
          try {
            queryVolumeById.set(
              normalizeDeploymentId(v.deployment_id),
              parseQueryCount(v.query_count),
            );
          } catch {
            // Malformed QoS row — skip silently. A single oddball entry
            // isn't worth warning on per-row; if every row is malformed
            // the resulting empty map already biases volumeScore to 0
            // for every candidate, which is the worst-case correct
            // behavior.
          }
        }
      }
      if (qosVolumeTruncated) {
        warnings.push(
          `qos: 30-day query-volume scan was truncated (pagination cap hit); ` +
            `some deployments may be missing or undercounted, biasing ` +
            `volumeScore toward 0 for affected candidates.`,
        );
      }
    } catch (err) {
      // A caller-initiated abort during the QoS fetch should propagate, not
      // be reported as a QoS outage with `volumeScore=0`.
      throwIfAborted(signal);
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

    // The external AbortSignal is forwarded into each client call so per-
    // candidate fetches abort mid-flight if the caller cancels.
    const innerSigOpt = signal ? { signal } : undefined;
    await mapPool(candidates, FANOUT_CONCURRENCY, async (dep) => {
      throwIfAborted(signal);

      let totalStakedTokens = 0n;
      let indexerCount = 0;
      try {
        const allocs = await this.deps.networkClient.getDeploymentAllocations(
          dep.id,
          innerSigOpt,
        );
        const uniqueIndexers = new Set<string>();
        for (const a of allocs.items) {
          totalStakedTokens += safeBigInt(a.allocatedTokens);
          uniqueIndexers.add(a.indexer.id.toLowerCase());
        }
        indexerCount = uniqueIndexers.size;
      } catch (err) {
        // Cancellation must escape the per-candidate handler so the outer
        // mapPool tears down; otherwise we silently produce zeros for every
        // remaining candidate after the abort.
        throwIfAborted(signal);
        warnings.push(
          `network subgraph: getDeploymentAllocations(${dep.id}) failed ` +
            `(${describeError(err)}); totalStake / indexerCount default to 0.`,
        );
      }

      // Normalize the lookup key — queryVolumeById is keyed by Qm and
      // dep.id comes from the network subgraph in bytes32 form.
      const volKey = normalizeDeploymentId(dep.id);
      const queryVolume30d = queryVolumeById.has(volKey)
        ? (queryVolumeById.get(volKey) ?? null)
        : null;

      // entityCount: best-effort. graph-node returns null when the
      // deployment isn't synced locally, which is expected for discovery
      // candidates. We surface that as `null` — costScore falls back to
      // signalledTokens as a coarse proxy in the normalizer.
      let entityCount: bigint | null = null;
      try {
        const ec = await this.deps.graphNodeClient.getEntityCount(dep.id, innerSigOpt);
        if (ec !== null) entityCount = safeBigInt(ec);
      } catch {
        // Propagate cancellation; otherwise swallow — entity count is a
        // `nice to have` and we don't want one warning per candidate.
        throwIfAborted(signal);
      }

      // Chain: not currently surfaced on `SubgraphDeployment`. Best-effort
      // lookup via graphman info ONLY when a graphman client is wired
      // (graphman became optional once pause/node state moved to
      // graph-node). When no graphman is configured we just leave chain
      // as null — it's already optional and only used as a display hint.
      let chain: string | null = null;
      const graphman = this.deps.graphmanClient;
      if (graphman) {
        try {
          const info = await graphman.getDeploymentInfo(dep.id, innerSigOpt);
          chain = info.chain ?? null;
        } catch {
          // Propagate cancellation. Otherwise expected: graphman often
          // returns 404 for unknown deployments.
          throwIfAborted(signal);
        }
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

    // Final abort gate after the per-candidate fan-out — without this, a
    // cancellation that races with the last worker completing would still
    // produce a scored DiscoveryResult.
    throwIfAborted(signal);

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
    // Prefer the native WHATWG abort propagation so callers receive their
    // own abort reason (DOMException AbortError or whatever they passed to
    // `controller.abort(reason)`), not a stand-in Error created here. Fall
    // back to a stable Error if `signal.reason` is somehow not throwable.
    if (typeof signal.throwIfAborted === 'function') {
      signal.throwIfAborted();
    }
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

/**
 * Parse a QoS `query_count` BigInt-as-string into a non-negative BigInt.
 * Truncates any decimal component (the QoS subgraph occasionally returns
 * BigDecimal values for what should be integer counts) and clamps negative
 * or malformed strings to zero so one bad row doesn't poison the map.
 */
function parseQueryCount(s: string): bigint {
  if (!s) return 0n;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed.startsWith('-')) return 0n;
  try {
    const intPart = trimmed.split('.')[0] ?? '0';
    const v = BigInt(intPart);
    return v < 0n ? 0n : v;
  } catch {
    return 0n;
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
 *   reward_share = (S / T) * (issuance_per_block * BLOCKS_PER_YEAR)
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
  existingAllocation: bigint;
  typicalAllocation: bigint;
}): number {
  if (opts.totalSignal <= 0n || opts.typicalAllocation <= 0n) return 0;
  if (opts.issuancePerBlock <= 0n) return 0;

  const signalShare = bigIntToNumber(opts.signal) / bigIntToNumber(opts.totalSignal);
  const issuancePerYear =
    bigIntToNumber(opts.issuancePerBlock) * BLOCKS_PER_YEAR;
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
