/**
 * Wire-level tests for `createIndexerAgentClient.queueActions`.
 *
 * Goal: prove the absent-`poi`-vs-zero-`poi` semantic survives the
 * GraphQL request boundary. The MCP tool layer
 * (`src/tools/agent-tools.ts`) constructs `ActionInput` objects that
 * either OMIT `poi` entirely (default, agent computes POI and claims
 * rewards) or set it to the all-zero sentinel (forfeit rewards).
 *
 * `graphql-request` serializes the variables block via `JSON.stringify`,
 * which drops `undefined` properties from objects. We assert the HTTP
 * body reflects this — `poi` is absent (no key) in the default branch
 * and present-and-zero in the forfeit branch. Codex audit follow-up:
 * the tool-level tests cover the JS object shape; this file covers the
 * actual wire payload so the absent-vs-zero contract is end-to-end
 * verified.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createIndexerAgentClient } from '../../src/clients/indexer-agent.js';

interface FetchCall {
  url: string;
  body: {
    query?: string;
    variables?: { actions?: Array<Record<string, unknown>> };
  };
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
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify({ data: { queueActions: [] } }), {
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

describe('IndexerAgentClient.queueActions POI wire shape', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('default branch — omits the `poi` property from the serialized ActionInput', async () => {
    // The MCP tool's default path builds an ActionInput WITHOUT a `poi`
    // key (conditional spread). This test confirms the HTTP body has no
    // `poi` key at all — not `poi: null` or `poi: ""`. Either of those
    // would risk the indexer-agent interpreting the action as
    // forfeit-rewards.
    spy = installFetchSpy();
    const client = createIndexerAgentClient({
      endpoint: 'http://localhost:18000/graphql',
    });
    await client.queueActions([
      {
        type: 'unallocate',
        deploymentID: 'QmExample1',
        allocationID: '0x' + 'aa'.repeat(20),
        source: 'mcp',
        reason: 'queued via MCP queue_unallocate',
        priority: 1,
        status: 'queued',
        protocolNetwork: 'arbitrum-one',
        isLegacy: false,
      },
    ]);
    assert.equal(spy.calls.length, 1, 'one upstream request');
    const action = spy.calls[0]!.body.variables?.actions?.[0];
    assert.ok(action, 'action present in variables');
    assert.equal(
      Object.prototype.hasOwnProperty.call(action, 'poi'),
      false,
      `default-branch ActionInput must NOT have a 'poi' key in the wire body; ` +
        `got: ${JSON.stringify(action)}`,
    );
  });

  it('forfeit branch — passes the all-zero POI sentinel through verbatim', async () => {
    // The MCP tool's force_zero_poi=true path sets poi to '0x' + 64
    // zeros. This must reach the agent unchanged so the agent knows to
    // forfeit rewards.
    const ZERO_POI = '0x' + '0'.repeat(64);
    spy = installFetchSpy();
    const client = createIndexerAgentClient({
      endpoint: 'http://localhost:18000/graphql',
    });
    await client.queueActions([
      {
        type: 'unallocate',
        deploymentID: 'QmExample1',
        allocationID: '0x' + 'bb'.repeat(20),
        poi: ZERO_POI,
        source: 'mcp',
        reason: 'queued via MCP queue_unallocate (force_zero_poi=true; rewards forfeited)',
        priority: 1,
        status: 'queued',
        protocolNetwork: 'arbitrum-one',
        isLegacy: false,
      },
    ]);
    assert.equal(spy.calls.length, 1, 'one upstream request');
    const action = spy.calls[0]!.body.variables?.actions?.[0];
    assert.ok(action, 'action present in variables');
    assert.equal(
      action?.poi,
      ZERO_POI,
      `forfeit-branch ActionInput must carry the zero-POI sentinel verbatim; ` +
        `got: ${JSON.stringify(action)}`,
    );
  });
});
