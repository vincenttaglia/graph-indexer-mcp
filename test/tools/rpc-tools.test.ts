/**
 * Tests for the `rpc_call` tool registrar (src/tools/rpc-tools.ts).
 *
 * The tool OWNS the read-only method allowlist (the security boundary) and the
 * unknown-chain refusal; both are enforced BEFORE the client is touched. We
 * inject a fake `RpcClient` that records every call, and a fake McpServer that
 * captures the SDK callback (mirroring test/server/register.test.ts), then
 * invoke the captured handler directly with `read` granted.
 *
 * Assertions:
 *   - an allowlisted method + configured chain reaches the client;
 *   - a non-allowlisted / state-changing method is refused WITHOUT a client call;
 *   - an unknown chain is refused WITHOUT a client call;
 *   - a JSON-RPC error envelope is surfaced faithfully;
 *   - the endpoint URL never appears in any output.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerRpcTools } from '../../src/tools/rpc-tools.js';
import type { RpcClient, RpcSource } from '../../src/clients/rpc.js';
import type { Config } from '../../src/config.js';
import { initAccessControl, resetForTests } from '../../src/access-control.js';

// ---------------------------------------------------------------------------
// Fake McpServer capturing the registered tool callback.
// ---------------------------------------------------------------------------
interface FakeServer {
  toolCbs: Map<string, (...args: unknown[]) => unknown>;
  registerTool: (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => void;
}

function makeFakeServer(): FakeServer {
  const toolCbs = new Map<string, (...args: unknown[]) => unknown>();
  return {
    toolCbs,
    registerTool(name, _config, cb) {
      toolCbs.set(name, cb);
    },
  };
}

const fakeExtra = { signal: new AbortController().signal, authInfo: undefined };

type ToolResult = { content: { text: string }[]; isError?: boolean };

/** Extract the (sole) text block of a CallToolResult. */
function text(res: ToolResult): string {
  const block = res.content[0];
  assert.ok(block, 'result has a content block');
  return block.text;
}

interface RecordedCall {
  chain: string;
  method: string;
  params: unknown[];
  source: RpcSource;
}

function makeFakeClient(
  reply: { endpointKind: 'local' | 'remote'; result?: unknown; error?: unknown },
): { client: RpcClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: RpcClient = {
    call: (chain, method, params, source) => {
      calls.push({ chain, method, params, source });
      return Promise.resolve(reply);
    },
  };
  return { client, calls };
}

function fakeConfig(endpoints: Config['rpcEndpoints']): Config {
  // Only `rpcEndpoints` is read by the tool; cast the rest.
  return { rpcEndpoints: endpoints } as Config;
}

/** Register `rpc_call` and return the captured handler + recorded calls. */
function setup(
  reply: { endpointKind: 'local' | 'remote'; result?: unknown; error?: unknown },
  endpoints: Config['rpcEndpoints'],
) {
  const { client, calls } = makeFakeClient(reply);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = makeFakeServer() as any;
  registerRpcTools(server, { client, config: fakeConfig(endpoints) });
  const cb = server.toolCbs.get('rpc_call') as (
    args: unknown,
    extra: unknown,
  ) => Promise<ToolResult>;
  assert.ok(cb, 'rpc_call was registered');
  return { cb, calls };
}

