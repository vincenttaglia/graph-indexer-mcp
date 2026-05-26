import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryEngine,
  type DiscoveryConfig,
} from '../../src/services/discovery-engine.js';
import {
  allocation,
  deployment,
  fakeAgentClient,
  fakeGraphmanClient,
  fakeGraphNodeClient,
  fakeNetworkClient,
  fakePostgresClient,
  fakeQosClient,
  indexingStatus,
  networkParams,
} from '../fakes.js';

const INDEXER = '0x0000000000000000000000000000000000000001';
const GRT = (n: bigint): bigint => n * 10n ** 18n;

// Real Qm deployment IDs (CIDv0 of bytes32 0x000...01, 0x000...02, …).
// `normalizeDeploymentId` is strict — it throws on anything that isn't valid
// bytes32 or Qm — so test fixtures must use real Qm IDs rather than the
// synthetic `Qm_xxx` placeholders the pre-audit fixtures used.
const Q = {
  STALE: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh52',           // 0x…01
  DROP_TEST: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh53',       // 0x…02
  NODE_NULL: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh54',       // 0x…03
  FROZEN: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh55',          // 0x…04
  OK: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh56',              // 0x…05
  DENIED: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh57',          // 0x…06
  BOTH: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh58',            // 0x…07
  A: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh59',               // 0x…08
  B: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5A',               // 0x…09
  C: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5B',               // 0x…0a
  HI_APR: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5C',          // 0x…0b
  LO_APR: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh5D',          // 0x…0c
} as const;

function baseConfig(over: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    indexerAddress: INDEXER,
    minSignal: GRT(1_000n),
    typicalAllocationGrt: GRT(50_000n),
    whitelist: [],
    blacklist: [],
    frozenlist: [],
    maxCandidates: 10,
    ...over,
  };
}

