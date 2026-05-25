import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import type { NetworkEpochBlockNumber } from '../types/ebo.js';

/**
 * Client for the Epoch Block Oracle (EBO) subgraph.
 *
 * Exposes the minimum surface needed by Stage 1 tools:
 *   - the current epoch (number + per-chain start blocks)
 *   - the start block for a specific (epoch, chain) pair
 *   - history of per-chain epoch-start blocks for a given chain
 *
 * All block numbers are returned as `string` (BigInt-scale).
 *
 * TODO: verify against live schema — entity/field names below mirror the
 * design doc table (§2.2) but the production EBO subgraph may differ.
 */
export interface EboSubgraphClient {
  /**
   * Returns the latest epoch and the per-chain start blocks within it.
   * Implementation queries the most recent `Epoch` entity, then separately
   * fetches the `NetworkEpochBlockNumber` rows for that epoch number.
   */
  getCurrentEpoch(): Promise<{
    epochNumber: number;
    networkBlocks: Array<{ network: string; blockNumber: string }>;
  }>;

  /**
   * Returns the epoch-start block for a specific chain at a specific epoch,
   * or `null` if no row exists (e.g. chain not tracked yet, or epoch in the
   * future).
   */
  getEpochBlocks(
    epochNumber: number,
    chain: string,
  ): Promise<{ network: string; epochNumber: number; blockNumber: string } | null>;

  /**
   * Returns the most recent `limit` epoch-start-block rows for a chain,
   * ordered by descending epoch number. Useful for trending / sanity checks.
   */
  getNetworkEpochs(chain: string, limit?: number): Promise<NetworkEpochBlockNumber[]>;
}

export interface EboSubgraphClientOptions {
  endpoint: string;
}

// ---------------------------------------------------------------------------
// GraphQL operations
// ---------------------------------------------------------------------------

/**
 * Fetch the latest `Epoch` entity. Per design §2.2, `Epoch` has fields:
 *   { id, startBlock, endBlock }
 * The id IS the epoch number (as a string), so we order by id desc and parse
 * the id to get the numeric epoch.
 *
 * TODO: verify against live schema. If the live subgraph exposes an explicit
 * `epochNumber` field, prefer ordering by that.
 */
const LATEST_EPOCH_QUERY = /* GraphQL */ `
  query LatestEpoch {
    epoches(first: 1, orderBy: id, orderDirection: desc) {
      id
      startBlock
      endBlock
    }
  }
`;

interface LatestEpochResponse {
  epoches: Array<{
    id: string;
    startBlock: string;
    endBlock: string | null;
  }>;
}

/**
 * Fetch all `NetworkEpochBlockNumber` rows for a given epoch. Per design §2.2:
 *   NetworkEpochBlockNumber { id, network, epochNumber, blockNumber }
 *
 * TODO: verify against live schema. The `network` field is assumed to be a
 * scalar string (chain alias); if it's a reference to a `Network` entity,
 * swap to `network_: { id: $...}` or `network: $...` accordingly.
 */
const EPOCH_NETWORK_BLOCKS_QUERY = /* GraphQL */ `
  query EpochNetworkBlocks($epochNumber: BigInt!, $limit: Int!) {
    networkEpochBlockNumbers(
      where: { epochNumber: $epochNumber }
      first: $limit
    ) {
      id
      network
      epochNumber
      blockNumber
    }
  }
`;

interface EpochNetworkBlocksResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    network: string;
    epochNumber: string | number;
    blockNumber: string;
  }>;
}

/**
 * Look up the (epoch, chain) start block via a `where` filter on the design's
 * `NetworkEpochBlockNumber` entity. Using a filter (not a composite id) avoids
 * guessing the id format used by the live subgraph.
 *
 * TODO: verify against live schema (see note on EPOCH_NETWORK_BLOCKS_QUERY re:
 * `network` being a scalar vs. relation).
 */
const EPOCH_BLOCKS_QUERY = /* GraphQL */ `
  query EpochBlocks($network: String!, $epochNumber: BigInt!) {
    networkEpochBlockNumbers(
      where: { network: $network, epochNumber: $epochNumber }
      first: 1
    ) {
      id
      network
      epochNumber
      blockNumber
    }
  }
`;

interface EpochBlocksResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    network: string;
    epochNumber: string | number;
    blockNumber: string;
  }>;
}

/**
 * Per-chain epoch history.
 *
 * TODO: verify against live schema. Assumes `network` is a scalar field.
 */
const NETWORK_EPOCHS_QUERY = /* GraphQL */ `
  query NetworkEpochs($network: String!, $limit: Int!) {
    networkEpochBlockNumbers(
      where: { network: $network }
      first: $limit
      orderBy: epochNumber
      orderDirection: desc
    ) {
      id
      network
      epochNumber
      blockNumber
    }
  }
`;

interface NetworkEpochsResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    network: string;
    epochNumber: string | number;
    blockNumber: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInt(value: string | number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`EBO subgraph returned non-numeric value: ${String(value)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEboSubgraphClient(opts: EboSubgraphClientOptions): EboSubgraphClient {
  const gql: TypedGraphqlClient = createGraphqlClient({
    endpoint: opts.endpoint,
    label: 'ebo-subgraph',
  });

  return {
    async getCurrentEpoch() {
      const latest = await gql.request<LatestEpochResponse>(LATEST_EPOCH_QUERY);
      const epoch = latest.epoches[0];
      if (!epoch) {
        throw new Error('EBO subgraph returned no epochs');
      }
      const epochNumber = toInt(epoch.id);

      // BigInt-typed GraphQL args are passed as strings by graphql-request.
      const blocks = await gql.request<EpochNetworkBlocksResponse>(
        EPOCH_NETWORK_BLOCKS_QUERY,
        { epochNumber: String(epochNumber), limit: 1000 },
      );

      return {
        epochNumber,
        networkBlocks: blocks.networkEpochBlockNumbers.map((row) => ({
          network: row.network,
          blockNumber: row.blockNumber,
        })),
      };
    },

    async getEpochBlocks(epochNumber, chain) {
      const data = await gql.request<EpochBlocksResponse>(EPOCH_BLOCKS_QUERY, {
        network: chain,
        epochNumber: String(epochNumber),
      });
      const row = data.networkEpochBlockNumbers[0];
      if (!row) return null;
      return {
        network: row.network,
        epochNumber: toInt(row.epochNumber),
        blockNumber: row.blockNumber,
      };
    },

    async getNetworkEpochs(chain, limit = 10) {
      const data = await gql.request<NetworkEpochsResponse>(NETWORK_EPOCHS_QUERY, {
        network: chain,
        limit,
      });
      return data.networkEpochBlockNumbers.map((row) => ({
        id: row.id,
        network: row.network,
        epochNumber: toInt(row.epochNumber),
        blockNumber: row.blockNumber,
      }));
    },
  };
}
