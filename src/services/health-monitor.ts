/**
 * HealthMonitor — pre-epoch health-check workflow (design §4.2).
 *
 * Responsibilities (read-only orchestration; no mutations):
 *   1. Determine epoch timing from EBO + the network subgraph
 *      (hours-until-flip, epoch length, current block).
 *   2. Classify every active allocation against the §4.2 decision matrix:
 *      Path A (Healthy Close), Path B (Deterministic Failure Close), or
 *      `none` (operator review).
 *   3. Score risk per allocation by combining urgency, allocation size, and
 *      degradation signal.
 *   4. Produce a close plan for closable allocations (Path A / Path B). Path
 *      B entries surface a `poiBlock` (last known good block) that the
 *      operator MUST cross-verify with other indexers before closing — this
 *      service flags but does not auto-verify.
 *   5. Produce a recovery plan (graphman restart / rewind / check_blocks /
 *      clear_call_cache / manual_review) for failed deployments, using
 *      conservative heuristics over `fatalError.message`.
 *
 * The service never queues actions, never executes graphman commands, and
 * never closes allocations. The composite `run_health_check` tool wrapper
 * (Stage 3 Track C) reads this result, presents it to the operator, and
 * only after confirmation invokes the corresponding mutations.
 *
 * Closability table (design §4.2):
 *
 *   | health    | head vs epochStart | error type        | closability |
 *   |-----------|--------------------|-------------------|-------------|
 *   | healthy   | above              | n/a               | A (rebal.)  |
 *   | healthy   | below              | n/a               | none        |
 *   | unhealthy | above              | non-fatal         | A           |
 *   | unhealthy | below              | non-fatal         | none        |
 *   | failed    | above              | deterministic     | B           |
 *   | failed    | above              | non-deterministic | A           |
 *   | failed    | below              | deterministic     | B           |
 *   | failed    | below              | non-deterministic | none        |
 *
 * Design judgement: "healthy at epoch-start block" is impractical to verify
 * in real time (we'd need historical health state). The approximation used:
 * if the deployment is currently healthy and `latestBlock >= epochStartBlock`,
 * treat it as healthy-at-epoch-start. This is conservative for Path A on the
 * healthy row (current health implies past health) but is noted in
 * `closabilityReason` so the operator can override.
 */

import type { Allocation } from '../types/network.js';
import type {
  ChainIndexingStatus,
  SubgraphError,
  SubgraphIndexingStatus,
} from '../types/graphnode.js';

import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { EboSubgraphClient } from '../clients/ebo-subgraph.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { IndexerAgentClient } from '../clients/indexer-agent.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClosabilityPath = 'A' | 'B' | 'none';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AllocationHealth {
  allocationId: string;
  deploymentId: string;
  /** Allocated GRT in wei (preserved as BigInt to avoid precision loss). */
  allocatedTokens: bigint;
  health: 'healthy' | 'unhealthy' | 'failed';
  synced: boolean;
  /** Most recent block indexed by graph-node, or null if unknown. */
  latestBlock: number | null;
  /** Epoch-start block on the deployment's chain, or null if unresolved. */
  epochStartBlock: number | null;
  /** Pathway by which this allocation can be closed cleanly. */
  closability: ClosabilityPath;
  /** Why this path (or none) — quotes the matrix row. */
  closabilityReason: string;
  /**
   * Whether the underlying fatalError (if any) is deterministic.
   *   - `true`  → fatalError exists and is deterministic
   *   - `false` → fatalError exists and is non-deterministic
   *   - `null`  → no fatalError, or status unknown
   */
  fatalErrorDeterministic: boolean | null;
  /**
   * `chains[0].lastHealthyBlock.number` from graph-node when reported. This
   * is the last block at which the deployment was healthy before the failure
   * — the canonical POI block for Path B closes.
   */
  lastHealthyBlock: number | null;
  /**
   * `fatalError.block.number` from graph-node when reported — the block at
   * which the deterministic failure occurred. The last known good block is
   * `fatalErrorBlock - 1`.
   */
  fatalErrorBlock: number | null;
}

export interface EpochTiming {
  currentEpoch: number;
  /** Hours until the next epoch flip; negative if the epoch just flipped. */
  hoursUntilNextEpoch: number;
  epochLengthBlocks: number;
  /**
   * Current block on the protocol chain, as inferred from the EBO's start
   * block + epoch-length math when graph-node has no protocol-chain status.
   * Best-effort — the caller should treat it as an estimate.
   */
  currentBlock: number;
}

export interface RiskAssessment {
  allocationId: string;
  level: RiskLevel;
  reasons: string[];
}

export type RecoveryActionType =
  | 'restart'
  | 'rewind'
  | 'check_blocks'
  | 'clear_call_cache'
  | 'manual_review';