describe('DiscoveryEngine cleanup', () => {
  it('emits steps in the canonical order for a stale allocated deployment', async () => {
    // unallocated reason needs hasSignal=false. Use a synced, unsignalled
    // deployment that the indexer DOES have an allocation on.
    const depId = Q.STALE;
    const alloc = allocation({
      id: '0xstale',
      deploymentId: depId,
      allocatedTokens: GRT(10_000n),
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [],
        activeAllocations: [alloc],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: depId, synced: true })],
      }),
      postgresClient: fakePostgresClient(),
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    const cleanupForStale = result.cleanup.find((c) => c.deploymentId === depId);
    assert.ok(cleanupForStale, 'expected cleanup action for stale allocated deployment');
    assert.deepEqual(cleanupForStale!.steps, [
      'close_allocation',
      'pause',
      'unassign',
      'unused_record',
      'unused_remove',
    ]);
  });

  it('never includes drop in cleanup steps', async () => {
    const depId = Q.DROP_TEST;
    const alloc = allocation({
      id: '0xd',
      deploymentId: depId,
      allocatedTokens: GRT(10_000n),
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [],
        activeAllocations: [alloc],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: depId, synced: true })],
      }),
      postgresClient: fakePostgresClient(),
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    for (const action of result.cleanup) {
      assert.ok(
        !action.steps.includes('drop' as never),
        'drop must never appear in cleanup steps',
      );
    }
  });

  it('node:null alone is NOT enough to classify a deployment orphaned — audit-hardened against false-positive cleanup', async () => {
    // Audit High: the prior implementation classified any deployment with
    // `status.node === null` as orphaned. That mis-fires when older
    // graph-node versions omit the field (the client normalizer defaults
    // it to null), or on transient unassignment during node restarts.
    // The conjunctive rule (paused + no-allocation + no-signal) is now the
    // ONLY trigger for `orphaned`; node:null on its own must not produce
    // any cleanup action.
    //
    // The synthetic case here pairs `node: null` with `paused: false` and
    // a non-empty allocation set, which is the worst-case shape: an older
    // graph-node returning null for `node` on a still-allocated deployment.
    // Expectation: no orphaned classification, no cleanup action, no
    // graphman dependency.
    const depId = Q.NODE_NULL;
    const alloc = allocation({
      id: '0xalloc',
      deploymentId: depId,
      allocatedTokens: GRT(10_000n),
    });
    // Also include a signalled deployment so the deployment looks healthy
    // along every dimension except `node`.
    const signalled = deployment({ id: depId, signal: GRT(50_000n) });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [signalled],
        activeAllocations: [alloc],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [
          indexingStatus({ id: depId, synced: true, node: null, paused: false }),
        ],
      }),
      postgresClient: fakePostgresClient(),
      // graphmanClient intentionally omitted — proves discovery's read path
      // does not depend on graphman.
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());

    // No orphaned classification.
    const staleEntry = result.stale.find((s) => s.deploymentId === depId);
    assert.equal(
      staleEntry,
      undefined,
      `node:null alone must not produce a stale entry; got ${JSON.stringify(staleEntry)}`,
    );

    // No cleanup action.
    assert.equal(
      result.cleanup.filter((c) => c.deploymentId === depId).length,
      0,
      'node:null alone must not produce a cleanup action',
    );

    // Sanity: no graphman-related warnings (discovery's read path is
    // graphman-free regardless of classification).
    for (const w of result.warnings) {
      assert.ok(
        !/graphman/i.test(w),
        `expected no graphman warnings; got: ${w}`,
      );
    }
  });

  it('frozen deployment appears in stale[] but produces NO cleanup action; warning emitted', async () => {
    const depId = Q.FROZEN;
    const alloc = allocation({
      id: '0xf',
      deploymentId: depId,
      allocatedTokens: GRT(10_000n),
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [],
        activeAllocations: [alloc],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        statuses: [indexingStatus({ id: depId, synced: true })],
      }),
      postgresClient: fakePostgresClient(),
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig({ frozenlist: [depId] }));
    const staleEntry = result.stale.find((s) => s.deploymentId === depId);
    assert.ok(staleEntry, 'expected stale entry for frozen deployment');
    assert.equal(staleEntry!.isFrozen, true);
    assert.equal(
      result.cleanup.filter((c) => c.deploymentId === depId).length,
      0,
      'expected no cleanup action for frozen deployment',
    );
    assert.ok(
      result.warnings.some((w) => w.includes('frozen') && w.includes(depId)),
      'expected frozen-skip warning',
    );
  });
});

