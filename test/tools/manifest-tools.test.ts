/**
 * Tests for `get_subgraph_manifest` (src/tools/manifest-tools.ts).
 *
 * The tool is registered against a fake McpServer that captures each
 * `registerTool(name, {inputSchema}, cb)` call (same pattern as
 * `test/tools/agent-tools.test.ts`). An INJECTED fake `IpfsClient` records the
 * CID passed to `cat()` and returns canned manifest text, so the tests assert
 * on exactly what the handler resolves the deployment ID to and how it parses
 * the response — no network involved.
 *
 * Coverage:
 *   - a Qm… deployment_id is passed to `client.cat` unchanged.
 *   - a 0x…bytes32 deployment_id is normalized to the matching Qm… before cat.
 *   - valid YAML → `manifest` populated + `manifest_raw` present.
 *   - invalid YAML → `manifest: null` + `parse_error` + `manifest_raw` present.
 *   - an invalid deployment_id → isError result, and `cat` is never called.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z, type ZodRawShape } from 'zod';

import { registerManifestTools } from '../../src/tools/manifest-tools.js';
import {
  initAccessControl,
  resetForTests as resetAccessControl,
} from '../../src/access-control.js';
import type { IpfsClient } from '../../src/clients/ipfs.js';

// Matching encodings of the SAME deployment hash (computed via src/utils/ipfs).
const QM_ID = 'QmeDLbKJFRdFAp8Teg2kPa1vxs2nqTMdDQbzEd1c12duN6';
const BYTES32_ID =
  '0xebdb70ab726302501b3b5a85af2d108a5f5e7f78f04e4e3640e1bb01da3c5f87';

// ---------------------------------------------------------------------------
// Fake McpServer that records registerTool() calls.
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
// Fake IpfsClient that records the CID it was asked to cat().
// ---------------------------------------------------------------------------

interface FakeIpfsClient extends IpfsClient {
  catCalls: string[];
}

function makeFakeIpfsClient(body: string): FakeIpfsClient {
  const catCalls: string[] = [];
  return {
    catCalls,
    async cat(cid) {
      catCalls.push(cid);
      return body;
    },
  };
}

function setup(body: string): { server: FakeServer; client: FakeIpfsClient } {
  resetAccessControl();
  // `read_only` grants the `read` permission class that get_subgraph_manifest
  // requires.
  initAccessControl({ level: 'read_only', allow: new Set(), deny: new Set() });
  const server = makeFakeServer();
  const client = makeFakeIpfsClient(body);
  registerManifestTools(
    server as unknown as Parameters<typeof registerManifestTools>[0],
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

const VALID_YAML =
  'specVersion: 0.0.4\n' +
  'dataSources:\n' +
  '  - name: Example\n' +
  '    network: arbitrum-one\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get_subgraph_manifest', () => {
  beforeEach(() => resetAccessControl());
  afterEach(() => resetAccessControl());

  it('passes a Qm… deployment_id to client.cat unchanged', async () => {
    const { server, client } = setup(VALID_YAML);
    const result = await invokeTool(server, 'get_subgraph_manifest', {
      deployment_id: QM_ID,
    });
    assert.deepEqual(client.catCalls, [QM_ID]);
    const { isError, payload } = parseResult(result);
    assert.equal(isError, undefined);
    assert.equal(payload.deployment_id, QM_ID);
  });

  it('normalizes a 0x…bytes32 deployment_id to the matching Qm… before cat', async () => {
    const { server, client } = setup(VALID_YAML);
    const result = await invokeTool(server, 'get_subgraph_manifest', {
      deployment_id: BYTES32_ID,
    });
    // The handler must convert bytes32 → Qm before fetching from IPFS (the
    // gateway only recognizes the CIDv0 form).
    assert.deepEqual(client.catCalls, [QM_ID]);
    const { payload } = parseResult(result);
    assert.equal(payload.deployment_id, QM_ID);
  });

  it('parses valid YAML into `manifest` and keeps `manifest_raw`', async () => {
    const { server } = setup(VALID_YAML);
    const result = await invokeTool(server, 'get_subgraph_manifest', {
      deployment_id: QM_ID,
    });
    const { isError, payload } = parseResult(result);
    assert.equal(isError, undefined);
    assert.deepEqual(payload.manifest, {
      specVersion: '0.0.4',
      dataSources: [{ name: 'Example', network: 'arbitrum-one' }],
    });
    assert.equal(payload.manifest_raw, VALID_YAML);
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, 'parse_error'),
      false,
    );
  });

  it('on invalid YAML returns manifest:null + parse_error + raw bytes', async () => {
    // Unbalanced/invalid YAML that `yaml.parse` rejects.
    const BAD_YAML = 'foo: [unclosed\n  bar: : :\n';
    const { server } = setup(BAD_YAML);
    const result = await invokeTool(server, 'get_subgraph_manifest', {
      deployment_id: QM_ID,
    });
    const { isError, payload } = parseResult(result);
    // Parse failure is NOT a tool error — the raw bytes are still returned.
    assert.equal(isError, undefined);
    assert.equal(payload.manifest, null);
    assert.equal(payload.manifest_raw, BAD_YAML);
    assert.equal(typeof payload.parse_error, 'string');
    assert.ok((payload.parse_error as string).length > 0);
  });

  it('rejects an invalid deployment_id with an error result and never calls cat', async () => {
    const { server, client } = setup(VALID_YAML);
    const result = await invokeTool(server, 'get_subgraph_manifest', {
      deployment_id: 'not-a-valid-id',
    });
    const { isError, payload } = parseResult(result);
    assert.equal(isError, true);
    assert.match(String(payload.error ?? ''), /Invalid deployment ID/);
    // The bad ID must be rejected BEFORE any IPFS fetch is attempted.
    assert.deepEqual(client.catCalls, []);
  });
});
