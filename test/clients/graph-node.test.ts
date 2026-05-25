/**
 * Tests for `createGraphNodeClient` cache-key behavior. Focus: the
 * audit follow-up that ensures `getIndexingStatuses` dedupes deployment
 * IDs AFTER Qm-normalization so that, e.g., `[bytes32_a, Qm_a]` (same
 * logical deployment in two encodings) shares the cache slot with
 * `[Qm_a]` — was cache fragmentation, not correctness.
 *
 * Mocks `globalThis.fetch` for the duration of the test so we can count
 * the number of upstream graph-node requests. graphql-request invokes
 * the shim we install via the client factory's `timedFetch` wrapper,
 * which in turn calls `globalThis.fetch` — so a single fetch
 * replacement catches every request.
 *
 * Uses the canonical bytes32/Qm anchor pair verified by `ipfs.test.ts`:
 *   bytes32: 0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c
 *   Qm:      QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGraphNodeClient } from '../../src/clients/graph-node.js';

const KNOWN_BYTES32 =
  '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
const KNOWN_QM = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

interface FetchCall {
  url: string;
  body: unknown;
}

function installFetchSpy(): {
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
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, body });
    // graph-node returns a single indexingStatus row for the requested id.
    const payload = {
      data: {
        indexingStatuses: [
          {
            subgraph: KNOWN_QM,
            synced: true,
            health: 'healthy',
            fatalError: null,
            nonFatalErrors: [],
            chains: [],
            entityCount: '0',
          },
        ],
      },
    };
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

describe('GraphNodeClient.getIndexingStatuses cache-key dedupe', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    spy = installFetchSpy();
  });

  afterEach(() => {
    spy.restore();
  });

  it('dedupes after Qm-normalization so [bytes32, Qm] for the same deployment shares the cache slot with [Qm]', async () => {
    // Audit follow-up (Low): without the dedupe, the two input shapes
    // produced different cache keys ('Qma,Qma' vs 'Qma') for the same
    // underlying query — two upstream fetches instead of one. With the
    // dedupe, both calls share a single cache slot and the second is
    // served from cache (zero upstream fetches after the first).
    const client = createGraphNodeClient({
      endpoint: 'http://localhost:8030/graphql',
    });

    // First call: both encodings of the same logical deployment. After
    // normalization and dedupe, this is a single-id query.
    const a = await client.getIndexingStatuses([KNOWN_BYTES32, KNOWN_QM]);
    assert.equal(a.length, 1);
    assert.equal(spy.calls.length, 1, 'first call hits upstream exactly once');

    // The variables sent to graph-node should contain a single id, not
    // a duplicated pair — the dedupe must happen before the request, not
    // just before the cache key.
    const firstBody = spy.calls[0]!.body as {
      variables?: { subgraphs?: string[] };
    };
    assert.deepEqual(
      firstBody.variables?.subgraphs,
      [KNOWN_QM],
      'request variables must reflect the deduped id list',
    );

    // Second call: pure-Qm input for the same deployment. Same cache key
    // → served from cache → zero new upstream fetches.
    const b = await client.getIndexingStatuses([KNOWN_QM]);
    assert.equal(b.length, 1);
    assert.equal(
      spy.calls.length,
      1,
      'second call must be served from cache (same key after dedupe+normalize)',
    );
  });
});
