/**
 * Config tests focused on the manifest/RPC fields added in the
 * manifest-and-rpc-tools foundation. The most error-prone piece is the
 * `RPC_ALLOW_REMOTE` boolean-from-env parse: Zod's `z.coerce.boolean()` would
 * turn the string "false" into `true`, so we use a dedicated parser. These
 * tests pin its truth table plus the `RPC_ENDPOINTS` JSON guard and defaults.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

/** Minimal env that satisfies every required field. */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    INDEXER_ADDRESS: '0x1234567890abcdef1234567890abcdef12345678',
    NETWORK_SUBGRAPH_URL: 'https://example.com/network',
    EBO_SUBGRAPH_URL: 'https://example.com/ebo',
    QOS_SUBGRAPH_URL: 'https://example.com/qos',
    GRAPH_NODE_STATUS_URL: 'http://localhost:8030/graphql',
    INDEXER_AGENT_URL: 'http://localhost:18000/graphql',
    GRAPHMAN_API_URL: 'http://localhost:8050',
    GRAPHMAN_AUTH_TOKEN: 'token',
  };
}

describe('config: RPC_ALLOW_REMOTE boolean-from-env', () => {
  it('defaults to true when unset', () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.rpcAllowRemote, true);
  });

  it('maps "false" → false (the z.coerce.boolean footgun)', () => {
    const cfg = loadConfig({ ...baseEnv(), RPC_ALLOW_REMOTE: 'false' });
    assert.equal(cfg.rpcAllowRemote, false);
  });

  it('maps "true" → true', () => {
    const cfg = loadConfig({ ...baseEnv(), RPC_ALLOW_REMOTE: 'true' });
    assert.equal(cfg.rpcAllowRemote, true);
  });

  it('treats 0/no/off (case-insensitive) as false', () => {
    for (const v of ['0', 'no', 'off', 'OFF', 'No', 'FALSE']) {
      const cfg = loadConfig({ ...baseEnv(), RPC_ALLOW_REMOTE: v });
      assert.equal(cfg.rpcAllowRemote, false, `expected ${v} → false`);
    }
  });

  it('treats other non-empty strings (e.g. "1", "yes") as true', () => {
    for (const v of ['1', 'yes', 'on', 'anything']) {
      const cfg = loadConfig({ ...baseEnv(), RPC_ALLOW_REMOTE: v });
      assert.equal(cfg.rpcAllowRemote, true, `expected ${v} → true`);
    }
  });

  it('an empty string falls back to the default (true)', () => {
    const cfg = loadConfig({ ...baseEnv(), RPC_ALLOW_REMOTE: '' });
    assert.equal(cfg.rpcAllowRemote, true);
  });
});

describe('config: IPFS + RPC defaults', () => {
  it('applies IPFS + RPC defaults when unset', () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.ipfsGatewayUrl, 'https://ipfs.network.thegraph.com');
    assert.equal(cfg.ipfsMaxBytes, 5_000_000);
    assert.deepEqual(cfg.rpcEndpoints, {});
    assert.equal(cfg.rpcTimeoutMs, 10_000);
    assert.equal(cfg.rpcMaxBytes, 2_000_000);
  });

  it('coerces IPFS_MAX_BYTES / RPC_* numeric envs', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IPFS_MAX_BYTES: '123',
      RPC_TIMEOUT_MS: '5000',
      RPC_MAX_BYTES: '999',
    });
    assert.equal(cfg.ipfsMaxBytes, 123);
    assert.equal(cfg.rpcTimeoutMs, 5000);
    assert.equal(cfg.rpcMaxBytes, 999);
  });
});

describe('config: RPC_ENDPOINTS parse', () => {
  it('parses a valid JSON map', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      RPC_ENDPOINTS: JSON.stringify({
        'arbitrum-one': {
          local: 'http://arb-node:8545',
          remote: 'https://arb1.arbitrum.io/rpc',
        },
        mainnet: { remote: 'https://eth.example/rpc' },
      }),
    });
    assert.equal(cfg.rpcEndpoints['arbitrum-one']?.local, 'http://arb-node:8545');
    assert.equal(cfg.rpcEndpoints['mainnet']?.remote, 'https://eth.example/rpc');
  });

  it('throws a clear, prefixed error on malformed JSON (no raw SyntaxError)', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv(), RPC_ENDPOINTS: '{not json' }),
      /RPC_ENDPOINTS must be valid JSON:/,
    );
  });

  it('rejects an entry with neither local nor remote', () => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(),
          RPC_ENDPOINTS: JSON.stringify({ 'arbitrum-one': {} }),
        }),
      /each chain needs a local or remote URL/,
    );
  });
});