describe('rpc_call tool', () => {
  beforeEach(() => {
    resetForTests();
    // Grant the `read` class so the access-control wrapper lets handlers run.
    initAccessControl({ level: 'read_only', allow: new Set(), deny: new Set() });
  });

  it('passes an allowlisted method + configured chain to the client', async () => {
    const { cb, calls } = setup(
      { endpointKind: 'local', result: '0xa4b1' },
      { 'arbitrum-one': { local: 'http://node:8545' } },
    );
    const res = await cb(
      { chain: 'arbitrum-one', method: 'eth_chainId', params: [], source: 'auto' },
      fakeExtra,
    );
    assert.equal(res.isError, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      chain: 'arbitrum-one',
      method: 'eth_chainId',
      params: [],
      source: 'auto',
    });
    const payload = JSON.parse(text(res));
    assert.deepEqual(payload, {
      chain: 'arbitrum-one',
      endpoint_kind: 'local',
      result: '0xa4b1',
    });
  });

  it('refuses a state-changing method WITHOUT calling the client', async () => {
    const { cb, calls } = setup(
      { endpointKind: 'local', result: 'x' },
      { 'arbitrum-one': { local: 'http://node:8545' } },
    );
    const res = await cb(
      {
        chain: 'arbitrum-one',
        method: 'eth_sendRawTransaction',
        params: ['0xdeadbeef'],
        source: 'auto',
      },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.match(text(res), /not permitted \(read-only allowlist\)/);
    assert.equal(calls.length, 0, 'client must NOT be called for a refused method');
  });

  it('refuses an unknown chain WITHOUT calling the client', async () => {
    const { cb, calls } = setup(
      { endpointKind: 'local', result: 'x' },
      { 'arbitrum-one': { local: 'http://node:8545' } },
    );
    const res = await cb(
      { chain: 'ethereum', method: 'eth_chainId', params: [], source: 'auto' },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.match(text(res), /Unknown chain "ethereum"/);
    assert.match(text(res), /arbitrum-one/);
    assert.equal(calls.length, 0, 'client must NOT be called for an unknown chain');
  });

  it('surfaces a JSON-RPC error envelope faithfully', async () => {
    const { cb } = setup(
      { endpointKind: 'remote', error: { code: -32000, message: 'execution reverted' } },
      { 'arbitrum-one': { remote: 'http://pub/rpc' } },
    );
    const res = await cb(
      { chain: 'arbitrum-one', method: 'eth_call', params: [], source: 'remote' },
      fakeExtra,
    );
    assert.equal(res.isError, undefined);
    const payload = JSON.parse(text(res));
    assert.deepEqual(payload, {
      chain: 'arbitrum-one',
      endpoint_kind: 'remote',
      error: { code: -32000, message: 'execution reverted' },
    });
  });

  it('never leaks the endpoint URL in any output', async () => {
    const secret = 'http://arb-node:8545/v1/SUPERSECRETKEY';
    const { cb } = setup(
      { endpointKind: 'local', result: '0x1' },
      { 'arbitrum-one': { local: secret } },
    );
    const res = await cb(
      { chain: 'arbitrum-one', method: 'eth_blockNumber', params: [], source: 'auto' },
      fakeExtra,
    );
    const serialized = JSON.stringify(res);
    assert.doesNotMatch(serialized, /SUPERSECRETKEY/);
    assert.doesNotMatch(serialized, /arb-node/);
  });

  it('wraps a client throw in a fail-closed error without leaking the URL', async () => {
    const client: RpcClient = {
      // Simulate a transport failure surfaced by the client; its message is
      // already credential-safe (label-based).
      call: () => Promise.reject(new Error('[rpc:arbitrum-one:local] request timed out after 10000ms')),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = makeFakeServer() as any;
    registerRpcTools(server, {
      client,
      config: fakeConfig({ 'arbitrum-one': { local: 'http://arb-node:8545/SECRET' } }),
    });
    const cb = server.toolCbs.get('rpc_call') as (
      a: unknown,
      e: unknown,
    ) => Promise<ToolResult>;
    const res = await cb(
      { chain: 'arbitrum-one', method: 'eth_chainId', params: [], source: 'local' },
      fakeExtra,
    );
    assert.equal(res.isError, true);
    assert.match(text(res), /rpc_call failed for chain "arbitrum-one"/);
    assert.doesNotMatch(text(res), /SECRET/);
  });
});

describe('list_rpc_chains tool', () => {
  beforeEach(() => {
    resetForTests();
    initAccessControl({ level: 'read_only', allow: new Set(), deny: new Set() });
  });

  function listConfig(
    endpoints: Config['rpcEndpoints'],
    allowRemote: boolean,
  ): Config {
    return { rpcEndpoints: endpoints, rpcAllowRemote: allowRemote } as Config;
  }

  /** Register the tools and return the zero-arg `list_rpc_chains` callback. */
  function setupList(endpoints: Config['rpcEndpoints'], allowRemote: boolean) {
    const noopClient: RpcClient = { call: () => Promise.reject(new Error('unused')) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = makeFakeServer() as any;
    registerRpcTools(server, { client: noopClient, config: listConfig(endpoints, allowRemote) });
    // Zero-arg tool: the captured callback takes (extra) as its first argument.
    const cb = server.toolCbs.get('list_rpc_chains') as (extra: unknown) => Promise<ToolResult>;
    assert.ok(cb, 'list_rpc_chains was registered');
    return cb;
  }

  it('lists configured chains (sorted) with endpoint kinds and auto resolution', async () => {
    const cb = setupList(
      {
        'arbitrum-one': { local: 'http://l/SECRET', remote: 'http://r/SECRET' },
        mainnet: { remote: 'http://m/SECRET' },
        base: { local: 'http://b/SECRET' },
      },
      true,
    );
    const res = await cb(fakeExtra);
    assert.equal(res.isError, undefined);
    const payload = JSON.parse(text(res));

    assert.equal(payload.allow_remote, true);
    assert.equal(payload.count, 3);
    assert.deepEqual(
      payload.chains.map((c: { chain: string }) => c.chain),
      ['arbitrum-one', 'base', 'mainnet'],
      'chains are sorted',
    );
    assert.deepEqual(payload.chains[0], {
      chain: 'arbitrum-one',
      has_local: true,
      has_remote: true,
      remote_enabled: true,
      auto_source: 'local',
      usable: true,
    });
    assert.deepEqual(payload.chains[2], {
      chain: 'mainnet',
      has_local: false,
      has_remote: true,
      remote_enabled: true,
      auto_source: 'remote',
      usable: true,
    });
    // The read-only allowlist is surfaced for discovery; no write methods.
    assert.ok(payload.allowed_methods.includes('eth_call'));
    assert.ok(!payload.allowed_methods.includes('eth_sendRawTransaction'));
    // Never leak endpoint URLs/secrets.
    assert.doesNotMatch(JSON.stringify(payload), /SECRET/);
  });

  it('marks a remote-only chain unusable when RPC_ALLOW_REMOTE is false', async () => {
    const cb = setupList(
      {
        'arbitrum-one': { local: 'http://l', remote: 'http://r' },
        mainnet: { remote: 'http://m' },
      },
      false,
    );
    const payload = JSON.parse(text(await cb(fakeExtra)));
    assert.equal(payload.allow_remote, false);
    const byChain = Object.fromEntries(
      payload.chains.map((c: { chain: string }) => [c.chain, c]),
    );
    // local still works under auto
    assert.deepEqual(byChain['arbitrum-one'].auto_source, 'local');
    assert.equal(byChain['arbitrum-one'].usable, true);
    // remote-only chain: remote disabled → no usable endpoint via auto
    assert.equal(byChain['mainnet'].remote_enabled, false);
    assert.equal(byChain['mainnet'].auto_source, null);
    assert.equal(byChain['mainnet'].usable, false);
  });
});
