/**
 * Tests for the shared HTTP helpers (`httpGetText` / `httpPostJson`). These use
 * a real local `node:http` server so the streaming/size-cap and timeout paths
 * exercise actual fetch behavior. Each test covers a fail-closed boundary:
 * 2xx happy path, non-2xx → throw, oversize body → throw, timeout → throw, and
 * that error messages reference the caller's `label` rather than the raw URL.
 */
import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { httpGetText, httpPostJson } from '../../src/utils/http.js';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler = (_req, res) => res.end('ok');

before(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  handler = (_req, res) => res.end('ok');
});

describe('httpGetText', () => {
  it('returns the body text on 2xx', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
    };
    const text = await httpGetText(`${baseUrl}/x`, {
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    assert.equal(text, 'hello world');
  });

  it('throws on non-2xx, using the label not the URL', async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end('nope');
    };
    await assert.rejects(
      httpGetText(`${baseUrl}/secret-path`, {
        timeoutMs: 1000,
        maxBytes: 1000,
        label: 'ipfs',
      }),
      (err: Error) => {
        assert.match(err.message, /\[ipfs\]/);
        assert.match(err.message, /503/);
        assert.doesNotMatch(err.message, /secret-path/);
        return true;
      },
    );
  });

  it('throws when the body exceeds maxBytes', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(10_000));
    };
    await assert.rejects(
      httpGetText(`${baseUrl}/big`, { timeoutMs: 1000, maxBytes: 100, label: 'ipfs' }),
      /exceeds 100 bytes/,
    );
  });

  it('throws on timeout', async () => {
    handler = (_req, res) => {
      // Never respond → force the internal timeout to fire.
      void res;
    };
    await assert.rejects(
      httpGetText(`${baseUrl}/slow`, { timeoutMs: 50, maxBytes: 1000, label: 'ipfs' }),
      /\[ipfs\] request timed out after 50ms/,
    );
  });

  it('falls back to origin (not full URL) when no label is given on error', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    await assert.rejects(
      httpGetText(`${baseUrl}/private/segment`, { timeoutMs: 1000, maxBytes: 1000 }),
      (err: Error) => {
        assert.match(err.message, new RegExp(baseUrl.replace(/[.]/g, '\\.')));
        assert.doesNotMatch(err.message, /private\/segment/);
        return true;
      },
    );
  });
});

describe('httpPostJson', () => {
  it('sends JSON + content-type and parses the JSON response', async () => {
    let receivedContentType: string | undefined;
    let receivedBody = '';
    handler = (req, res) => {
      receivedContentType = req.headers['content-type'];
      req.on('data', (c) => (receivedBody += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: JSON.parse(receivedBody) }));
      });
    };
    const out = await httpPostJson(
      `${baseUrl}/rpc`,
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { timeoutMs: 1000, maxBytes: 1000, label: 'chain=arbitrum-one local' },
    );
    assert.equal(receivedContentType, 'application/json');
    assert.deepEqual(out, {
      echoed: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    });
  });

  it('throws on non-2xx with the label', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };
    await assert.rejects(
      httpPostJson(`${baseUrl}/rpc`, {}, {
        timeoutMs: 1000,
        maxBytes: 1000,
        label: 'chain=arbitrum-one remote',
      }),
      (err: Error) => {
        assert.match(err.message, /\[chain=arbitrum-one remote\]/);
        assert.match(err.message, /500/);
        return true;
      },
    );
  });

  it('throws when the response body exceeds maxBytes', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: 'y'.repeat(10_000) }));
    };
    await assert.rejects(
      httpPostJson(`${baseUrl}/rpc`, {}, { timeoutMs: 1000, maxBytes: 100, label: 'rpc' }),
      /exceeds 100 bytes/,
    );
  });

  it('throws on invalid JSON response', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
    };
    await assert.rejects(
      httpPostJson(`${baseUrl}/rpc`, {}, { timeoutMs: 1000, maxBytes: 1000, label: 'rpc' }),
      /\[rpc\] response was not valid JSON/,
    );
  });

  it('throws on timeout', async () => {
    handler = (_req, _res) => {
      // Never respond.
    };
    await assert.rejects(
      httpPostJson(`${baseUrl}/rpc`, {}, { timeoutMs: 50, maxBytes: 1000, label: 'rpc' }),
      /\[rpc\] request timed out after 50ms/,
    );
  });
});
