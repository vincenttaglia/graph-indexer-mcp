/**
 * Tests for the graphman tool registrars (src/tools/graphman-tools.ts).
 *
 * A fake McpServer captures each tool's registered `inputSchema` + callback.
 * A recording fake `GraphmanClient` captures the args each handler forwards.
 * Assertions cover:
 *   - permission classes (esp. check_blocks = graphman_safe, NOT read);
 *   - drop `all` passthrough + surfaced deleted locators;
 *   - reassign warnings surfaced;
 *   - async ops (rewind, check_blocks byRange) return execution_id + poll hint;
 *   - checkBlocks Result vs Execution rendering;
 *   - in-handler refines reject bad combos (rewind start_block+hash,
 *     check_blocks two methods, clear_call_cache two modes);
 *   - the `confirm: z.literal(true)` gate on destructive ops (via the
 *     registered inputSchema, which the SDK enforces at the transport layer).
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z, type ZodRawShape } from 'zod';

import { registerGraphmanTools } from '../../src/tools/graphman-tools.js';
import type {
  CheckBlocksArgs,
  ClearCallCacheArgs,
  GraphmanClient,
  RewindArgs,
} from '../../src/clients/graphman.js';
import {
  getToolPermission,
  initAccessControl,
  resetForTests,
} from '../../src/access-control.js';

const KNOWN_QM = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

interface FakeServer {
  toolCbs: Map<string, (...a: unknown[]) => unknown>;
  schemas: Map<string, ZodRawShape | undefined>;
  registerTool: (name: string, config: { inputSchema?: ZodRawShape }, cb: (...a: unknown[]) => unknown) => void;
}

function makeFakeServer(): FakeServer {
  const toolCbs = new Map<string, (...a: unknown[]) => unknown>();
  const schemas = new Map<string, ZodRawShape | undefined>();
  return {
    toolCbs,
    schemas,
    registerTool(name, config, cb) {
      toolCbs.set(name, cb);
      schemas.set(name, config.inputSchema);
    },
  };
}

const fakeExtra = { signal: new AbortController().signal, authInfo: undefined };

type ToolResult = { content: { text: string }[]; isError?: boolean };

function text(res: ToolResult): string {
  const block = res.content[0];
  assert.ok(block, 'result has a content block');
  return block.text;
}

interface Recorded {
  rewind?: { id: string; args: RewindArgs };
  drop?: { id: string; all: boolean };
  reassign?: { id: string; node: string };
  unassign?: { id: string };
  checkBlocks?: CheckBlocksArgs;
  truncate?: { chain: string };
  clearCallCache?: ClearCallCacheArgs;
}

function makeFakeClient(overrides: Partial<GraphmanClient> = {}): {
  client: GraphmanClient;
  rec: Recorded;
} {
  const rec: Recorded = {};
  const client: GraphmanClient = {
    async getDeploymentInfo(id) {
      return { id, paused: false };
    },
    async pauseDeployment() {
      return { success: true };
    },
    async resumeDeployment() {
      return { success: true };
    },
    async restartDeployment() {
      return { executionId: 'r' };
    },
    async getExecutionStatus(id) {
      return { id, state: 'SUCCEEDED' };
    },
    async rewindDeployment(id, args) {
      rec.rewind = { id, args };
      return { executionId: 'rewind-1' };
    },
    async dropDeployment(id, all) {
      rec.drop = { id, all };
      return { deletedLocators: ['sgd9'] };
    },
    async reassignDeployment(id, node) {
      rec.reassign = { id, node };
      return { success: true };
    },
    async unassignDeployment(id) {
      rec.unassign = { id };
      return { success: true };
    },
    async checkBlocks(args) {
      rec.checkBlocks = args;
      return { kind: 'result', result: { diverged: 0, blocks: [] } };
    },
    async truncateChainCache(chain) {
      rec.truncate = { chain };
      return { success: true };
    },
    async clearCallCache(args) {
      rec.clearCallCache = args;
      return { kind: 'empty', success: true };
    },
    ...overrides,
  };
  return { client, rec };
}

function setup(overrides: Partial<GraphmanClient> = {}) {
  const server = makeFakeServer();
  const { client, rec } = makeFakeClient(overrides);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerGraphmanTools(server as any, { client });
  return { server, rec };
}

function cb(server: FakeServer, name: string) {
  const fn = server.toolCbs.get(name) as (a: unknown, e: unknown) => Promise<ToolResult>;
  assert.ok(fn, `${name} registered`);
  return fn;
}

describe('graphman tools — registration & permission classes', () => {
  beforeEach(() => {
    resetForTests();
    // Grant everything so handlers run; we assert the recorded class separately.
    initAccessControl({ level: 'read_write_destructive', allow: new Set(), deny: new Set() });
  });

  it('registers all 12 tools with the expected permission classes', () => {
    setup();
    assert.equal(getToolPermission('graphman_deployment_info'), 'read');
    assert.equal(getToolPermission('graphman_get_execution_status'), 'read');
    assert.equal(getToolPermission('graphman_pause_deployment'), 'graphman_safe');
    assert.equal(getToolPermission('graphman_resume_deployment'), 'graphman_safe');
    assert.equal(getToolPermission('graphman_restart_deployment'), 'graphman_safe');
    assert.equal(getToolPermission('graphman_reassign_deployment'), 'graphman_safe');
    // check_blocks deletes diverged cache entries → safe, NOT read.
    assert.equal(getToolPermission('graphman_check_blocks'), 'graphman_safe');
    assert.equal(getToolPermission('graphman_rewind_deployment'), 'graphman_destructive');
    assert.equal(getToolPermission('graphman_drop_deployment'), 'graphman_destructive');
    assert.equal(getToolPermission('graphman_unassign_deployment'), 'graphman_destructive');
    assert.equal(getToolPermission('graphman_truncate_chain_cache'), 'graphman_destructive');
    assert.equal(getToolPermission('graphman_clear_call_cache'), 'graphman_destructive');
  });

  it('does NOT register the dropped unused_* tools', () => {
    const { server } = setup();
    assert.equal(server.toolCbs.has('graphman_unused_record'), false);
    assert.equal(server.toolCbs.has('graphman_unused_remove'), false);
  });
});

describe('graphman tools — handlers', () => {
  beforeEach(() => {
    resetForTests();
    initAccessControl({ level: 'read_write_destructive', allow: new Set(), deny: new Set() });
  });

  it('rewind: forwards args and returns execution_id + hint', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_rewind_deployment')(
      {
        deployment_id: KNOWN_QM,
        block_hash: '0x' + 'a'.repeat(64),
        block_number: 100,
        force: true,
        confirm: true,
      },
      fakeExtra,
    );
    assert.equal(res.isError, undefined);
    assert.deepEqual(rec.rewind, {
      id: KNOWN_QM,
      args: { blockHash: '0x' + 'a'.repeat(64), blockNumber: 100, force: true },
    });
    const payload = JSON.parse(text(res));
    assert.equal(payload.execution_id, 'rewind-1');
    assert.match(payload.hint, /poll graphman_get_execution_status/);
  });

  it('rewind: rejects start_block + block_hash (refine)', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_rewind_deployment')(
      {
        deployment_id: KNOWN_QM,
        start_block: true,
        block_hash: '0x' + 'a'.repeat(64),
        block_number: 1,
        confirm: true,
      },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.equal(rec.rewind, undefined, 'client must not be called on a refine failure');
  });

  it('drop: passes `all` through and surfaces deleted locators', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_drop_deployment')(
      { deployment_id: KNOWN_QM, all: true, confirm: true },
      fakeExtra,
    );
    assert.deepEqual(rec.drop, { id: KNOWN_QM, all: true });
    assert.deepEqual(JSON.parse(text(res)), { deleted_locators: ['sgd9'] });
  });

  it('drop: defaults `all` to false', async () => {
    const { server, rec } = setup();
    await cb(server, 'graphman_drop_deployment')(
      { deployment_id: KNOWN_QM, confirm: true },
      fakeExtra,
    );
    assert.deepEqual(rec.drop, { id: KNOWN_QM, all: false });
  });

  it('reassign: surfaces warnings', async () => {
    const { server } = setup({
      async reassignDeployment(id, node) {
        return { success: true, warnings: ['w1'] };
      },
    });
    const res = await cb(server, 'graphman_reassign_deployment')(
      { deployment_id: KNOWN_QM, node: 'index-node-1' },
      fakeExtra,
    );
    assert.deepEqual(JSON.parse(text(res)), { success: true, warnings: ['w1'] });
  });

  it('check_blocks byRange: returns execution_id + hint (async)', async () => {
    const { server, rec } = setup({
      async checkBlocks(args) {
        rec.checkBlocks = args;
        return { kind: 'execution', executionId: 'cb-1' };
      },
    });
    const res = await cb(server, 'graphman_check_blocks')(
      { chain: 'arbitrum-one', by_range: { from: 1, to: 100 } },
      fakeExtra,
    );
    assert.deepEqual(rec.checkBlocks, {
      chain: 'arbitrum-one',
      byRange: { from: 1, to: 100 },
    });
    const payload = JSON.parse(text(res));
    assert.equal(payload.execution_id, 'cb-1');
    assert.match(payload.hint, /poll graphman_get_execution_status/);
  });

  it('check_blocks byNumber: returns the sync result', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_check_blocks')(
      { chain: 'c', by_number: { number: 5, delete_duplicates: true } },
      fakeExtra,
    );
    assert.deepEqual(rec.checkBlocks, {
      chain: 'c',
      byNumber: { number: 5, deleteDuplicates: true },
    });
    assert.deepEqual(JSON.parse(text(res)), { diverged: 0, blocks: [] });
  });

  it('check_blocks: rejects two methods (refine)', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_check_blocks')(
      { chain: 'c', by_hash: '0x' + 'a'.repeat(64), by_number: { number: 5 } },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.equal(rec.checkBlocks, undefined);
  });

  it('clear_call_cache: range mode forwards from/to', async () => {
    const { server, rec } = setup();
    await cb(server, 'graphman_clear_call_cache')(
      { chain: 'c', from: 1, to: 9, confirm: true },
      fakeExtra,
    );
    assert.deepEqual(rec.clearCallCache, { chain: 'c', from: 1, to: 9 });
  });

  it('clear_call_cache: rejects two modes (refine)', async () => {
    const { server, rec } = setup();
    const res = await cb(server, 'graphman_clear_call_cache')(
      { chain: 'c', from: 1, to: 9, remove_entire_cache: true, confirm: true },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.equal(rec.clearCallCache, undefined);
  });

  it('unassign + truncate forward correctly', async () => {
    const { server, rec } = setup();
    await cb(server, 'graphman_unassign_deployment')(
      { deployment_id: KNOWN_QM, confirm: true },
      fakeExtra,
    );
    await cb(server, 'graphman_truncate_chain_cache')({ chain: 'c', confirm: true }, fakeExtra);
    assert.deepEqual(rec.unassign, { id: KNOWN_QM });
    assert.deepEqual(rec.truncate, { chain: 'c' });
  });
});

describe('graphman tools — confirm gate (registered inputSchema)', () => {
  beforeEach(() => {
    resetForTests();
    initAccessControl({ level: 'read_write_destructive', allow: new Set(), deny: new Set() });
  });

  // The SDK validates input against the registered schema at the transport
  // layer before the handler runs. We assert the schema itself rejects a
  // missing/false `confirm` on every destructive op.
  for (const name of [
    'graphman_rewind_deployment',
    'graphman_drop_deployment',
    'graphman_unassign_deployment',
    'graphman_truncate_chain_cache',
    'graphman_clear_call_cache',
  ]) {
    it(`${name} requires confirm:true`, () => {
      const { server } = setup();
      const shape = server.schemas.get(name);
      assert.ok(shape, `${name} has an inputSchema`);
      const schema = z.object(shape);
      assert.equal(schema.safeParse({ confirm: false }).success, false);
      // Also reject confirm omitted entirely.
      assert.equal(schema.safeParse({}).success, false);
    });
  }

  it('check_blocks does NOT require confirm (safe op)', () => {
    const { server } = setup();
    const shape = server.schemas.get('graphman_check_blocks');
    assert.ok(shape);
    assert.equal('confirm' in shape, false, 'check_blocks must not have a confirm field');
  });
});
