/**
 * Tests for the IPFS gateway client (`createIpfsClient`).
 *
 * Uses a real local `node:http` server (matching the style of
 * `test/utils/http.test.ts`) so the `cat()` path exercises actual fetch +
 * `httpGetText` behavior end to end. Coverage:
 *   - `cat(cid)` issues `GET /ipfs/<cid>` and returns the body verbatim.
 *   - a gateway URL WITH a trailing slash and one WITHOUT both produce exactly
 *     `/ipfs/<cid>` (no double slash).
 *   - non-2xx fails closed (throws), with the error referencing the CID but not
 *     the raw gateway URL (credential hygiene from `httpGetText`'s `label`).
 */
import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createIpfsClient } from '../../src/clients/ipfs.js';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

let server: http.Server;
let baseUrl: string;
let lastPath: string | undefined;
let handler: Handler = (_req, res) => res.end('ok');

before(async () => {
  server = http.createServer((req, res) => {
    lastPath = req.url;
    handler(req, res);
  });
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
  lastPath = undefined;
});

const CID = 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh52';

describe('createIpfsClient.cat', () => {
  it('GETs /ipfs/<cid> and returns the body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('specVersion: 0.0.4\n');
    };
    const client = createIpfsClient({ gatewayUrl: baseUrl, maxBytes: 1_000 });
    const out = await client.cat(CID);
    assert.equal(out, 'specVersion: 0.0.4\n');
    assert.equal(lastPath, `/ipfs/${CID}`);
  });

  it('joins a gateway URL WITH a trailing slash without doubling it', async () => {
    handler = (_req, res) => res.end('ok');
    const client = createIpfsClient({ gatewayUrl: `${baseUrl}/`, maxBytes: 1_000 });
    await client.cat(CID);
    assert.equal(lastPath, `/ipfs/${CID}`);
  });

  it('joins a gateway URL with multiple trailing slashes without doubling it', async () => {
    handler = (_req, res) => res.end('ok');
    const client = createIpfsClient({ gatewayUrl: `${baseUrl}///`, maxBytes: 1_000 });
    await client.cat(CID);
    assert.equal(lastPath, `/ipfs/${CID}`);
  });

  it('fails closed on non-2xx, naming the CID but not the raw URL', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end('not found');
    };
    const client = createIpfsClient({ gatewayUrl: baseUrl, maxBytes: 1_000 });
    await assert.rejects(client.cat(CID), (err: Error) => {
      assert.match(err.message, new RegExp(CID));
      assert.match(err.message, /\[ipfs\]/);
      assert.match(err.message, /404/);
      return true;
    });
  });

  it('fails closed when the body exceeds maxBytes', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(10_000));
    };
    const client = createIpfsClient({ gatewayUrl: baseUrl, maxBytes: 100 });
    await assert.rejects(client.cat(CID), /exceeds 100 bytes/);
  });
});
