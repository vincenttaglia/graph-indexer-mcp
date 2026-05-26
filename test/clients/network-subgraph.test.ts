/**
 * Tests for `createNetworkSubgraphClient` deployment-id normalization.
 *
 * The network subgraph stores `SubgraphDeployment.id` (and the
 * `Allocation.deployment` filter field) as bytes32. Passing a Qm hash
 * straight through silently returns `null` / 0 results — there is no
 * upstream error to surface. The client therefore normalizes any
 * deployment-id input to bytes32 at the boundary so callers can pass
 * either encoding.
 *
 * One test per fixed method: `getDeployment` and
 * `getDeploymentAllocations`.
 *
 * Uses the canonical bytes32/Qm anchor pair from `ipfs.test.ts`:
 *   bytes32: 0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c
 *   Qm:      QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNetworkSubgraphClient } from '../../src/clients/network-subgraph.js';

const KNOWN_BYTES32 =
  '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
const KNOWN_QM = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

interface FetchCall {
  url: string;
  body: {
    query?: string;
    variables?: Record<string, unknown>;
  };
}

function installFetchSpy(responder: (call: FetchCall) => unknown): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call: FetchCall = { url, body };
    calls.push(call);
    const payload = { data: responder(call) };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('NetworkSubgraphClient.getDeployment deployment-id normalization', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('converts a Qm deployment id to bytes32 before querying the network subgraph', async () => {
    // Pre-fix: passing a Qm hash here would be sent verbatim as the
    // `id` variable, and the network subgraph (which keys on bytes32)
    // would return `subgraphDeployment: null` silently. With the fix
    // the client normalizes to bytes32 first, so a real subgraph
    // returns the entity and a `null` is unambiguously "no such
    // deployment", not "wrong encoding".
    spy = installFetchSpy(() => ({
      subgraphDeployment: {
        id: KNOWN_BYTES32,
        signalledTokens: '0',
        stakedTokens: '0',
        indexingRewardAmount: '0',
        queryFeesAmount: '0',
        deniedAt: 0,
      },
    }));
    const client = createNetworkSubgraphClient({
      endpoint: 'http://localhost:8000/network',
    });

    const result = await client.getDeployment(KNOWN_QM);

    assert.ok(result, 'expected the deployment to be returned, not null');
    assert.equal(spy.calls.length, 1, 'one upstream request');
    assert.equal(
      spy.calls[0]!.body.variables?.id,
      KNOWN_BYTES32,
      `request variables.id must be the bytes32 form, got: ${JSON.stringify(spy.calls[0]!.body.variables)}`,
    );

    // Cache sharing: a follow-up call for the SAME logical deployment in
    // the other encoding must hit the same cache slot and trigger no new
    // upstream request. Pre-fix the cache was keyed on the raw user input
    // (lowercased), so Qm and bytes32 lookups fragmented across two slots.
    const second = await client.getDeployment(KNOWN_BYTES32);
    assert.ok(second, 'expected the same deployment to be returned from cache');
    assert.equal(
      spy.calls.length,
      1,
      'bytes32 follow-up must be served from cache (shared key with Qm)',
    );
  });
});

describe('NetworkSubgraphClient.getDeploymentAllocations deployment-id normalization', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('converts a Qm deployment id to bytes32 in the allocation filter before querying', async () => {
    // Pre-fix: the Qm went straight into the GraphQL `where.deployment`
    // filter, and the network subgraph returned 0 allocations silently —
    // indistinguishable from a deployment with no active allocations.
    // With the fix, the filter is keyed by bytes32 so allocations are
    // actually matched.
    spy = installFetchSpy(() => ({
      allocations: [
        {
          id: '0xalloc1',
          subgraphDeployment: { id: KNOWN_BYTES32 },
          indexer: { id: '0x1111111111111111111111111111111111111111' },
          allocatedTokens: '0',
          createdAtEpoch: 1,
          closedAtEpoch: null,
          status: 'Active',
          poi: null,
        },
      ],
    }));
    const client = createNetworkSubgraphClient({
      endpoint: 'http://localhost:8000/network',
    });

    const result = await client.getDeploymentAllocations(KNOWN_QM);

    assert.equal(result.items.length, 1, 'expected one allocation returned');
    assert.equal(spy.calls.length, 1, 'one upstream request');
    // The allocation filter keys the deployment column as
    // `subgraphDeployment`, not `deployment` — see `buildAllocationFilter`.
    const where = spy.calls[0]!.body.variables?.where as
      | { subgraphDeployment?: string }
      | undefined;
    assert.equal(
      where?.subgraphDeployment,
      KNOWN_BYTES32,
      `request variables.where.subgraphDeployment must be the bytes32 form, got: ${JSON.stringify(where)}`,
    );

    // Cache sharing: same logical deployment in the other encoding must
    // hit the same cache slot. Without the fix the cache key was the raw
    // user input lowercased, so Qm and bytes32 fragmented and the
    // bytes32 call triggered a second upstream request.
    const second = await client.getDeploymentAllocations(KNOWN_BYTES32);
    assert.equal(second.items.length, 1, 'expected cached allocation');
    assert.equal(
      spy.calls.length,
      1,
      'bytes32 follow-up must be served from cache (shared key with Qm)',
    );
  });
});
