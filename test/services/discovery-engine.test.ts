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

function baseConfig(over: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    indexerAddress: INDEXER,
    minSignal: GRT(1_000n),
    typicalAllocationGrt: GRT(50_000n),
    blocksPerYear: 2_628_000,
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
    const depId = 'Qm_stale';
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
      graphmanClient: fakeGraphmanClient({
        defaultInfo: { id: depId, paused: false, node: 'index-node-0' },
      }),
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
    const depId = 'Qm_drop_test';
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
      graphmanClient: fakeGraphmanClient({
        defaultInfo: { id: depId, paused: false, node: 'index-node-0' },
      }),
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

  it('frozen deployment appears in stale[] but produces NO cleanup action; warning emitted', async () => {
    const depId = 'Qm_frozen';
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
      graphmanClient: fakeGraphmanClient({
        defaultInfo: { id: depId, paused: false, node: 'index-node-0' },
      }),
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
    const ok = deployment({ id: 'Qm_ok', signal: GRT(50_000n) });
    const denied = deployment({
      id: 'Qm_denied',
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
    assert.ok(!ids.includes('Qm_denied'));
    assert.ok(ids.includes('Qm_ok'));
    assert.ok(result.warnings.some((w) => /rewards are denied/.test(w)));
  });

  it('blacklist wins over whitelist', async () => {
    const dep = deployment({ id: 'Qm_both', signal: GRT(50_000n) });
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
      baseConfig({ whitelist: ['Qm_both'], blacklist: ['Qm_both'] }),
    );
    assert.equal(
      result.opportunities.filter((o) => o.deploymentId === 'Qm_both').length,
      0,
    );
  });
});

describe('DiscoveryEngine scoring', () => {
  it('uses median entityCount as cost proxy when some candidates report null', async () => {
    const deps = [
      deployment({ id: 'Qm_a', signal: GRT(50_000n) }),
      deployment({ id: 'Qm_b', signal: GRT(50_000n) }),
      deployment({ id: 'Qm_c', signal: GRT(50_000n) }),
    ];
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: deps,
        networkParams: networkParams(),
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        entityCountById: {
          Qm_a: '100',
          Qm_b: '200',
          // Qm_c omitted → null → fallback to median(=200 — median of 2 sorted
          // values is the upper-middle since floor((n)/2) on sorted [100,200]
          // returns index 1 = 200. We just assert behavior is exactly that.
          Qm_c: null,
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
    assert.deepEqual(ids, ['Qm_a', 'Qm_b', 'Qm_c']);

    // Assert the median fallback produces the *expected* value, not just a
    // warning. With known entityCounts [100, 200], the engine takes the
    // upper-middle (floor(2/2)=1 → 200) as the median proxy for Qm_c. So:
    //   costValues = [100, 200, 200], costMax = 200,
    //   costScore(Qm_a) = 0.5, costScore(Qm_b) = costScore(Qm_c) = 1.0
    // If the fallback regressed to 0 → Qm_c.costScore would be 0 (≠ 1.0).
    // If the fallback regressed to `signalledTokens` (~5e22) → costMax would
    // be dominated by it and Qm_a/Qm_b.costScore would collapse to ~0.
    const byId = new Map(result.opportunities.map((o) => [o.deploymentId, o]));
    const a = byId.get('Qm_a')!;
    const b = byId.get('Qm_b')!;
    const c = byId.get('Qm_c')!;
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

  it('with identical signal/volume/cost, candidate with higher APR wins the top slot', async () => {
    // Two candidates with identical signal/volume/entityCount. APR depends on
    // the existing total stake (lower existing stake → higher per-unit APR).
    const depHigh = deployment({
      id: 'Qm_hi_apr',
      signal: GRT(50_000n),
      staked: GRT(1n), // tiny existing alloc → big share for our typical alloc
    });
    const depLow = deployment({
      id: 'Qm_lo_apr',
      signal: GRT(50_000n),
      staked: GRT(1_000_000n), // huge existing alloc → tiny share
    });
    const engine = new DiscoveryEngine({
      networkClient: fakeNetworkClient({
        signalledDeployments: [depHigh, depLow],
        networkParams: networkParams(),
        deploymentAllocations: {
          Qm_hi_apr: [
            allocation({
              id: 'a1',
              deploymentId: 'Qm_hi_apr',
              allocatedTokens: GRT(1n),
              indexerId: '0xother',
            }),
          ],
          Qm_lo_apr: [
            allocation({
              id: 'a2',
              deploymentId: 'Qm_lo_apr',
              allocatedTokens: GRT(1_000_000n),
              indexerId: '0xother',
            }),
          ],
        },
      }),
      qosClient: fakeQosClient(),
      graphNodeClient: fakeGraphNodeClient({
        entityCountById: { Qm_hi_apr: '100', Qm_lo_apr: '100' },
      }),
      postgresClient: null,
      graphmanClient: fakeGraphmanClient(),
      agentClient: fakeAgentClient(),
    });
    const result = await engine.run(baseConfig());
    assert.equal(result.opportunities[0]!.deploymentId, 'Qm_hi_apr');
  });
});
