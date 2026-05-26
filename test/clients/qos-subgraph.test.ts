/**
 * Tests for `createQosSubgraphClient` deployment-id normalization.
 *
 * The QoS Oracle subgraph (on Gnosis) stores `SubgraphDeployment.id` as
 * the IPFS hash (Qm/CIDv0 form), NOT the bytes32 form used by the
 * Arbitrum network subgraph. Passing a bytes32 hash through the
 * scoped-query filter silently matches zero rows — indistinguishable
 * from a deployment with no QoS data. The client therefore normalizes
 * any deployment-id input to Qm at the boundary so callers can pass
 * either encoding.
 *
 * This is the symmetric counterpart to the
 * `network-subgraph.test.ts` normalization tests — same shape, opposite
 * direction.
 *
 * One test per fixed method: `getQueryVolume` (scoped) and
 * `getIndexerQoS` (scoped). The unscoped branches don't take a
 * deployment id and are unaffected.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createQosSubgraphClient } from '../../src/clients/qos-subgraph.js';

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

describe('QosSubgraphClient.getQueryVolume deployment-id normalization', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('converts a bytes32 deployment id to Qm before querying the QoS subgraph', async () => {
    // Pre-fix: a bytes32 hash here would be sent verbatim as the
    // `deploymentId` variable, and the QoS Oracle (which keys on Qm)
    // would return zero rows. With the fix the client normalizes to Qm
    // first so the filter actually matches.
    spy = installFetchSpy(() => ({
      queryDailyDataPoints: [],
    }));
    const client = createQosSubgraphClient({
      endpoint: 'http://localhost:8000/qos',
    });

    await client.getQueryVolume({
      deploymentId: KNOWN_BYTES32,
      timeRange: { days: 30 },
    });

    assert.ok(spy.calls.length >= 1, 'at least one upstream request');
    assert.equal(
      spy.calls[0]!.body.variables?.deploymentId,
      KNOWN_QM,
      `request variables.deploymentId must be the Qm form, got: ${JSON.stringify(spy.calls[0]!.body.variables)}`,
    );
  });
});

describe('QosSubgraphClient.getIndexerQoS deployment-id normalization', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('converts a bytes32 deployment id to Qm in the allocation-scoped query', async () => {
    // Pre-fix: bytes32 went straight into the AllocationQoS filter on
    // `subgraphDeployment`, returning zero allocation rows. Fix
    // normalizes to Qm so the scoped query actually matches.
    spy = installFetchSpy(() => ({
      allocationDailyDataPoints: [],
    }));
    const client = createQosSubgraphClient({
      endpoint: 'http://localhost:8000/qos',
    });

    await client.getIndexerQoS({
      indexerAddress: '0x1111111111111111111111111111111111111111',
      deploymentId: KNOWN_BYTES32,
      timeRange: { days: 30 },
    });

    assert.ok(spy.calls.length >= 1, 'at least one upstream request');
    assert.equal(
      spy.calls[0]!.body.variables?.deploymentId,
      KNOWN_QM,
      `request variables.deploymentId must be the Qm form, got: ${JSON.stringify(spy.calls[0]!.body.variables)}`,
    );
  });
});
