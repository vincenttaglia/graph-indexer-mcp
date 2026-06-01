/**
 * Tests for `get_indexing_statuses` (src/tools/graphnode-tools.ts).
 *
 * Focus: the "no filter → all deployments" contract must hold for EVERY shape
 * an MCP host might emit for `deployment_ids`. Some hosts (e.g. those that
 * flatten Zod `.optional()` into a required+nullable parameter) cannot omit the
 * field, and instead send `null`, `[null]`, or `[]` to mean "no filter". A real
 * incident had a host send `[null]`, which previously failed input validation.
 *
 * Each test drives the tool the same way the host does: it runs `rawArgs`
 * through the tool's actual `inputSchema` (via `invokeTool`, mirroring
 * test/tools/manifest-tools.test.ts) and then asserts what `deploymentIds`
 * value the handler forwarded to the injected fake client.
 *
 * Coverage:
 *   - null / [null] / [] / mixed-with-null  → client called with `undefined` (all).
 *   - omitted field                          → client called with `undefined` (all).
 *   - a real Qm… hash                        → client called with [that hash] (filter).
 *   - response is wrapped as { count, statuses }.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z, type ZodRawShape } from 'zod';

import { registerGraphNodeTools } from '../../src/tools/graphnode-tools.js';
import {
  initAccessControl,
  resetForTests as resetAccessControl,
} from '../../src/access-control.js';
import type { GraphNodeClient } from '../../src/clients/graph-node.js';
import type { SubgraphIndexingStatus } from '../../src/types/graphnode.js';

const QM_ID = 'QmeDLbKJFRdFAp8Teg2kPa1vxs2nqTMdDQbzEd1c12duN6';

// ---------------------------------------------------------------------------
// Fake McpServer that records registerTool() calls (same pattern as the other
// tool tests). `invokeTool` runs rawArgs through the real inputSchema, so these
// tests exercise the exact validation a host's payload would hit.
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  inputSchema?: ZodRawShape;
  cb: (...args: unknown[]) => unknown;
}

interface FakeServer {
  tools: Map<string, CapturedTool>;
  registerTool: (
    name: string,
    config: { description?: string; inputSchema?: ZodRawShape },
    cb: (...args: unknown[]) => unknown,
  ) => void;
}

function makeFakeServer(): FakeServer {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    registerTool(name, config, cb) {
      tools.set(name, { name, inputSchema: config.inputSchema, cb });
    },
  };
}

async function invokeTool(
  server: FakeServer,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  const tool = server.tools.get(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  const parsed = tool.inputSchema
    ? z.object(tool.inputSchema).parse(rawArgs)
    : {};
  return await tool.cb(parsed, { signal: new AbortController().signal });
}

// ---------------------------------------------------------------------------
// Fake GraphNodeClient that records the deploymentIds it was called with.
// ---------------------------------------------------------------------------

interface FakeGraphNodeClient extends GraphNodeClient {
  calls: Array<string[] | undefined>;
}

function makeFakeClient(
  statuses: SubgraphIndexingStatus[],
): FakeGraphNodeClient {
  const calls: Array<string[] | undefined> = [];
  return {
    calls,
    async getIndexingStatuses(deploymentIds) {
      calls.push(deploymentIds);
      return statuses;
    },
    async getDeploymentHealth() {
      return null;
    },
    async getEntityCount() {
      return null;
    },
  } as FakeGraphNodeClient;
}

function setup(statuses: SubgraphIndexingStatus[] = []): {
  server: FakeServer;
  client: FakeGraphNodeClient;
} {
  resetAccessControl();
  initAccessControl({ level: 'read_only', allow: new Set(), deny: new Set() });
  const server = makeFakeServer();
  const client = makeFakeClient(statuses);
  registerGraphNodeTools(
    server as unknown as Parameters<typeof registerGraphNodeTools>[0],
    { client },
  );
  return { server, client };
}

function parseResult(result: unknown): {
  isError?: boolean;
  payload: Record<string, unknown>;
} {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r.content?.[0]?.text ?? '{}';
  return { isError: r.isError, payload: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get_indexing_statuses: no-filter shapes resolve to "all"', () => {
  beforeEach(() => resetAccessControl());
  afterEach(() => resetAccessControl());

  // Every shape a host might send to mean "no filter". Each must (a) pass
  // input validation and (b) cause the client to be called with `undefined`
  // (the "all deployments" path).
  const noFilterCases: Array<{ label: string; args: Record<string, unknown> }> =
    [
      { label: 'field omitted', args: {} },
      { label: 'explicit null', args: { deployment_ids: null } },
      { label: 'empty array', args: { deployment_ids: [] } },
      { label: 'array of a single null ([null])', args: { deployment_ids: [null] } },
      {
        label: 'array of multiple nulls',
        args: { deployment_ids: [null, null] },
      },
    ];

  for (const { label, args } of noFilterCases) {
    it(`${label} → client called with undefined (all deployments)`, async () => {
      const { server, client } = setup();
      const result = await invokeTool(server, 'get_indexing_statuses', args);
      const { isError } = parseResult(result);
      assert.equal(isError, undefined, 'must not be a tool error');
      assert.equal(client.calls.length, 1);
      assert.equal(
        client.calls[0],
        undefined,
        'handler must forward undefined so the client takes its "all" path',
      );
    });
  }

  it('a mixed array keeps the real hashes and drops nulls', async () => {
    const { server, client } = setup();
    await invokeTool(server, 'get_indexing_statuses', {
      deployment_ids: [null, QM_ID, null],
    });
    assert.deepEqual(client.calls[0], [QM_ID]);
  });

  it('a real Qm… hash is forwarded as a filter', async () => {
    const { server, client } = setup();
    await invokeTool(server, 'get_indexing_statuses', {
      deployment_ids: [QM_ID],
    });
    assert.deepEqual(client.calls[0], [QM_ID]);
  });

  it('wraps the client response as { count, statuses }', async () => {
    const fakeStatuses = [
      { id: QM_ID } as unknown as SubgraphIndexingStatus,
      { id: 'Qmother' } as unknown as SubgraphIndexingStatus,
    ];
    const { server } = setup(fakeStatuses);
    const result = await invokeTool(server, 'get_indexing_statuses', {});
    const { payload } = parseResult(result);
    assert.equal(payload.count, 2);
    assert.equal((payload.statuses as unknown[]).length, 2);
  });
});

describe('get_indexing_statuses: health_filter', () => {
  beforeEach(() => resetAccessControl());
  afterEach(() => resetAccessControl());

  // A mixed-health fleet to filter against.
  const mixedFleet = (): SubgraphIndexingStatus[] => [
    { subgraph: 'QmHealthy', health: 'healthy' } as SubgraphIndexingStatus,
    { subgraph: 'QmUnhealthy', health: 'unhealthy' } as SubgraphIndexingStatus,
    { subgraph: 'QmFailed1', health: 'failed' } as SubgraphIndexingStatus,
    { subgraph: 'QmFailed2', health: 'failed' } as SubgraphIndexingStatus,
  ];

  it('["failed"] returns only failed deployments and echoes the filter', async () => {
    const { server } = setup(mixedFleet());
    const result = await invokeTool(server, 'get_indexing_statuses', {
      health_filter: ['failed'],
    });
    const { isError, payload } = parseResult(result);
    assert.equal(isError, undefined);
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.health_filter, ['failed']);
    const subgraphs = (payload.statuses as Array<{ subgraph: string }>).map(
      (s) => s.subgraph,
    );
    assert.deepEqual(subgraphs.sort(), ['QmFailed1', 'QmFailed2']);
  });

  it('combines multiple states (["failed","unhealthy"])', async () => {
    const { server } = setup(mixedFleet());
    const result = await invokeTool(server, 'get_indexing_statuses', {
      health_filter: ['failed', 'unhealthy'],
    });
    const { payload } = parseResult(result);
    assert.equal(payload.count, 3);
  });

  it('composes with deployment_ids (filter still applied to the fetched set)', async () => {
    // The fake ignores the id filter and returns the full fleet; the health
    // filter must still narrow that result. This checks the handler applies
    // health filtering on whatever the client returns.
    const { server, client } = setup(mixedFleet());
    const result = await invokeTool(server, 'get_indexing_statuses', {
      deployment_ids: [QM_ID],
      health_filter: ['failed'],
    });
    assert.deepEqual(client.calls[0], [QM_ID]);
    const { payload } = parseResult(result);
    assert.equal(payload.count, 2);
  });

  // Empty / null / all-null health_filter shapes → no filtering (all states),
  // mirroring the deployment_ids host-compat handling. No `health_filter` key
  // should appear in the response when no filter is active.
  const noHealthFilterCases: Array<{
    label: string;
    args: Record<string, unknown>;
  }> = [
    { label: 'omitted', args: {} },
    { label: 'null', args: { health_filter: null } },
    { label: 'empty array', args: { health_filter: [] } },
    { label: '[null]', args: { health_filter: [null] } },
  ];

  for (const { label, args } of noHealthFilterCases) {
    it(`${label} → returns every health state, no health_filter echo`, async () => {
      const { server } = setup(mixedFleet());
      const result = await invokeTool(server, 'get_indexing_statuses', args);
      const { isError, payload } = parseResult(result);
      assert.equal(isError, undefined, 'must not be a tool error');
      assert.equal(payload.count, 4);
      assert.equal(
        Object.prototype.hasOwnProperty.call(payload, 'health_filter'),
        false,
        'no filter active → no health_filter key',
      );
    });
  }

  it('rejects an invalid health value', async () => {
    const { server } = setup(mixedFleet());
    // 'degraded' is not a valid graph-node health state — the Zod enum must
    // reject it at validation time (mirrors how a host payload would fail).
    assert.throws(() =>
      z
        .object(server.tools.get('get_indexing_statuses')!.inputSchema!)
        .parse({ health_filter: ['degraded'] }),
    );
  });
});