describe('DiscoveryEngine discovery filter', () => {
  it('drops deployments with deniedAt !== 0 and emits aggregate warning', async () => {
    const ok = deployment({ id: Q.OK, signal: GRT(50_000n) });
    const denied = deployment({
      id: Q.DENIED,
      signal: GRT(50_000n),
      deniedAt: 1234567,
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [ok, denied],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient(),
      postgresClient: null,
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    const ids = result.opportunities.map((o) => o.deploymentId);
    assert.ok(!ids.includes(Q.DENIED));
    assert.ok(ids.includes(Q.OK));
    assert.ok(result.warnings.some((w) => /rewards are denied/.test(w)));
  });

  it('blacklist wins over whitelist', async () => {
    const dep = deployment({ id: Q.BOTH, signal: GRT(50_000n) });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [dep],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient(),
      postgresClient: null,
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(
      baseConfig({ whitelist: [Q.BOTH], blacklist: [Q.BOTH] }),
    );
    assert.equal(
      result.opportunities.filter((o) => o.deploymentId === Q.BOTH).length,
      0,
    );
  });

  it('skips malformed config IDs with a warning instead of poisoning the lookup maps (regression: lenient normalizeDeploymentId fell back to lowercase)', async () => {
    // Audit Medium: before the fix, `normalizeDeploymentId` caught
    // conversion failures and fell back to `raw.toLowerCase()`. That
    // unique-keyed string then entered whitelist / blacklist / frozenlist
    // / syncingIds / sizesById lookup maps and never matched anything
    // downstream — silently poisoning the lookups while looking
    // successful from the outside.
    //
    // Strict behavior under test:
    //   - A `GARBAGE` whitelist entry produces a per-entry warning naming
    //     the bad input and is dropped from the whitelist.
    //   - A malformed blacklist + frozenlist entry produces the same
    //     per-source warning.
    //   - The valid sibling candidate still survives discovery filtering
    //     and surfaces in `opportunities` — proving the bad entries did
    //     not block the rest of the run.
    const good = deployment({ id: Q.OK, signal: GRT(50_000n) });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [good],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient(),
      postgresClient: null,
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(
      baseConfig({
        whitelist: ['GARBAGE', Q.OK],
        blacklist: ['ALSO_BAD'],
        frozenlist: ['STILL_BAD'],
      }),
    );

    // Per-source warnings naming each bad input.
    assert.ok(
      result.warnings.some(
        (w) => /Whitelist/i.test(w) && /GARBAGE/.test(w),
      ),
      `expected a Whitelist warning naming GARBAGE, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.some(
        (w) => /Blacklist/i.test(w) && /ALSO_BAD/.test(w),
      ),
      `expected a Blacklist warning naming ALSO_BAD, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.some(
        (w) => /Frozenlist/i.test(w) && /STILL_BAD/.test(w),
      ),
      `expected a Frozenlist warning naming STILL_BAD, got: ${JSON.stringify(result.warnings)}`,
    );
    // The valid candidate still flows through end-to-end.
    assert.ok(
      result.opportunities.some((o) => o.deploymentId === Q.OK),
      `expected the valid candidate in opportunities; got: ${JSON.stringify(
        result.opportunities.map((o) => o.deploymentId),
      )}`,
    );
  });
});

describe('DiscoveryEngine scoring', () => {
  it('uses median entityCount as cost proxy when some candidates report null', async () => {
    const deps = [
      deployment({ id: Q.A, signal: GRT(50_000n) }),
      deployment({ id: Q.B, signal: GRT(50_000n) }),
      deployment({ id: Q.C, signal: GRT(50_000n) }),
    ];
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: deps,
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        entityCountById: {
          [Q.A]: '100',
          [Q.B]: '200',
          // Q.C omitted → null → fallback to median(=200 — median of 2 sorted
          // values is the upper-middle since floor((n)/2) on sorted [100,200]
          // returns index 1 = 200. We just assert behavior is exactly that.
          [Q.C]: null,
        },
      }),
      postgresClient: null,
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    assert.ok(
      result.warnings.some((w) => /candidate.*no local entity count/.test(w)),
      'expected median-fallback warning',
    );
    // All three should be scored (none dropped for missing entityCount).
    const ids = result.opportunities.map((o) => o.deploymentId).sort();
    assert.deepEqual(ids, [Q.A, Q.B, Q.C]);

    // Assert the median fallback produces the *expected* value, not just a
    // warning. With known entityCounts [100, 200], the engine takes the
    // upper-middle (floor(2/2)=1 → 200) as the median proxy for Qm_c. So:
    //   costValues = [100, 200, 200], costMax = 200,
    //   costScore(Qm_a) = 0.5, costScore(Qm_b) = costScore(Qm_c) = 1.0
    // If the fallback regressed to 0 → Qm_c.costScore would be 0 (≠ 1.0).
    // If the fallback regressed to `signalledTokens` (~5e22) → costMax would
    // be dominated by it and Qm_a/Qm_b.costScore would collapse to ~0.
    const byId = new Map(result.opportunities.map((o) => [o.deploymentId, o]));
    const a = byId.get(Q.A)!;
    const b = byId.get(Q.B)!;
    const c = byId.get(Q.C)!;
    assert.equal(
      c.components.costScore,
      b.components.costScore,
      'Qm_c (null entityCount) must inherit the median cost, matching Qm_b',
    );
    assert.equal(c.components.costScore, 1.0, 'median proxy → costScore = 1.0');
    assert.equal(b.components.costScore, 1.0);
    assert.equal(a.components.costScore, 0.5, 'Qm_a (100) / costMax (200) = 0.5');
    // Sanity: regression-to-zero check. If the fallback fell back to 0,
    // Qm_a.costScore would still be 1.0 (100/100) but Qm_c.costScore would
    // be 0, so a.costScore > c.costScore — the assertion below would fail.
    assert.ok(c.components.costScore >= a.components.costScore);
  });

  it('does not re-pick an already-syncing deployment when the network subgraph returns bytes32 and graph-node returns Qm (regression: syncingIds key mismatch)', async () => {
    // Live reproducer for the syncingIds key mismatch in DiscoveryEngine.
    //
    // Before the fix, `syncingIds` was built from `indexingStatuses.subgraph`
    // (Qm form, native to graph-node) and then compared against the
    // network-subgraph deployment id `dep.id` (bytes32 form). Across
    // encodings the comparison always missed, so a deployment that the
    // indexer was already syncing got re-classified as an opportunity and
    // an indexing-rule recommendation was emitted to "start syncing
    // offchain" — exactly the action the indexer had already taken.
    //
    // The bytes32/Qm pair below is a real one computed via the project's
    // `toQmDeploymentId` helper.
    const bytes32Id =
      '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
    const qmId = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

    const dep = deployment({ id: bytes32Id, signal: GRT(50_000n) });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        // signalled deployment carries the bytes32 id from the network
        // subgraph.
        signalledDeployments: [dep],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        // graph-node returns the indexing status with the Qm id, matching
        // real behavior. Before the fix, syncingIds = {qmId} would not
        // contain bytes32Id and the deployment would be re-recommended.
        statuses: [indexingStatus({ id: qmId, synced: false })],
      }),
      postgresClient: null,
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());

    // Without the fix: dep appears as an opportunity AND in
    // ruleRecommendations because syncingIds.has(bytes32Id) returned false
    // despite the deployment being actively syncing.
    assert.equal(
      result.opportunities.filter((o) => o.deploymentId === bytes32Id).length,
      0,
      `expected the already-syncing deployment to be filtered out; if it ` +
        `appears, the syncingIds bytes32 vs Qm mismatch is back`,
    );
    assert.equal(
      result.ruleRecommendations.filter((r) => r.deploymentId === bytes32Id).length,
      0,
      `expected no offchain rule recommendation for an already-syncing deployment`,
    );
  });

  it('always emits deployment IDs in Qm form on every output field (regression: MCP surface consistency)', async () => {
    // The network subgraph returns deployment IDs in bytes32 form;
    // graph-node + graphman + indexer-agent all use Qm IPFS form
    // natively. DiscoveryEngine must emit Qm on every user-facing
    // output — stale[], cleanup[], opportunities[], ruleRecommendations[]
    // — so MCP clients consistently see one encoding regardless of the
    // upstream source.
    //
    // This test exercises BOTH halves:
    //   - cleanup half: a stale allocated deployment (graph-node returns
    //     Qm on `status.subgraph` — already Qm canonical).
    //   - discovery half: a signalled deployment without allocation
    //     (network subgraph returns bytes32 on `dep.id` — must be
    //     normalized at the emission point).
    const bytes32Cleanup =
      '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
    const qmCleanup = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';
    // A SECOND distinct bytes32 / Qm pair for the discovery side so the
    // cleanup ↔ discovery assertions don't accidentally key off the same id.
    const bytes32Discovery =
      '0x0000000000000000000000000000000000000000000000000000000000000001';
    // Computed via the project's `toQmDeploymentId` helper.
    const { toQmDeploymentId } = await import('../../src/utils/ipfs.js');
    const qmDiscovery = toQmDeploymentId(bytes32Discovery);

    const cleanupAlloc = allocation({
      id: '0xstale',
      deploymentId: bytes32Cleanup,
      allocatedTokens: GRT(10_000n),
    });
    const discoveryDep = deployment({
      id: bytes32Discovery,
      signal: GRT(50_000n),
    });

    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        // discovery half candidate: signalled but not allocated.
        signalledDeployments: [discoveryDep],
        // cleanup half: an active allocation on a different (un-signalled)
        // deployment so it's classified `no_signal` stale.
        activeAllocations: [cleanupAlloc],
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        // graph-node returns Qm natively for cleanup's local status; the
        // discovery candidate isn't synced locally so no status row.
        statuses: [indexingStatus({ id: qmCleanup, synced: true })],
      }),
      postgresClient: fakePostgresClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());

    // Every stale entry's deploymentId must be Qm.
    for (const s of result.stale) {
      assert.ok(
        s.deploymentId.startsWith('Qm'),
        `expected Qm-form deployment ID on stale entry, got ${s.deploymentId}`,
      );
    }
    // Every cleanup action's deploymentId must be Qm.
    for (const c of result.cleanup) {
      assert.ok(
        c.deploymentId.startsWith('Qm'),
        `expected Qm-form deployment ID on cleanup action, got ${c.deploymentId}`,
      );
    }
    // Every opportunity's deploymentId must be Qm.
    for (const o of result.opportunities) {
      assert.ok(
        o.deploymentId.startsWith('Qm'),
        `expected Qm-form deployment ID on opportunity, got ${o.deploymentId}`,
      );
    }
    // Every ruleRecommendation's deploymentId must be Qm.
    for (const r of result.ruleRecommendations) {
      assert.ok(
        r.deploymentId.startsWith('Qm'),
        `expected Qm-form deployment ID on ruleRecommendation, got ${r.deploymentId}`,
      );
    }

    // Sanity: the canonical Qm conversions match what we computed
    // upfront — proves the normalization isn't just any Qm-shaped string.
    assert.ok(
      result.stale.some((s) => s.deploymentId === qmCleanup),
      `expected canonical Qm id ${qmCleanup} in stale; got: ${JSON.stringify(
        result.stale.map((s) => s.deploymentId),
      )}`,
    );
    assert.ok(
      result.opportunities.some((o) => o.deploymentId === qmDiscovery),
      `expected canonical Qm id ${qmDiscovery} in opportunities; got: ${JSON.stringify(
        result.opportunities.map((o) => o.deploymentId),
      )}`,
    );
  });

  it('with identical signal/volume/cost, candidate with higher APR wins the top slot', async () => {
    // Two candidates with identical signal/volume/entityCount. APR depends on
    // the existing total stake (lower existing stake → higher per-unit APR).
    const depHigh = deployment({
      id: Q.HI_APR,
      signal: GRT(50_000n),
      staked: GRT(1n), // tiny existing alloc → big share for our typical alloc
    });
    const depLow = deployment({
      id: Q.LO_APR,
      signal: GRT(50_000n),
      staked: GRT(1_000_000n), // huge existing alloc → tiny share
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [depHigh, depLow],
        networkParams: networkParams(),
        deploymentAllocations: {
          [Q.HI_APR]: [
            allocation({
              id: 'a1',
              deploymentId: Q.HI_APR,
              allocatedTokens: GRT(1n),
              indexerId: '0xother',
            }),
          ],
          [Q.LO_APR]: [
            allocation({
              id: 'a2',
              deploymentId: Q.LO_APR,
              allocatedTokens: GRT(1_000_000n),
              indexerId: '0xother',
            }),
          ],
        },
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        entityCountById: { [Q.HI_APR]: '100', [Q.LO_APR]: '100' },
      }),
      postgresClient: null,
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    assert.equal(result.opportunities[0]!.deploymentId, Q.HI_APR);
  });
});