export interface RecoveryAction {
  deploymentId: string;
  type: RecoveryActionType;
  rationale: string;
  /** Args to pass to the corresponding graphman tool when executed. */
  args: Record<string, unknown>;
}

export interface CloseActionPlan {
  allocationId: string;
  deploymentId: string;
  path: 'A' | 'B';
  /**
   * For Path B, the POI block — the last known good block before failure.
   * Operator must verify with other indexers before submitting.
   */
  poiBlock?: number;
  reason: string;
}

export interface HealthCheckResult {
  timing: EpochTiming;
  allocations: AllocationHealth[];
  risk: RiskAssessment[];
  /** Closable AND worth closing now (Path A or Path B). */
  closePlan: CloseActionPlan[];
  /** Unhealthy/failed allocations that can't be safely closed this epoch. */
  blockedFromClose: AllocationHealth[];
  /** graphman recovery recommendations for failed deployments. */
  recoveryPlan: RecoveryAction[];
  warnings: string[];
  errors: string[];
}

export interface HealthMonitorDeps {
  networkClient: NetworkSubgraphClient;
  eboClient: EboSubgraphClient;
  graphNodeClient: GraphNodeClient;
  graphmanClient: GraphmanClient;
  agentClient: IndexerAgentClient;
}

export interface HealthMonitorRunOpts {
  indexerAddress: string;
  /** Hours-until-flip below which risk escalates by one tier. Default 6. */
  urgencyThresholdHours?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default seconds-per-block on Arbitrum (the protocol chain). The
 * authoritative figure varies (~0.25s under load, ~0.5s nominal). We use 0.25
 * as the conservative-for-urgency value: it OVERESTIMATES blocks-per-hour,
 * which slightly UNDERESTIMATES hours-remaining — biasing the alert toward
 * "close sooner rather than later", which is what we want for a pre-epoch
 * health check. The caller can recalibrate by passing a higher
 * `urgencyThresholdHours`.
 */
const PROTOCOL_CHAIN_SECONDS_PER_BLOCK = 0.25;

/** Default urgency threshold per spec. */
const DEFAULT_URGENCY_THRESHOLD_HOURS = 6;

/** Large-allocation threshold for risk escalation: 100k GRT (in wei). */
const LARGE_ALLOCATION_WEI = 100_000n * 10n ** 18n;

// ---------------------------------------------------------------------------
// Recovery heuristics
// ---------------------------------------------------------------------------

/**
 * One row in the conservative pattern table. We only confidently classify
 * common, well-known transient/RPC patterns — anything else falls through to
 * `manual_review`. Patterns are matched against `fatalError.message`.
 *
 * Two matchers are supported (a row supplies exactly one):
 *   - `needles`: ALL substrings must be present (case-insensitive). Use when
 *     a single conjunction of phrases is sufficient.
 *   - `pattern`: full regex against the original message. Use when ordering,
 *     word boundaries, or OR semantics matter. Patterns SHOULD be specific
 *     enough to avoid matching negated/explanatory messages
 *     (e.g. "no reorg detected" should NOT trigger `clear_call_cache`).
 *
 * See design §3.2 ("Auto-Heal") for the broader catalog.
 */
interface RecoveryHeuristic {
  type: RecoveryActionType;
  /** Substrings, ALL of which must be present in the lowercased message. */
  needles?: string[];
  /** Regex (case-insensitive recommended) matched against the raw message. */
  pattern?: RegExp;
  rationale: string;
  /** Builds the args object given the failed deployment + status. */
  buildArgs: (ctx: RecoveryContext) => Record<string, unknown>;
}

interface RecoveryContext {
  deploymentId: string;
  chain: string | null;
  failureBlock: number | null;
}

const RECOVERY_HEURISTICS: RecoveryHeuristic[] = [
  // "subgraph writer poisoned by previous error" → restart (high confidence).
  {
    type: 'restart',
    needles: ['writer poisoned'],
    rationale:
      'Writer-poisoned errors are transient and clear on restart (design §3.2 high-confidence pattern).',
    buildArgs: (ctx) => ({ deploymentId: ctx.deploymentId }),
  },
  // "store error: deployment head ... not found" → rewind 5 blocks. Requires
  // all three signals (store error + deployment head + not found) in any
  // order so we don't fire on e.g. "store error: timeout" or generic
  // "deployment head advanced".
  {
    type: 'rewind',
    pattern:
      /(store error.*deployment head.*not found|deployment head.*not found.*store error|store error.*not found.*deployment head|not found.*store error.*deployment head|deployment head.*store error.*not found|not found.*deployment head.*store error)/i,
    rationale:
      'Store-error "deployment head not found" responds to a small rewind from the failure block.',
    buildArgs: (ctx) => ({
      deploymentId: ctx.deploymentId,
      // We can't supply a blockHash from here; rewindDeployment requires one.
      // The composite tool must look it up via graph-node before executing.
      targetBlockNumber:
        ctx.failureBlock !== null ? Math.max(0, ctx.failureBlock - 5) : null,
      blocksBefore: 5,
    }),
  },
  // RPC corruption: missing block / header → check_blocks first, then
  // operator decides whether to truncate + rewind. Word-boundary matches
  // avoid e.g. "BlockNotFound" inside an unrelated identifier.
  {
    type: 'check_blocks',
    pattern: /\bblock not found\b/i,
    rationale:
      'Missing-block errors point at RPC/cache corruption; verify with `graphman chain check-blocks` before any rewind.',
    buildArgs: (ctx) => ({
      chain: ctx.chain ?? null,
      blockNumber: ctx.failureBlock,
    }),
  },
  {
    type: 'check_blocks',
    pattern: /\bheader not found\b/i,
    rationale:
      'Header-not-found is RPC/cache corruption; verify with `graphman chain check-blocks` first.',
    buildArgs: (ctx) => ({
      chain: ctx.chain ?? null,
      blockNumber: ctx.failureBlock,
    }),
  },
  // Reorg-related cache poisoning → clear_call_cache. Require a SPECIFIC
  // signal: "reorg detected" OR "reverted block". A user-facing log like
  // "no reorg detected" or "reorg-safe path taken" must NOT trigger this —
  // the negative lookbehind rejects negated "no(t)? (yet )?reorg detected".
  {
    type: 'clear_call_cache',
    pattern: /(?<!\bno\s)(?<!\bnot\s)(?<!\bnot yet\s)(?:\breorg detected\b|\breverted block\b)/i,
    rationale:
      'Reorg-related failures often leave poisoned call-cache entries; clear the affected range, then rewind.',
    buildArgs: (ctx) => ({
      chain: ctx.chain ?? null,
      // Conservative window: 10 blocks before failure to failure block itself.
      from: ctx.failureBlock !== null ? Math.max(0, ctx.failureBlock - 10) : null,
      to: ctx.failureBlock,
    }),
  },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HealthMonitor {
  constructor(private readonly deps: HealthMonitorDeps) {}

  async run(opts: HealthMonitorRunOpts): Promise<HealthCheckResult> {
    const urgencyThresholdHours =
      opts.urgencyThresholdHours ?? DEFAULT_URGENCY_THRESHOLD_HOURS;

    const warnings: string[] = [];
    const errors: string[] = [];

    // -----------------------------------------------------------------------
    // Step 1: epoch timing
    // -----------------------------------------------------------------------

    let timing: EpochTiming;
    let protocolChainAlias: string | null = null;
    let protocolEpochStartBlock: number | null = null;
    try {
      const [currentEpoch, networkParams] = await Promise.all([
        this.deps.eboClient.getCurrentEpoch(),
        this.deps.networkClient.getNetworkParameters(),
      ]);
      throwIfAborted(opts.signal);

      // The protocol chain alias isn't stored on GraphNetwork; we infer it
      // from the EBO's per-chain row that matches the network subgraph's
      // currentEpoch counter. The chain whose epochNumber lines up with
      // GraphNetwork.currentEpoch is the protocol chain.
      // In practice this is `arbitrum-one` for mainnet; if no row matches we
      // fall back to the first networkBlocks row but flag a warning.
      const protocolRow =
        currentEpoch.networkBlocks.find((r) =>
          r.network.toLowerCase().includes('arbitrum'),
        ) ?? currentEpoch.networkBlocks[0];
      if (!protocolRow) {
        warnings.push(
          'EBO returned no per-chain start blocks for the current epoch; cannot compute epoch timing precisely.',
        );
      } else {
        protocolChainAlias = protocolRow.network;
        protocolEpochStartBlock = safeToInt(protocolRow.blockNumber);
      }

      timing = computeTiming({
        currentEpochNumber: currentEpoch.epochNumber,
        epochLengthBlocks: networkParams.epochLength,
        protocolEpochStartBlock,
      });
    } catch (err) {
      errors.push(`Failed to determine epoch timing: ${describe(err)}`);
      // Return early-ish: without timing we still try the allocations loop so
      // operators see what's healthy, but risk scoring will be coarse.
      timing = {
        currentEpoch: 0,
        hoursUntilNextEpoch: Number.NaN,
        epochLengthBlocks: 0,
        currentBlock: 0,
      };
    }

    // -----------------------------------------------------------------------
    // Step 2: fetch active allocations
    // -----------------------------------------------------------------------

    let allocations: Allocation[] = [];
    try {
      const page = await this.deps.networkClient.getActiveAllocations(
        opts.indexerAddress,
      );
      throwIfAborted(opts.signal);
      allocations = page.items;
      if (page.truncated) {
        warnings.push(
          'Active-allocation list was truncated at the pagination cap; some allocations may not appear in this report.',
        );
      }
    } catch (err) {
      errors.push(
        `Failed to fetch active allocations for ${opts.indexerAddress}: ${describe(err)}`,
      );
      return {
        timing,
        allocations: [],
        risk: [],
        closePlan: [],
        blockedFromClose: [],
        recoveryPlan: [],
        warnings,
        errors,
      };
    }

    // -----------------------------------------------------------------------
    // Step 3: classify each allocation (Promise.allSettled — one bad row
    // must not poison the whole report).
    // -----------------------------------------------------------------------

    const classifications = await Promise.allSettled(
      allocations.map((alloc) =>
        this.classifyAllocation(alloc, timing.currentEpoch, opts.signal),
      ),
    );

    const allocationHealths: AllocationHealth[] = [];
    classifications.forEach((settled, idx) => {
      const alloc = allocations[idx];
      if (!alloc) return;
      if (settled.status === 'fulfilled') {
        allocationHealths.push(settled.value);
      } else {
        errors.push(
          `Failed to classify allocation ${alloc.id} (${alloc.subgraphDeployment.id}): ${describe(settled.reason)}`,
        );
        // Emit a placeholder so the operator still sees the allocation listed,
        // marked as `none` closability pending operator review.
        allocationHealths.push({
          allocationId: alloc.id,
          deploymentId: alloc.subgraphDeployment.id,
          allocatedTokens: safeToBigInt(alloc.allocatedTokens),
          health: 'failed',
          synced: false,
          latestBlock: null,
          epochStartBlock: null,
          closability: 'none',
          closabilityReason:
            'Classification failed — see errors list. Operator review required.',
          fatalErrorDeterministic: null,
          lastHealthyBlock: null,
          fatalErrorBlock: null,
        });
      }
    });

    // -----------------------------------------------------------------------
    // Step 4: assess risk
    // -----------------------------------------------------------------------

    // Compute the median allocation size as a fallback "large" threshold when
    // the absolute LARGE_ALLOCATION_WEI floor doesn't fire (e.g. on a small
    // indexer where every allocation is < 100k GRT but some are still
    // disproportionately large for THIS indexer). See assessRisk() for the
    // tiering matrix.
    const medianAllocatedTokens = median(
      allocationHealths.map((ah) => ah.allocatedTokens),
    );

    const risk = allocationHealths.map((ah) =>
      assessRisk(ah, timing, urgencyThresholdHours, medianAllocatedTokens),
    );

    // -----------------------------------------------------------------------
    // Step 5: close plan + blocked-from-close
    // -----------------------------------------------------------------------

    const closePlan: CloseActionPlan[] = [];
    const blockedFromClose: AllocationHealth[] = [];

    for (const ah of allocationHealths) {
      if (ah.closability === 'none') {
        // Only the genuinely-degraded ones go to "blocked"; healthy
        // closability:'none' (which our matrix doesn't produce — healthy/below
        // is `none`) goes to blocked too because the operator should know
        // they can't close it yet.
        if (ah.health !== 'healthy' || (ah.epochStartBlock !== null && ah.latestBlock !== null && ah.latestBlock < ah.epochStartBlock)) {
          blockedFromClose.push(ah);
        }
        continue;
      }

      if (ah.closability === 'A') {
        // Path A from healthy allocations is "only if rebalancing" — the
        // optimizer owns that decision. We do NOT recommend closing healthy
        // synced allocations here; emit Path A close plan only when the
        // allocation is degraded (unhealthy/failed) or otherwise actionable.
        if (ah.health === 'healthy') {
          // Skip — healthy allocations are not actioned by this workflow.
          continue;
        }
        closePlan.push({
          allocationId: ah.allocationId,
          deploymentId: ah.deploymentId,
          path: 'A',
          reason: ah.closabilityReason,
        });
        continue;
      }

      // Path B — POI is the last KNOWN GOOD block (immediately before the
      // deterministic failure), not the most recently processed block. Prefer
      // graph-node's `chains[].lastHealthyBlock`; fall back to
      // `fatalError.block - 1`; omit entirely when neither is reported (the
      // closabilityReason already carries the manual-verify warning from
      // classify()).
      const planEntry: CloseActionPlan = {
        allocationId: ah.allocationId,
        deploymentId: ah.deploymentId,
        path: 'B',
        reason: ah.closabilityReason,
      };
      if (ah.lastHealthyBlock !== null) {
        planEntry.poiBlock = ah.lastHealthyBlock;
      } else if (ah.fatalErrorBlock !== null) {
        planEntry.poiBlock = Math.max(0, ah.fatalErrorBlock - 1);
      }
      // else: poiBlock intentionally omitted — operator must verify manually.
      closePlan.push(planEntry);
    }

    // -----------------------------------------------------------------------
    // Step 6: recovery plan (failed deployments only)
    // -----------------------------------------------------------------------

    const recoveryPlan = await this.buildRecoveryPlan(
      allocations,
      allocationHealths,
      opts.signal,
    );

    return {
      timing,
      allocations: allocationHealths,
      risk,
      closePlan,
      blockedFromClose,
      recoveryPlan,
      warnings,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: classify a single allocation
  // -------------------------------------------------------------------------

  private async classifyAllocation(
    alloc: Allocation,
    currentEpoch: number,
    signal?: AbortSignal,
  ): Promise<AllocationHealth> {
    throwIfAborted(signal);
    const status = await this.deps.graphNodeClient.getDeploymentHealth(
      alloc.subgraphDeployment.id,
    );
    throwIfAborted(signal);

    const chain = pickChain(status);
    let epochStartBlock: number | null = null;
    if (chain && currentEpoch > 0) {
      try {
        const row = await this.deps.eboClient.getEpochBlocks(currentEpoch, chain);
        if (row) epochStartBlock = safeToInt(row.blockNumber);
      } catch {
        // Swallow — we'll mark epochStartBlock null and downgrade to "none".
      }
    }

    if (!status) {
      return {
        allocationId: alloc.id,
        deploymentId: alloc.subgraphDeployment.id,
        allocatedTokens: safeToBigInt(alloc.allocatedTokens),
        health: 'failed',
        synced: false,
        latestBlock: null,
        epochStartBlock,
        closability: 'none',
        closabilityReason:
          'graph-node has no indexing-status row for this deployment; operator review required (deployment may not be assigned to this node).',
        fatalErrorDeterministic: null,
        lastHealthyBlock: null,
        fatalErrorBlock: null,
      };
    }

    const latestBlock = pickLatestBlock(status, chain);
    const lastHealthyBlock = pickLastHealthyBlock(status, chain);
    const fatalDeterministic = status.fatalError
      ? Boolean(status.fatalError.deterministic)
      : null;
    const fatalErrorBlock =
      status.fatalError?.block?.number !== undefined
        ? safeToInt(status.fatalError.block.number)
        : null;

    const { closability, reason } = classify({
      health: status.health,
      latestBlock,
      epochStartBlock,
      fatalError: status.fatalError,
      lastHealthyBlock,
      fatalErrorBlock,
    });

    return {
      allocationId: alloc.id,
      deploymentId: alloc.subgraphDeployment.id,
      allocatedTokens: safeToBigInt(alloc.allocatedTokens),
      health: status.health,
      synced: status.synced,
      latestBlock,
      epochStartBlock,
      closability,
      closabilityReason: reason,
      fatalErrorDeterministic: fatalDeterministic,
      lastHealthyBlock,
      fatalErrorBlock,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: build recovery plan for failed deployments
  // -------------------------------------------------------------------------

  private async buildRecoveryPlan(
    allocations: Allocation[],
    healths: AllocationHealth[],
    signal?: AbortSignal,
  ): Promise<RecoveryAction[]> {
    const out: RecoveryAction[] = [];
    // Dedup by deployment id — multiple allocations on the same deployment
    // share one recovery action.
    const seen = new Set<string>();

    for (const ah of healths) {
      if (ah.health !== 'failed') continue;
      if (seen.has(ah.deploymentId)) continue;
      seen.add(ah.deploymentId);

      throwIfAborted(signal);

      // Re-fetch status to get the fatalError message and chain (we didn't
      // carry the message through AllocationHealth to keep that struct
      // operator-friendly). This is one extra round-trip per failed
      // deployment, which is cheap and keeps the public type clean.
      let status: SubgraphIndexingStatus | null = null;
      try {
        status = await this.deps.graphNodeClient.getDeploymentHealth(ah.deploymentId);
      } catch {
        // fall through to manual_review
      }
      throwIfAborted(signal);

      const message = status?.fatalError?.message ?? '';
      const chain = status ? pickChain(status) : null;
      const failureBlock =
        status?.fatalError?.block?.number !== undefined
          ? safeToInt(status.fatalError.block.number)
          : null;

      // Non-deterministic failures: we don't auto-prescribe — surface for
      // operator review. (Exception: if a message matches one of our
      // well-known transient patterns below, we still emit a recommendation;
      // the heuristics are intentionally conservative.)
      const heuristic = matchHeuristic(message);

      if (heuristic) {
        out.push({
          deploymentId: ah.deploymentId,
          type: heuristic.type,
          rationale: heuristic.rationale,
          args: heuristic.buildArgs({
            deploymentId: ah.deploymentId,
            chain,
            failureBlock,
          }),
        });
      } else {
        out.push({
          deploymentId: ah.deploymentId,
          type: 'manual_review',
          rationale:
            status?.fatalError
              ? `Fatal error did not match any known recovery pattern: "${truncate(message, 200)}". Operator should investigate.`
              : 'Deployment is marked failed but no fatalError detail is available. Operator should investigate.',
          args: {
            chain,
            failureBlock,
            deterministic: status?.fatalError?.deterministic ?? null,
          },
        });
      }
    }

    // `allocations` parameter is currently unused beyond the healths input,
    // but is kept in the signature so the composite tool layer can later
    // correlate recovery actions back to specific allocations if needed.
    void allocations;

    return out;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

interface ClassifyInput {
  health: 'healthy' | 'unhealthy' | 'failed';
  latestBlock: number | null;
  epochStartBlock: number | null;
  fatalError?: SubgraphError;
  lastHealthyBlock: number | null;
  fatalErrorBlock: number | null;
}

interface ClassifyOutput {
  closability: ClosabilityPath;
  reason: string;
}

/**
 * Pure classification of the §4.2 decision matrix. Kept side-effect-free so
 * it can be unit-tested without instantiating the service.
 */
function classify(input: ClassifyInput): ClassifyOutput {
  const {
    health,
    latestBlock,
    epochStartBlock,
    fatalError,
    lastHealthyBlock,
    fatalErrorBlock,
  } = input;

  // If we couldn't resolve the epoch-start block at all, we can't apply the
  // matrix — fall through to operator review.
  if (epochStartBlock === null) {
    return {
      closability: 'none',
      reason:
        'Could not resolve epoch-start block for this deployment\'s chain; operator review required.',
    };
  }
  if (latestBlock === null) {
    return {
      closability: 'none',
      reason: 'graph-node did not report a latestBlock for this deployment; operator review required.',
    };
  }

  const aboveEpochStart = latestBlock >= epochStartBlock;
  const blocksAhead = latestBlock - epochStartBlock;

  // ----- healthy ---------------------------------------------------------
  if (health === 'healthy') {
    if (aboveEpochStart) {
      return {
        closability: 'A',
        reason:
          `Healthy and above epoch start (latestBlock=${latestBlock} >= epochStartBlock=${epochStartBlock}, +${blocksAhead}). ` +
          'Approximation: currently-healthy implies healthy-at-epoch-start (no historical state read). ' +
          'Path A applies only if rebalancing — the optimizer owns rebalance decisions.',
      };
    }
    return {
      closability: 'none',
      reason: `Healthy but still syncing (latestBlock=${latestBlock} < epochStartBlock=${epochStartBlock}); wait for sync.`,
    };
  }

  // ----- unhealthy -------------------------------------------------------
  if (health === 'unhealthy') {
    // Per matrix: only non-fatal errors are listed for unhealthy. `unhealthy`
    // in graph-node means "non-fatal errors encountered, still progressing",
    // so the "non-fatal" qualifier is implicit.
    if (aboveEpochStart) {
      return {
        closability: 'A',
        reason:
          `Unhealthy (non-fatal errors) but above epoch start (latestBlock=${latestBlock} >= epochStartBlock=${epochStartBlock}). ` +
          'Path A close — POI valid for epoch-start block.',
      };
    }
    return {
      closability: 'none',
      reason: `Unhealthy and below epoch start (latestBlock=${latestBlock} < epochStartBlock=${epochStartBlock}); cannot generate valid POI for this epoch.`,
    };
  }

  // ----- failed ----------------------------------------------------------
  const deterministic = fatalError ? Boolean(fatalError.deterministic) : null;
  if (deterministic === null) {
    // Failed with no fatalError detail — refuse to classify automatically.
    return {
      closability: 'none',
      reason: 'Deployment is failed but no fatalError detail is available; operator review required.',
    };
  }

  const pathBNoBlockSuffix =
    lastHealthyBlock === null && fatalErrorBlock === null
      ? ' Path B requires operator-verified POI block — neither lastHealthyBlock nor fatalError.block was reported by graph-node, manual cross-verify with other indexers is required.'
      : '';

  if (aboveEpochStart) {
    if (deterministic) {
      return {
        closability: 'B',
        reason:
          `Failed with deterministic error above epoch start (latestBlock=${latestBlock} >= epochStartBlock=${epochStartBlock}). ` +
          'Path B close — operator MUST cross-verify the failure block with other indexers before submitting POI.' +
          pathBNoBlockSuffix,
      };
    }
    return {
      closability: 'A',
      reason:
        `Failed with non-deterministic error above epoch start (latestBlock=${latestBlock} >= epochStartBlock=${epochStartBlock}). ` +
        'Path A close — use epoch-start POI. Approximation: assumes healthy-at-epoch-start since latestBlock advanced past it before failure.',
    };
  }

  // below epoch start
  if (deterministic) {
    return {
      closability: 'B',
      reason:
        `Failed with deterministic error below epoch start (latestBlock=${latestBlock} < epochStartBlock=${epochStartBlock}). ` +
        'Path B close — POI is the last good block; operator MUST verify with other indexers.' +
        pathBNoBlockSuffix,
    };
  }

  return {
    closability: 'none',
    reason: `Failed with non-deterministic error below epoch start (latestBlock=${latestBlock} < epochStartBlock=${epochStartBlock}); cannot safely close — operator review required.`,
  };
}

/**
 * Pick the chain alias to use when looking up epoch-start blocks for a
 * deployment. Most deployments have exactly one chain entry; for the rare
 * multi-chain deployment we pick the first and let the operator notice via
 * the warnings list (multi-chain isn't supported by the §4.2 matrix as
 * written).
 */
function pickChain(status: SubgraphIndexingStatus | null): string | null {
  if (!status) return null;
  const first = status.chains[0];
  return first ? first.network : null;
}

function pickLatestBlock(
  status: SubgraphIndexingStatus,
  chain: string | null,
): number | null {
  // Prefer the chain we picked; fall back to whichever has a latestBlock.
  let row: ChainIndexingStatus | undefined;
  if (chain) {
    row = status.chains.find((c) => c.network === chain);
  }
  if (!row) row = status.chains.find((c) => c.latestBlock !== undefined);
  if (!row?.latestBlock) return null;
  return safeToInt(row.latestBlock.number);
}

function pickLastHealthyBlock(
  status: SubgraphIndexingStatus,
  chain: string | null,
): number | null {
  // Mirror pickLatestBlock: prefer the chosen chain, fall back to whichever
  // row reports a lastHealthyBlock.
  let row: ChainIndexingStatus | undefined;
  if (chain) {
    row = status.chains.find((c) => c.network === chain);
  }
  if (!row?.lastHealthyBlock) {
    row = status.chains.find((c) => c.lastHealthyBlock !== undefined);
  }
  if (!row?.lastHealthyBlock) return null;
  return safeToInt(row.lastHealthyBlock.number);
}

interface TimingInput {
  currentEpochNumber: number;
  epochLengthBlocks: number;
  protocolEpochStartBlock: number | null;
}

function computeTiming(input: TimingInput): EpochTiming {
  const { currentEpochNumber, epochLengthBlocks, protocolEpochStartBlock } = input;

  if (protocolEpochStartBlock === null || epochLengthBlocks <= 0) {
    return {
      currentEpoch: currentEpochNumber,
      hoursUntilNextEpoch: Number.NaN,
      epochLengthBlocks,
      currentBlock: 0,
    };
  }

  // Without a live "current block" reading on the protocol chain, we
  // approximate by assuming the current block is roughly midway through the
  // epoch when first observed — but that's not actionable. Instead, we
  // expose the epoch-start block as the "currentBlock" baseline and let the
  // composite tool refine it if it has a richer protocol-chain block source.
  // Operators reading hoursUntilNextEpoch should treat it as "hours from
  // epoch start to flip" minus elapsed time — we can only compute the former
  // here. To avoid misleading callers we surface the FULL epoch length in
  // hours as a ceiling and warn via NaN when we genuinely don't know.
  //
  // Practical workaround: estimate elapsed time using `Date.now()` is not
  // possible without an anchor timestamp on the epoch-start block, which we
  // don't have. So we return the full epoch-length-in-hours, which is the
  // MAXIMUM possible time remaining. The composite tool / operator must
  // refine if a tighter estimate is needed.
  const fullEpochHours =
    (epochLengthBlocks * PROTOCOL_CHAIN_SECONDS_PER_BLOCK) / 3600;

  return {
    currentEpoch: currentEpochNumber,
    // Upper bound — see comment above. Operators must treat as "could be
    // anything from ~0 to this value"; pre-epoch alerts should kick in
    // generously based on this ceiling.
    hoursUntilNextEpoch: fullEpochHours,
    epochLengthBlocks,
    currentBlock: protocolEpochStartBlock,
  };
}

/**
 * Risk tier matrix (design §4.2 — corrected):
 *
 *   critical: failingHealth AND isLargeAlloc AND urgent
 *   high:     (failingHealth AND isLargeAlloc)
 *             OR (failingHealth AND urgent)
 *             OR (notClosable AND failingHealth)
 *   medium:   failingHealth (any one of: large, urgent, notClosable alone)
 *   low:      healthy
 *
 *   failingHealth = health === 'unhealthy' || health === 'failed'
 *   isLargeAlloc  = allocatedTokens >= LARGE_ALLOCATION_WEI (absolute floor)
 *                   OR allocatedTokens > 2 * medianAllocatedTokens (relative)
 *                   OR (fallback: allocatedTokens > 0n) if no medians available
 *   urgent        = hoursUntilNextEpoch < urgencyThresholdHours
 *   notClosable   = closability === 'none' && failingHealth
 *
 * NOTE: notClosable is INTENTIONALLY no longer an automatic bump to critical.
 * Those allocations also appear in `blockedFromClose` for explicit operator
 * routing; their risk tier reflects size/urgency honestly.
 */
function assessRisk(
  ah: AllocationHealth,
  timing: EpochTiming,
  urgencyThresholdHours: number,
  medianAllocatedTokens: bigint,
): RiskAssessment {
  const reasons: string[] = [];

  const failingHealth = ah.health === 'unhealthy' || ah.health === 'failed';
  const urgent =
    !Number.isNaN(timing.hoursUntilNextEpoch) &&
    timing.hoursUntilNextEpoch < urgencyThresholdHours;
  const notClosable = ah.closability === 'none' && failingHealth;

  // Determine "large":
  //   1. Absolute floor (100k GRT) — best signal across indexers.
  //   2. Relative floor (>2x current-run median) — catches "large for THIS
  //      indexer" on smaller stakes.
  //   3. Fallback (> 0) — degrade gracefully when we have no comparator.
  let isLargeAlloc: boolean;
  let largeReason: string;
  if (ah.allocatedTokens >= LARGE_ALLOCATION_WEI) {
    isLargeAlloc = true;
    largeReason = `Large allocation (>= ${LARGE_ALLOCATION_WEI.toString()} wei / 100k GRT).`;
  } else if (medianAllocatedTokens > 0n && ah.allocatedTokens > medianAllocatedTokens * 2n) {
    isLargeAlloc = true;
    largeReason = `Allocation is >2x the median for this run (median=${medianAllocatedTokens.toString()} wei, this=${ah.allocatedTokens.toString()} wei).`;
  } else if (medianAllocatedTokens === 0n && ah.allocatedTokens > 0n) {
    isLargeAlloc = true;
    largeReason = 'No comparator available; treating any non-zero allocation as large (degraded fallback).';
  } else {
    isLargeAlloc = false;
    largeReason = '';
  }

  // Healthy → low, no further tiering.
  if (!failingHealth) {
    reasons.push('Deployment is healthy.');
    return { allocationId: ah.allocationId, level: 'low', reasons };
  }

  // From here down: failingHealth is true.
  reasons.push(
    ah.health === 'failed'
      ? 'Deployment health is FAILED.'
      : 'Deployment health is unhealthy (non-fatal errors).',
  );
  if (isLargeAlloc) reasons.push(largeReason);
  if (urgent) {
    reasons.push(
      `Less than ${urgencyThresholdHours}h until epoch flip (estimated ${timing.hoursUntilNextEpoch.toFixed(1)}h).`,
    );
  }
  if (notClosable) {
    reasons.push(
      'Allocation cannot be safely closed this epoch (closability=none); surfaced via blockedFromClose for operator review.',
    );
  }

  // Apply the matrix in priority order.
  let level: RiskLevel;
  if (isLargeAlloc && urgent) {
    level = 'critical';
    reasons.push('Tier: critical — failingHealth AND large AND urgent.');
  } else if (isLargeAlloc || urgent || notClosable) {
    level = 'high';
    const triggers: string[] = [];
    if (isLargeAlloc) triggers.push('large');
    if (urgent) triggers.push('urgent');
    if (notClosable) triggers.push('notClosable');
    reasons.push(`Tier: high — failingHealth AND (${triggers.join(' or ')}).`);
  } else {
    level = 'medium';
    reasons.push('Tier: medium — failingHealth without any of (large, urgent, notClosable).');
  }

  return { allocationId: ah.allocationId, level, reasons };
}

/**
 * BigInt median. Returns 0n on empty input. For even-length inputs returns
 * the lower of the two middle values (avoids fractional BigInt math).
 */
function median(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] ?? 0n;
}

function matchHeuristic(message: string): RecoveryHeuristic | null {
  if (!message) return null;
  const haystack = message.toLowerCase();
  for (const h of RECOVERY_HEURISTICS) {
    if (h.pattern) {
      if (h.pattern.test(message)) return h;
      continue;
    }
    if (h.needles && h.needles.every((n) => haystack.includes(n))) return h;
  }
  return null;
}

function safeToInt(value: string | number): number {
  if (typeof value === 'number') return Math.trunc(value);
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot parse "${value}" as integer.`);
  }
  return n;
}

function safeToBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    // Match the WHATWG abort error contract.
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error('HealthMonitor.run() aborted');
  }
}
