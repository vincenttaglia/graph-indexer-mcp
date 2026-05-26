import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AllocationOptimizer,
  calculateApr,
  type OptimizerConfig,
} from '../../src/services/allocation-optimizer.js';
import {
  allocation,
  deployment,
  fakeAgentClient,
  fakeGraphmanClient,
  fakeGraphNodeClient,
  fakeNetworkClient,
  fakeQosClient,
  indexer,
  indexingStatus,
  networkParams,
} from '../fakes.js';

const INDEXER = '0x0000000000000000000000000000000000000001';
const GRT = (n: bigint): bigint => n * 10n ** 18n;

// Real Qm deployment IDs (CIDv0 of bytes32 0x000...01, 0x000...02, …). The
// optimizer's `normalizeToQm` helper is strict — it throws on anything that
// isn't valid bytes32 or Qm — so test fixtures must use real Qm IDs rather
// than synthetic `Qm_xxx` strings. Each constant maps 1:1 to a previously
// synthetic fixture id so test semantics are unchanged.
const Q = {
  RUNNING: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh52',   // 0x…01
  PAUSED: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh53',    // 0x…02
  LOW: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh54',       // 0x…03
  OK: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh55',        // 0x…04
  WL_LOW: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh56',    // 0x…05
  BOTH: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh57',      // 0x…06
  NOW_LOW: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh58',   // 0x…07
  FROZEN: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh59',    // 0x…08
  RISK: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5A',      // 0x…09
  DUST: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5B',      // 0x…0a
} as const;

function baseConfig(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
  return {
    indexerAddress: INDEXER,
    maxAllocations: 10,
    maxAllocationPct: 0.2,
    riskyDeploymentCapPct: 0.05,
    minSignal: GRT(1_000n),
    gasEstimateGrt: GRT(10n),
    whitelist: [],
    blacklist: [],
    frozenlist: [],
    riskyDeployments: [],
    ...over,
  };
}

describe('calculateApr', () => {
  it('returns 0 when totalSignal is 0', () => {
    const apr = calculateApr({
      signal: 100n,
      totalSignal: 0n,
      issuancePerYear: 1n,
      proposedAllocation: 1n,
      otherIndexersAllocation: 0n,
    });
    assert.equal(apr, 0);
  });

  it('returns 0 when total allocation (other + proposed) is 0', () => {
    const apr = calculateApr({
      signal: 100n,
      totalSignal: 1000n,
      issuancePerYear: 1n,
      proposedAllocation: 0n,
      otherIndexersAllocation: 0n,
    });
    assert.equal(apr, 0);
  });

  it('computes the canonical APR formula', () => {
    // signal=1e21 (1000 GRT signal), totalSignal=1e22 (10x),
    // issuancePerYear=3e24, proposedAllocation=1e20 (100 GRT),
    // otherIndexersAllocation=9e20 (900 GRT)
    // apr = (signal * issuancePerYear) / (totalSignal * (other + proposed))
    //     = (1e21 * 3e24) / (1e22 * 1e21) = 3e45 / 1e43 = 300
    const apr = calculateApr({
      signal: 10n ** 21n,
      totalSignal: 10n ** 22n,
      issuancePerYear: 3n * 10n ** 24n,
      proposedAllocation: 10n ** 20n,
      otherIndexersAllocation: 9n * 10n ** 20n,
    });
    assert.equal(Math.round(apr), 300);
  });

  it('scales linearly with signal share', () => {
    const baseArgs = {
      totalSignal: 10n ** 22n,
      issuancePerYear: 3n * 10n ** 24n,
      proposedAllocation: 10n ** 20n,
      otherIndexersAllocation: 9n * 10n ** 20n,
    };
    const aprLow = calculateApr({ ...baseArgs, signal: 10n ** 21n });
    const aprHigh = calculateApr({ ...baseArgs, signal: 2n * 10n ** 21n });
    assert.ok(aprHigh > aprLow);
    assert.equal(Math.round(aprHigh / aprLow), 2);
  });
});

