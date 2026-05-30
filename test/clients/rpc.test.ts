/**
 * Tests for the read-only JSON-RPC passthrough client (`createRpcClient`).
 *
 * Endpoint-resolution branches (unknown chain, missing local/remote, the
 * `allowRemote` kill-switch, `auto` local-preference + remote fallback) are
 * asserted directly. The POST/relay paths run against a real local
 * `node:http` server (matching test/utils/http.test.ts) so the JSON-RPC
 * `result` vs `error` envelope handling and the URL-never-leaks guarantee are
 * exercised against actual fetch behavior.
 *
 * The client owns endpoint resolution + the POST; it does NOT inspect `method`
 * (the tool owns the allowlist), so these tests never assert on method gating.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRpcClient } from '../../src/clients/rpc.js';
import type { Config } from '../../src/config.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let secretUrl: string;
let handler: Handler = (_req, res) => res.end('{}');

before(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  // A path + query that embeds a "secret" (e.g. an API key). It must never
  // surface in any returned value or thrown error message.
  secretUrl = `${baseUrl}/rpc/SUPERSECRETKEY?token=topsecret`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  handler = (_req, res) => res.end('{}');
});

type Endpoints = Config['rpcEndpoints'];

function client(endpoints: Endpoints, allowRemote = true) {
  return createRpcClient({ endpoints, allowRemote, timeoutMs: 1000, maxBytes: 1_000_000 });
}

describe('createRpcClient: endpoint resolution', () => {
  it('throws on an unknown chain', async () => {
    await assert.rejects(
      () => client({}).call('nope', 'eth_chainId', [], 'auto'),
      /unknown chain "nope"/,
    );
  });

  it('source=local with no local endpoint throws', async () => {
    await assert.rejects(
      () =>
        client({ 'arbitrum-one': { remote: 'http://x/rpc' } }).call(
          'arbitrum-one',
          'eth_chainId',
          [],
          'local',
        ),
      /no local endpoint for chain "arbitrum-one"/,
    );
  });

  it('source=remote with allowRemote=false throws (kill-switch)', async () => {
    await assert.rejects(
      () =>
        client({ 'arbitrum-one': { remote: 'http://x/rpc' } }, false).call(
          'arbitrum-one',
          'eth_chainId',
          [],
          'remote',
        ),
      /remote RPC endpoints are disabled \(RPC_ALLOW_REMOTE=false\)/,
    );
  });

  it('source=remote with no remote endpoint throws', async () => {
    await assert.rejects(
      () =>
        client({ 'arbitrum-one': { local: 'http://x/rpc' } }).call(
          'arbitrum-one',
          'eth_chainId',
          [],
          'remote',
        ),
      /no remote endpoint for chain "arbitrum-one"/,
    );
  });

  it('source=auto with no usable endpoint (only remote, remote disabled) throws', async () => {
    await assert.rejects(
      () =>
        client({ 'arbitrum-one': { remote: 'http://x/rpc' } }, false).call(
          'arbitrum-one',
          'eth_chainId',
          [],
          'auto',
        ),
      /no usable endpoint for chain "arbitrum-one"/,
    );
  });

  it('source=auto prefers the local endpoint (endpointKind=local)', async () => {
    handler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xa4b1' }));
      });
    };
    const out = await client({
      'arbitrum-one': { local: `${baseUrl}/local`, remote: `${baseUrl}/remote` },
    }).call('arbitrum-one', 'eth_chainId', [], 'auto');
    assert.equal(out.endpointKind, 'local');
    assert.equal(out.result, '0xa4b1');
  });

  it('source=auto falls back to remote when local is absent and allowRemote', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    };
    const out = await client({
      'arbitrum-one': { remote: `${baseUrl}/remote` },
    }).call('arbitrum-one', 'eth_blockNumber', [], 'auto');
    assert.equal(out.endpointKind, 'remote');
    assert.equal(out.result, '0x1');
  });
});

describe('createRpcClient: POST + envelope relay', () => {
  it('happy path returns { endpointKind, result }', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: '0x10' } }));
    };
    const out = await client({ x: { local: `${baseUrl}/rpc` } }).call(
      'x',
      'eth_getBlockByNumber',
      ['latest', false],
      'local',
    );
    assert.deepEqual(out, { endpointKind: 'local', result: { number: '0x10' } });
    assert.equal(out.error, undefined);
  });

  it('JSON-RPC error envelope is returned as { error }, not thrown', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'method not found' },
        }),
      );
    };
    const out = await client({ x: { remote: `${baseUrl}/rpc` } }).call(
      'x',
      'eth_call',
      [],
      'remote',
    );
    assert.equal(out.endpointKind, 'remote');
    assert.deepEqual(out.error, { code: -32601, message: 'method not found' });
    assert.equal(out.result, undefined);
  });

  it('forwards the JSON-RPC request body { jsonrpc, id, method, params }', async () => {
    let received: unknown;
    handler = (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
      });
    };
    await client({ x: { local: `${baseUrl}/rpc` } }).call(
      'x',
      'eth_getLogs',
      [{ fromBlock: '0x1' }],
      'local',
    );
    assert.deepEqual(received, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{ fromBlock: '0x1' }],
    });
  });

  it('transport failure (non-2xx) throws and the URL never leaks', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };
    await assert.rejects(
      () => client({ x: { local: secretUrl } }).call('x', 'eth_chainId', [], 'local'),
      (err: Error) => {
        assert.doesNotMatch(err.message, /SUPERSECRETKEY/);
        assert.doesNotMatch(err.message, /topsecret/);
        // The credential-safe label is used instead.
        assert.match(err.message, /rpc:x:local/);
        return true;
      },
    );
  });

  it('returned values never contain the endpoint URL or its secrets', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xa4b1' }));
    };
    const out = await client({ x: { local: secretUrl } }).call(
      'x',
      'eth_chainId',
      [],
      'local',
    );
    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, /SUPERSECRETKEY/);
    assert.doesNotMatch(serialized, /topsecret/);
    assert.doesNotMatch(serialized, /127\.0\.0\.1/);
  });
});
