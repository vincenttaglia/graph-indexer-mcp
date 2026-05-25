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
   * Implementation queries the most recent `Epoch` entity and its associated
   * `NetworkEpochBlockNumber` rows.
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
 * Fetch the latest `Epoch` and its child `NetworkEpochBlockNumber` rows.
 *
 * TODO: verify against live schema. Assumed shape:
 *   type Epoch {
 *     id: ID!  # epoch number as string
 *     epochNumber: BigInt!
 *     startBlock: BigInt!
 *     blockNumbers: [NetworkEpochBlockNumber!]!  # derived/reverse relation
 *   }
 */
const CURRENT_EPOCH_QUERY = /* GraphQL */ `
  query CurrentEpoch {
    epoches(first: 1, orderBy: epochNumber, orderDirection: desc) {
      id
      epochNumber
      startBlock
      blockNumbers {
        network {
          id
        }
        blockNumber
      }
    }
  }
`;

interface CurrentEpochResponse {
  epoches: Array<{
    id: string;
    epochNumber: string | number;
    startBlock: string;
    blockNumbers: Array<{
      network: { id: string };
      blockNumber: string;
    }>;
  }>;
}

/**
 * Look up the (epoch, chain) start block.
 *
 * TODO: verify against live schema. We rely on the convention that the
 * `NetworkEpochBlockNumber.id` is `"<network>-<epochNumber>"`. If the live
 * subgraph uses a different id format, switch to a `where` filter:
 *   networkEpochBlockNumbers(
 *     where: { network: $network, epochNumber: $epochNumber }, first: 1
 *   ) { ... }
 */
const EPOCH_BLOCKS_BY_ID_QUERY = /* GraphQL */ `
  query EpochBlocks($id: ID!) {
    networkEpochBlockNumber(id: $id) {
      id
      epochNumber
      blockNumber
      network {
        id
      }
    }
  }
`;

interface EpochBlocksByIdResponse {
  networkEpochBlockNumber: {
    id: string;
    epochNumber: string | number;
    blockNumber: string;
    network: { id: string };
  } | null;
}

/**
 * Per-chain epoch history.
 *
 * TODO: verify against live schema. Assumed filter shape: `network: ID`.
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
      epochNumber
      blockNumber
      network {
        id
      }
    }
  }
`;

interface NetworkEpochsResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    epochNumber: string | number;
    blockNumber: string;
    network: { id: string };
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
      const data = await gql.request<CurrentEpochResponse>(CURRENT_EPOCH_QUERY);
      const epoch = data.epoches[0];
      if (!epoch) {
        throw new Error('EBO subgraph returned no epochs');
      }
      return {
        epochNumber: toInt(epoch.epochNumber),
        networkBlocks: epoch.blockNumbers.map((b) => ({
          network: b.network.id,
          blockNumber: b.blockNumber,
        })),
      };
    },

    async getEpochBlocks(epochNumber, chain) {
      const id = `${chain}-${epochNumber}`;
      const data = await gql.request<EpochBlocksByIdResponse>(EPOCH_BLOCKS_BY_ID_QUERY, {
        id,
      });
      const row = data.networkEpochBlockNumber;
      if (!row) return null;
      return {
        network: row.network.id,
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
        network: row.network.id,
        epochNumber: toInt(row.epochNumber),
        blockNumber: row.blockNumber,
      }));
    },
  };
}