describe('AllocationOptimizer.run', () => {
  it('throws nothing and returns empty plan when the indexer is missing', async () => {
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({ indexer: null }),
      graphNodeClient: fakeGraphNodeClient(),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(baseConfig());
    assert.equal(result.proposedAllocations.length, 0);
    assert.ok(result.warnings.some((w) => w.includes('not found')));
  });

  it('does not throw and records errors when every gather source fails', async () => {
    const boom = new Error('boom');
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        // indexer fetch succeeds so the workflow runs through to gather
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        networkParams: networkParams(),
        // signalled and active throw — verifies allSettled
        throwOnGetSignalledDeployments: boom,
        throwOnGetActiveAllocations: boom,
      }),
      graphNodeClient: fakeGraphNodeClient({ throwOnGetIndexingStatuses: boom }),
      // graphmanClient intentionally omitted — the optimizer's read path no
      // longer touches graphman, so the test no longer needs to wire one.
      qosClient: fakeQosClient({ throwOnTopQueried: boom }),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(baseConfig({ whitelist: [] }));
    assert.ok(result.errors.length >= 2);
    assert.equal(result.proposedAllocations.length, 0);
  });

  it('excludes a deployment whose graph-node status reports paused=true (no graphman wired)', async () => {
    // Pause state used to come from graphman.getDeploymentInfo; it now
    // comes from graph-node's indexingStatuses.paused. Prove the new path
    // by wiring graphmanClient: undefined and asserting the paused
    // deployment is filtered out and never proposed for allocation.
    const okDep = deployment({ id: Q.RUNNING, signal: GRT(50_000n), staked: GRT(1n) });
    const pausedDep = deployment({ id: Q.PAUSED, signal: GRT(50_000n), staked: GRT(1n) });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [okDep, pausedDep],
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [
          indexingStatus({ id: Q.RUNNING }),
          indexingStatus({ id: Q.PAUSED, paused: true }),
        ],
      }),
      // No graphmanClient — proves the optimizer runs end-to-end without
      // graphman wired and still honors pause state.
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(baseConfig({ gasEstimateGrt: GRT(0n) }));
    const ids = result.proposedAllocations.map((p) => p.deploymentId);
    assert.ok(
      ids.includes(Q.RUNNING),
      `expected Qm_running in plan; got ${JSON.stringify(ids)}`,
    );
    assert.ok(
      !ids.includes(Q.PAUSED),
      `paused deployment must be excluded; got ${JSON.stringify(ids)}`,
    );
    // Sanity: no graphman-related errors should appear in the result —
    // we never called graphman so we can't have failed against it.
    for (const e of result.errors) {
      assert.ok(
        !/graphman/i.test(e),
        `expected no graphman errors; got: ${e}`,
      );
    }
  });

  it('drops candidates below minSignal unless whitelisted', async () => {
    const lowSig = deployment({ id: Q.LOW, signal: GRT(10n), staked: GRT(1n) });
    const okSig = deployment({ id: Q.OK, signal: GRT(10_000n), staked: GRT(1n) });
    const wlLow = deployment({ id: Q.WL_LOW, signal: GRT(10n), staked: GRT(1n) });
    const cfg = baseConfig({
      minSignal: GRT(5_000n),
      whitelist: [Q.WL_LOW],
      gasEstimateGrt: GRT(0n), // disable gas floor so we test the candidate filter in isolation
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        signalledDeployments: [lowSig, okSig],
        // signalledDeployments query is filtered server-side by minSignal, so
        // the low-signal one wouldn't normally arrive. We include the
        // whitelisted one via deploymentsById for hydration.
        deploymentsById: { [Q.WL_LOW]: wlLow },
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [
          indexingStatus({ id: Q.OK }),
          indexingStatus({ id: Q.WL_LOW }),
        ],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(cfg);
    const ids = result.proposedAllocations.map((p) => p.deploymentId).sort();
    // wl_low survives (whitelist exempt), ok_sig survives. low (no whitelist) dropped.
    assert.deepEqual(ids, [Q.OK, Q.WL_LOW]);
  });

  it('blacklist beats whitelist when both set', async () => {
    const dep = deployment({ id: Q.BOTH, signal: GRT(100_000n) });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        signalledDeployments: [dep],
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.BOTH })],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({ whitelist: [Q.BOTH], blacklist: [Q.BOTH] }),
    );
    assert.equal(result.proposedAllocations.length, 0);
  });

  it('preserves a current allocation whose signal dipped below minSignal (survives the candidate filter and stays in the plan)', async () => {
    // Finding 2 from the source: a deployment whose signal dipped below
    // minSignal between runs should NOT be force-dropped by the candidate
    // filter when the indexer already has an allocation on it. The candidate
    // must survive filtering AND land in `proposedAllocations`, AND must NOT
    // produce an `unallocate` action.
    const lowDep = deployment({ id: Q.NOW_LOW, signal: GRT(10n), staked: GRT(50n) });
    const alloc = allocation({
      id: '0xalloc1',
      deploymentId: Q.NOW_LOW,
      allocatedTokens: GRT(50n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        // Subgraph-side minSignal filter dropped it, so it won't be in
        // signalledDeployments. Hydration via deploymentsById fills it in.
        signalledDeployments: [],
        activeAllocations: [alloc],
        deploymentsById: { [Q.NOW_LOW]: lowDep },
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.NOW_LOW })],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({
        minSignal: GRT(5_000n),
        // Bypass the gas floor so we test preservation in isolation —
        // separately covered by `skips a candidate when projected annual
        // reward < 2x gas budget`.
        gasEstimateGrt: GRT(0n),
      }),
    );
    assert.equal(result.state.candidatesConsidered, 1);
    assert.equal(result.state.candidatesAfterFilter, 1);
    // Preservation: deployment must appear in proposedAllocations.
    assert.ok(
      result.proposedAllocations.some((p) => p.deploymentId === Q.NOW_LOW),
      `expected Qm_now_low in proposedAllocations, got: ${JSON.stringify(
        result.proposedAllocations.map((p) => p.deploymentId),
      )}`,
    );
    // Preservation: must NOT emit an `unallocate` action against it. If the
    // filter regressed and the candidate dropped pre-plan, the diff would
    // emit unallocate (current ∋ id, proposed ∌ id).
    const unallocatesForLow = result.actions
      .filter((a) => a.deploymentId === Q.NOW_LOW && a.type === 'unallocate')
      .map((a) => ({
        type: a.type,
        deploymentId: a.deploymentId,
        amount: a.amount?.toString() ?? null,
      }));
    assert.equal(
      unallocatesForLow.length,
      0,
      `expected no unallocate action for Qm_now_low, got: ${JSON.stringify(
        unallocatesForLow,
      )}`,
    );
  });

  it('frozen deployment is preserved at current size and reserves a slot', async () => {
    const dep = deployment({ id: Q.FROZEN, signal: GRT(50_000n) });
    const alloc = allocation({
      id: '0xfrozen',
      deploymentId: Q.FROZEN,
      allocatedTokens: GRT(123_456n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        signalledDeployments: [dep],
        activeAllocations: [alloc],
        deploymentsById: { [Q.FROZEN]: dep },
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.FROZEN })],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({ frozenlist: [Q.FROZEN], maxAllocations: 1 }),
    );
    // Frozen entry appears in proposal at exact current size.
    const frozenProp = result.proposedAllocations.find(
      (p) => p.deploymentId === Q.FROZEN,
    );
    assert.ok(frozenProp);
    assert.equal(frozenProp!.allocatedTokens, GRT(123_456n));
    // No diff actions for frozen.
    assert.equal(
      result.actions.filter((a) => a.deploymentId === Q.FROZEN).length,
      0,
    );
  });

  it('risky deployment is sized by riskyDeploymentCapPct, not maxAllocationPct', async () => {
    // Pick a single candidate so the signal-share branch lands on the same
    // amount = availableStake, which then gets capped.
    const dep = deployment({ id: Q.RISK, signal: GRT(100_000n), staked: GRT(1n) });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [dep],
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.RISK })],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const cfg = baseConfig({
      maxAllocationPct: 0.5,
      riskyDeploymentCapPct: 0.05,
      riskyDeployments: [Q.RISK],
      gasEstimateGrt: GRT(0n), // skip the gas floor for the assertion
    });
    const result = await opt.run(cfg);
    const prop = result.proposedAllocations[0];
    assert.ok(prop);
    // 5% of 1,000,000 GRT = 50,000 GRT in wei.
    assert.equal(prop!.allocatedTokens, GRT(50_000n));
    assert.ok(/risky/i.test(prop!.rationale));
  });

  it('handles bytes32-form candidate IDs against Qm-form status responses (regression: §4.1 step 2.1 dropped every candidate)', async () => {
    // Live reproducer for the deployment-id encoding mismatch.
    //
    // The network subgraph stores `SubgraphDeployment.id` as bytes32
    // (`0x…`), but graph-node's `indexingStatuses.subgraph` field comes
    // back in Qm (IPFS CIDv0) form. Before the fix, AllocationOptimizer
    // built `statusById` keyed by the Qm response value, then looked it up
    // via the bytes32 candidate id — every lookup missed, every candidate
    // appeared to have "no status available", the §4.1 step 2.1 sync /
    // health gate filtered them all out, candidatesAfterFilter dropped to
    // 0, and the optimizer recommended closing every existing allocation
    // as "no longer worth keeping".
    //
    // The id pair below (0xebdb…459c ↔ Qm…CFu) is a real bytes32/Qm pair
    // computed via the project's `toQmDeploymentId` helper. If the bug
    // regresses, candidatesAfterFilter falls to 0 and the assertion below
    // catches it.
    const bytes32Id =
      '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
    const qmId = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

    const dep = deployment({
      id: bytes32Id,
      signal: 100_000n * 10n ** 18n,
      staked: GRT(1n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        // signalled deployment carries the bytes32 id, matching what the
        // network subgraph really returns.
        signalledDeployments: [dep],
        networkParams: networkParams(),
      }),
      graphNodeClient: fakeGraphNodeClient({
        // Fake returns the status with the Qm id, matching real graph-node
        // behavior. Before the fix, statusById would be keyed by qmId and
        // miss every lookup against the bytes32 candidate.
        statuses: [indexingStatus({ id: qmId })],
      }),
      qosClient: fakeQosClient(),
      // graphmanClient omitted — services should work without it.
      agentClient: fakeAgentClient(),
    });

    const result = await opt.run(baseConfig({ gasEstimateGrt: GRT(0n) }));

    // Without the fix: candidatesAfterFilter === 0 (status missing → §4.1
    // step 2.1 sync/health gate drops the candidate).
    assert.equal(
      result.state.candidatesAfterFilter,
      1,
      `expected the bytes32 candidate to survive the filter via Qm-normalized status lookup; ` +
        `if 0, the Qm vs bytes32 key mismatch is back`,
    );

    // The proposal preserves the operator's original ID format (bytes32),
    // so consumers downstream (indexer-agent action queue, action UI) see
    // the same shape they configured rather than a denormalized Qm.
    assert.ok(
      result.proposedAllocations.some((p) => p.deploymentId === bytes32Id),
      `expected candidate proposed with original bytes32 id; got: ${JSON.stringify(
        result.proposedAllocations.map((p) => p.deploymentId),
      )}`,
    );
  });

  it('skips a candidate when projected annual reward < 2x gas budget', async () => {
    // Build a deployment that passes minSignal but has tiny signal share so
    // projected rewards are dwarfed by an artificially huge gas budget.
    const dep = deployment({
      id: Q.DUST,
      signal: GRT(5_000n), // > minSignal of 1k GRT, but tiny vs totalSignal below
      staked: GRT(1_000_000n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [dep],
        networkParams: networkParams({
          // 1e12 GRT total signal — dwarfs the per-deployment 5k GRT.
          totalTokensSignalled: (10n ** 30n).toString(),
        }),
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.DUST })],
      }),
      graphmanClient: fakeGraphmanClient(),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({ minSignal: GRT(1_000n), gasEstimateGrt: GRT(1_000_000_000n) }),
    );
    assert.equal(result.proposedAllocations.length, 0);
    assert.ok(
      result.warnings.some((w) => /2× gas budget/.test(w)),
      `expected gas-floor warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it('skips malformed config IDs with a warning instead of poisoning the graph-node batch (regression: lenient normalizeToQm fell back to raw, tainting candidateIdList)', async () => {
    // Audit High: before the fix, `normalizeToQm` caught conversion
    // failures and silently fell back to the raw, case-preserved input.
    // That raw value entered `candidateIdList` and was passed to
    // `graphNodeClient.getIndexingStatuses(...)`. The graph-node client
    // rejects the entire batch on a single invalid ID — so any typo in
    // `whitelist`, `frozenlist`, `riskyDeployments`, or any malformed
    // upstream deployment ID would cause `statusesRes` to reject,
    // `statusById` to stay empty, the §4.1 health/sync gate to drop
    // every candidate, and the optimizer to recommend closing every
    // allocation (the "close everything" failure).
    //
    // Strict behavior under test:
    //   - A `GARBAGE` whitelist entry produces a per-entry warning naming
    //     the bad input and is dropped from the whitelist.
    //   - A valid sibling deployment in the same run still surfaces in
    //     `proposedAllocations` (proving the bad entry did not poison the
    //     batch).
    const goodDep = deployment({
      id: Q.OK,
      signal: GRT(50_000n),
      staked: GRT(1n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [goodDep],
        networkParams: networkParams(),
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: Q.OK })],
      }),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({
        whitelist: ['GARBAGE', Q.OK],
        frozenlist: ['ALSO_BAD'],
        gasEstimateGrt: GRT(0n),
      }),
    );

    // Per-source warning naming the bad whitelist entry.
    assert.ok(
      result.warnings.some(
        (w) => /Whitelist/i.test(w) && /GARBAGE/.test(w),
      ),
      `expected a Whitelist warning naming GARBAGE, got: ${JSON.stringify(result.warnings)}`,
    );
    // Per-source warning naming the bad frozenlist entry.
    assert.ok(
      result.warnings.some(
        (w) => /Frozenlist/i.test(w) && /ALSO_BAD/.test(w),
      ),
      `expected a Frozenlist warning naming ALSO_BAD, got: ${JSON.stringify(result.warnings)}`,
    );
    // The good candidate still flows through end-to-end despite the bad
    // siblings — proving the batch wasn't poisoned.
    assert.equal(
      result.state.candidatesAfterFilter,
      1,
      `good candidate should still be processed despite bad whitelist/frozenlist entries`,
    );
    assert.ok(
      result.proposedAllocations.some((p) => p.deploymentId === Q.OK),
      `expected the valid candidate to land in proposedAllocations; got: ${JSON.stringify(
        result.proposedAllocations.map((p) => p.deploymentId),
      )}`,
    );
  });

  it('distributes stake by signal/stake ratio not raw signal', async () => {
    // Two candidates with equal signal but very different saturation:
    //   A: S=10k, other_stake=15M (saturated, low marginal APR)
    //   B: S=10k, other_stake=100k (underallocated, high marginal APR)
    // With raw-signal weighting both would get equal stake; with signal/
    // stake weighting B should get materially more (the cap typically
    // bounds the absolute ratio in tests, but B > 5×A is a strong signal
    // that the marginal-APR weighting is in effect).
    const A = deployment({
      id: Q.OK,
      signal: GRT(10_000n),
      staked: GRT(15_000_000n),
    });
    const B = deployment({
      id: Q.RUNNING,
      signal: GRT(10_000n),
      staked: GRT(100_000n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [A, B],
        networkParams: networkParams(),
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [
          indexingStatus({ id: Q.OK }),
          indexingStatus({ id: Q.RUNNING }),
        ],
      }),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await opt.run(
      baseConfig({ maxAllocations: 2, gasEstimateGrt: GRT(0n) }),
    );
    const aAmount =
      result.proposedAllocations.find((p) => p.deploymentId === Q.OK)
        ?.allocatedTokens ?? 0n;
    const bAmount =
      result.proposedAllocations.find((p) => p.deploymentId === Q.RUNNING)
        ?.allocatedTokens ?? 0n;
    assert.ok(
      aAmount > 0n,
      `expected saturated A to still receive some stake; got A=${aAmount}`,
    );
    assert.ok(
      bAmount > 5n * aAmount,
      `expected B (low other-stake) to get >5× more stake than A (saturated); ` +
        `got A=${aAmount}, B=${bAmount}`,
    );
  });

  it('handles fresh deployments with zero other_indexers_stake (floor weight, no Infinity)', async () => {
    // Fresh deployment (no other indexers) gets the floor in the denominator
    // so its weight is large-but-finite. Compare against a saturated peer.
    // The fresh one should outrank the saturated one and stay bounded by
    // the per-deployment cap.
    const fresh = deployment({
      id: Q.OK,
      signal: GRT(1_000n),
      staked: 0n,
    });
    const saturated = deployment({
      id: Q.RUNNING,
      signal: GRT(1_000n),
      staked: GRT(1_000_000n),
    });
    const opt = new AllocationOptimizer({
      networkClient: fakeNetworkClient({
        indexer: indexer({ stakedTokens: GRT(1_000_000n).toString() }),
        signalledDeployments: [fresh, saturated],
        networkParams: networkParams(),
      }),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [
          indexingStatus({ id: Q.OK }),
          indexingStatus({ id: Q.RUNNING }),
        ],
      }),
      qosClient: fakeQosClient(),
      agentClient: fakeAgentClient(),
    });
    const cfg = baseConfig({
      maxAllocations: 2,
      maxAllocationPct: 0.2,
      gasEstimateGrt: GRT(0n),
    });
    const result = await opt.run(cfg);
    const freshAmount =
      result.proposedAllocations.find((p) => p.deploymentId === Q.OK)
        ?.allocatedTokens ?? 0n;
    // Fresh deployment must still receive an allocation (no Infinity / NaN
    // crash, no divide-by-zero) and be bounded by the per-deployment cap.
    // Cap = 0.2 × 1,000,000 GRT = 200,000 GRT.
    const cap = GRT(200_000n);
    assert.ok(
      freshAmount > 0n,
      `expected fresh deployment to receive an allocation; got ${freshAmount}`,
    );
    assert.ok(
      freshAmount <= cap,
      `expected fresh deployment to be bounded by per-deployment cap; ` +
        `got ${freshAmount} > cap ${cap}`,
    );
  });
});
