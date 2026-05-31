/**
 * Tests for `createGraphmanClient` against the graphman GraphQL API.
 *
 * Uses a fake `TypedGraphqlClient` (`gql`) that records each (query, variables)
 * pair and returns a queued response. Assertions cover:
 *   - the correct GraphQL document + variables per op;
 *   - id normalization to the `Qm` form for deployment ops;
 *   - BlockNumber values serialized as strings on the wire;
 *   - async ops returning an execution id;
 *   - union decoding (reassign warnings, checkBlocks Result vs Execution,
 *     clearCallCache Empty vs Stale);
 *   - fixed existing-op selections (deployment.info list shape, restart bare
 *     scalar, execution.info status/errorMessage).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Variables } from 'graphql-request';

import { createGraphmanClient } from '../../src/clients/graphman.js';
import type { TypedGraphqlClient } from '../../src/utils/graphql-client.js';

// Canonical bytes32/Qm anchor pair (verified by ipfs.test.ts).
const KNOWN_BYTES32 =
  '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
const KNOWN_QM = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

interface Recorded {
  query: string;
  variables: Record<string, unknown> | undefined;
}

function fakeGql(responses: unknown[]): {
  gql: TypedGraphqlClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const gql: TypedGraphqlClient = {
    async request<TResult, TVariables extends Variables = Variables>(
      query: string,
      variables?: TVariables,
    ): Promise<TResult> {
      calls.push({ query, variables: variables as Record<string, unknown> | undefined });
      const r = responses[i++];
      return r as TResult;
    },
  };
  return { gql, calls };
}

describe('graphman client — deployment.info (fixed selections)', () => {
  it('queries the info LIST and maps status.isPaused / latestBlock / health', async () => {
    const { gql, calls } = fakeGql([
      {
        deployment: {
          info: [
            {
              hash: KNOWN_QM,
              shard: 'primary',
              chain: 'arbitrum-one',
              nodeId: 'index-node-0',
              health: 'CURRENT',
              status: {
                isPaused: true,
                health: 'HEALTHY',
                latestBlock: { number: '123' },
              },
            },
          ],
        },
      },
    ]);
    const client = createGraphmanClient({ gql });
    const info = await client.getDeploymentInfo(KNOWN_QM);
    assert.match(calls[0]!.query, /info\(deployment: \{ hash: \$hash \}\)/);
    assert.match(calls[0]!.query, /isPaused/);
    assert.ok(!/\bpaused\b/.test(calls[0]!.query.replace('isPaused', '')), 'no bare `paused` field');
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM });
    assert.deepEqual(info, {
      id: KNOWN_QM,
      paused: true,
      shard: 'primary',
      chain: 'arbitrum-one',
      node: 'index-node-0',
      latestBlock: 123,
      health: 'HEALTHY',
    });
  });

  it('normalizes a bytes32 id to Qm before querying', async () => {
    const { gql, calls } = fakeGql([
      { deployment: { info: [{ hash: KNOWN_QM, status: { isPaused: false } }] } },
    ]);
    const client = createGraphmanClient({ gql });
    await client.getDeploymentInfo(KNOWN_BYTES32);
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM });
  });

  it('throws when the info list is empty', async () => {
    const { gql } = fakeGql([{ deployment: { info: [] } }]);
    const client = createGraphmanClient({ gql });
    await assert.rejects(() => client.getDeploymentInfo(KNOWN_QM), /no record/);
  });
});

describe('graphman client — execution.info (fixed selections)', () => {
  it('selects status/errorMessage and normalizes INITIALIZING to RUNNING', async () => {
    const { gql, calls } = fakeGql([
      { execution: { info: { id: '42', status: 'INITIALIZING', errorMessage: null } } },
    ]);
    const client = createGraphmanClient({ gql });
    const status = await client.getExecutionStatus('42');
    assert.match(calls[0]!.query, /errorMessage/);
    assert.match(calls[0]!.query, /\$id: ExecutionId!/);
    assert.deepEqual(status, { id: '42', state: 'RUNNING' });
  });

  it('surfaces FAILED with the error message', async () => {
    const { gql } = fakeGql([
      { execution: { info: { id: '7', status: 'FAILED', errorMessage: 'boom' } } },
    ]);
    const client = createGraphmanClient({ gql });
    const status = await client.getExecutionStatus('7');
    assert.deepEqual(status, { id: '7', state: 'FAILED', error: 'boom' });
  });
});

describe('graphman client — restart (bare ExecutionId scalar)', () => {
  it('selects restart with NO sub-selection and reads the scalar', async () => {
    const { gql, calls } = fakeGql([{ deployment: { restart: '99' } }]);
    const client = createGraphmanClient({ gql });
    const res = await client.restartDeployment(KNOWN_QM);
    assert.match(calls[0]!.query, /restart\(deployment: \{ hash: \$hash \}\)/);
    assert.ok(!/restart\([^)]*\)\s*\{/.test(calls[0]!.query), 'restart must have no sub-selection');
    assert.deepEqual(res, { executionId: '99' });
  });
});

describe('graphman client — rewind (async, bare scalar)', () => {
  it('wraps the deployment in a list and returns an execution id', async () => {
    const { gql, calls } = fakeGql([{ deployment: { rewind: '1001' } }]);
    const client = createGraphmanClient({ gql });
    const res = await client.rewindDeployment(KNOWN_QM, {
      blockHash: '0x' + 'a'.repeat(64),
      blockNumber: 555,
      force: true,
      delaySeconds: 30,
    });
    assert.match(calls[0]!.query, /rewind\(\s*deployments: \[\{ hash: \$hash \}\]/);
    assert.ok(!/rewind\([\s\S]*?\)\s*\{/.test(calls[0]!.query), 'rewind has no sub-selection');
    assert.deepEqual(calls[0]!.variables, {
      hash: KNOWN_QM,
      blockHash: '0x' + 'a'.repeat(64),
      blockNumber: '555', // BlockNumber serialized as a string
      force: true,
      delaySeconds: 30,
    });
    assert.deepEqual(res, { executionId: '1001' });
  });

  it('supports start_block (truncate) mode without hash/number', async () => {
    const { gql, calls } = fakeGql([{ deployment: { rewind: '2' } }]);
    const client = createGraphmanClient({ gql });
    await client.rewindDeployment(KNOWN_QM, { startBlock: true });
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM, startBlock: true });
  });
});

describe('graphman client — deleteDeployment (drop)', () => {
  it('passes `all` and returns the deleted locators', async () => {
    const { gql, calls } = fakeGql([
      { deployment: { deleteDeployment: ['sgd1', 'sgd2'] } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.dropDeployment(KNOWN_QM, true);
    assert.match(calls[0]!.query, /deleteDeployment\(deployment: \{ hash: \$hash \}, all: \$all\)/);
    assert.ok(!/deleteDeployment\([^)]*\)\s*\{/.test(calls[0]!.query), 'no sub-selection on locator list');
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM, all: true });
    assert.deepEqual(res, { deletedLocators: ['sgd1', 'sgd2'] });
  });
});

describe('graphman client — reassign (union)', () => {
  it('decodes Ok (EmptyResponse) into { success }', async () => {
    const { gql, calls } = fakeGql([
      { deployment: { reassign: { __typename: 'EmptyResponse', success: true } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.reassignDeployment(KNOWN_QM, 'index-node-1');
    assert.match(calls[0]!.query, /\.\.\. on CompletedWithWarnings/);
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM, node: 'index-node-1' });
    assert.deepEqual(res, { success: true });
  });

  it('decodes CompletedWithWarnings into { success, warnings }', async () => {
    const { gql } = fakeGql([
      {
        deployment: {
          reassign: {
            __typename: 'CompletedWithWarnings',
            success: true,
            warnings: ['node is not in the cluster'],
          },
        },
      },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.reassignDeployment(KNOWN_QM, 'index-node-1');
    assert.deepEqual(res, { success: true, warnings: ['node is not in the cluster'] });
  });
});

describe('graphman client — unassign', () => {
  it('returns success', async () => {
    const { gql, calls } = fakeGql([{ deployment: { unassign: { success: true } } }]);
    const client = createGraphmanClient({ gql });
    const res = await client.unassignDeployment(KNOWN_QM);
    assert.deepEqual(calls[0]!.variables, { hash: KNOWN_QM });
    assert.deepEqual(res, { success: true });
  });
});

describe('graphman client — checkBlocks (union)', () => {
  it('byNumber → synchronous Result with decoded outcomes', async () => {
    const { gql, calls } = fakeGql([
      {
        chain: {
          checkBlocks: {
            __typename: 'CheckBlocksResult',
            diverged: 1,
            blocks: [
              { number: 10, outcome: 'DIVERGED', hashes: [], diff: 'a != b' },
              { number: 11, outcome: 'MATCHED', hashes: [], diff: null },
            ],
          },
        },
      },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.checkBlocks({
      chain: 'arbitrum-one',
      byNumber: { number: 10, deleteDuplicates: true },
    });
    assert.deepEqual(calls[0]!.variables, {
      chain: 'arbitrum-one',
      method: { byNumber: { number: '10', deleteDuplicates: true } },
    });
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.diverged, 1);
      assert.deepEqual(res.result.blocks[0], {
        number: 10,
        outcome: 'Diverged',
        hashes: [],
        diff: 'a != b',
      });
      assert.equal(res.result.blocks[1]!.outcome, 'Matched');
    }
  });

  it('byHash → synchronous Result', async () => {
    const { gql, calls } = fakeGql([
      { chain: { checkBlocks: { __typename: 'CheckBlocksResult', diverged: 0, blocks: [] } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.checkBlocks({ chain: 'c', byHash: '0x' + 'b'.repeat(64) });
    assert.deepEqual(calls[0]!.variables, {
      chain: 'c',
      method: { byHash: '0x' + 'b'.repeat(64) },
    });
    assert.equal(res.kind, 'result');
  });

  it('byRange → async Execution returns an execution id', async () => {
    const { gql, calls } = fakeGql([
      { chain: { checkBlocks: { __typename: 'CheckBlocksExecution', id: '777' } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.checkBlocks({
      chain: 'arbitrum-one',
      byRange: { from: 1, to: 100 },
    });
    assert.deepEqual(calls[0]!.variables, {
      chain: 'arbitrum-one',
      method: { byRange: { from: '1', to: '100' } },
    });
    assert.deepEqual(res, { kind: 'execution', executionId: '777' });
  });
});

describe('graphman client — truncateChainCache', () => {
  it('returns success', async () => {
    const { gql, calls } = fakeGql([
      { chain: { truncateChainCache: { success: true } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.truncateChainCache('arbitrum-one');
    assert.deepEqual(calls[0]!.variables, { chain: 'arbitrum-one' });
    assert.deepEqual(res, { success: true });
  });
});

describe('graphman client — clearCallCache (union)', () => {
  it('range mode → Empty', async () => {
    const { gql, calls } = fakeGql([
      { chain: { clearCallCache: { __typename: 'EmptyResponse', success: true } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.clearCallCache({ chain: 'c', from: 1, to: 9 });
    assert.deepEqual(calls[0]!.variables, { chain: 'c', from: '1', to: '9' });
    assert.deepEqual(res, { kind: 'empty', success: true });
  });

  it('ttlDays mode → Stale stats', async () => {
    const { gql, calls } = fakeGql([
      {
        chain: {
          clearCallCache: {
            __typename: 'StaleCallCacheResponse',
            effectiveTtlDays: 30,
            cacheEntriesDeleted: 12,
            contractsDeleted: 3,
          },
        },
      },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.clearCallCache({ chain: 'c', ttlDays: 14, maxContracts: 5 });
    assert.deepEqual(calls[0]!.variables, { chain: 'c', ttlDays: 14, maxContracts: 5 });
    assert.deepEqual(res, {
      kind: 'stale',
      stats: { effectiveTtlDays: 30, cacheEntriesDeleted: 12, contractsDeleted: 3 },
    });
  });

  it('removeEntireCache mode → Empty', async () => {
    const { gql, calls } = fakeGql([
      { chain: { clearCallCache: { __typename: 'EmptyResponse', success: true } } },
    ]);
    const client = createGraphmanClient({ gql });
    const res = await client.clearCallCache({ chain: 'c', removeEntireCache: true });
    assert.deepEqual(calls[0]!.variables, { chain: 'c', removeEntireCache: true });
    assert.deepEqual(res, { kind: 'empty', success: true });
  });
});
