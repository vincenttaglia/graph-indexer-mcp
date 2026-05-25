import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import { TtlCache } from '../utils/cache.js';
import type { NetworkEpochBlockNumber } from '../types/ebo.js';

/**
 * One per-network start-block row as returned by `getCurrentEpoch`.
 *
 * `network` is the human-readable chain alias (e.g. `arbitrum-one`,
 * `mainnet`) — `Network.alias` in the EBO schema.
 * `chainId` is the EVM chain id — `Network.id` in the EBO schema.
 * `blockNumber` / `acceleration` / `delta` are BigInt values kept as strings
 * so the whole payload remains JSON-serializable end-to-end (no BigInt across
 * MCP / tool boundaries).
 */
export interface EpochNetworkStartBlock {
  network: string;
  chainId: string;
  blockNumber: string;
  acceleration: string;
  delta: string;
}

interface CurrentEpochResult {
  epoch: number;
  blockNumbersByNetwork: EpochNetworkStartBlock[];
}

interface EpochBlocksResult {
  network: string;
  chainId: string;
  epochNumber: number;
  blockNumber: string;
}

/**
 * Client for the Epoch Block Oracle (EBO) subgraph.
 *
 * Exposes the minimum surface needed by Stage 1+ tools:
 *   - the current epoch (number + per-chain start blocks)
 *   - the start block for a specific (epoch, chain) pair
 *   - history of per-chain epoch-start blocks for a given chain
 *
 * All block numbers are returned as `string` (BigInt-scale). The whole return
 * surface is JSON-serializable.
 *
 * Verified against the live EBO subgraph schema
 * (4KFYqUWRTZQ9gn7GPHC6YQ2q15chJfVrX43ezYcwkgxB) — see `types/ebo.ts` for the
 * canonical entity shapes. Key insight: `Epoch` itself has no startBlock /
 * endBlock; per-network start blocks live on `NetworkEpochBlockNumber`,
 * reachable via the `Epoch.blockNumbers` @derivedFrom relation.
 */

/**
 * Optional per-call options for client methods. `signal` is forwarded to the
 * GraphQL client so caller-initiated cancellation aborts the in-flight fetch.
 */
export interface EboSubgraphCallOpts {
  signal?: AbortSignal;
}

export interface EboSubgraphClient {
  /**
   * Returns the latest epoch and the per-chain start blocks within it.
   *
   * Implementation queries the most recent `Epoch` entity (ordered by
   * `epochNumber` desc) and pulls the per-network start blocks via the
   * `Epoch.blockNumbers` @derivedFrom relation in a single round-trip.
   */
  getCurrentEpoch(opts?: EboSubgraphCallOpts): Promise<CurrentEpochResult>;

  /**
   * Returns the epoch-start block for a specific chain at a specific epoch,
   * or `null` if no row exists (e.g. chain not tracked yet, or epoch in the
   * future).
   *
   * `chain` is matched against `Network.alias`.
   */
  getEpochBlocks(
    epochNumber: number,
    chain: string,
    opts?: EboSubgraphCallOpts,
  ): Promise<EpochBlocksResult | null>;

  /**
   * Returns the most recent `limit` epoch-start-block rows for a chain
   * (matched against `Network.alias`), ordered by descending epoch number.
   * Useful for trending / sanity checks.
   */
  getNetworkEpochs(
    chain: string,
    limit?: number,
    opts?: EboSubgraphCallOpts,
  ): Promise<NetworkEpochBlockNumber[]>;
}

export interface EboSubgraphClientOptions {
  endpoint: string;
}

// ---------------------------------------------------------------------------
// GraphQL operations
// ---------------------------------------------------------------------------

/**
 * Fetch the latest `Epoch` plus its per-network start-block rows in one
 * round-trip. We prefer this "Option B" (sort epochs desc) over reading
 * `GlobalState.latestValidEpoch` because GlobalState's id is a deployment
 * convention we cannot verify from the schema alone; sorting epochs by
 * `epochNumber desc` is unambiguous and uses only documented schema fields.
 */
const LATEST_EPOCH_QUERY = /* GraphQL */ `
  query LatestEpoch {
    epoches(first: 1, orderBy: epochNumber, orderDirection: desc) {
      id
      epochNumber
      blockNumbers(first: 100) {
        blockNumber
        acceleration
        delta
        network {
          id
          alias
        }
      }
    }
  }
`;

interface LatestEpochResponse {
  epoches: Array<{
    id: string;
    epochNumber: string | number;
    blockNumbers: Array<{
      blockNumber: string;
      acceleration: string;
      delta: string;
      network: {
        id: string;
        alias: string;
      };
    }>;
  }>;
}

/**
 * Look up the (epoch, chain) start block on `NetworkEpochBlockNumber`. Two
 * scalar `where` predicates: `epochNumber` (BigInt) and `network` (entity
 * relation — filtered by Network.alias via the `network_` sub-filter, which
 * The Graph generates for every relation field).
 *
 * We filter on `Network.alias` (not `Network.id` / chainId) because the
 * consumer-facing string is the chain alias used everywhere else in
 * graph-node (e.g. `mainnet`, `arbitrum-one`).
 */
const EPOCH_BLOCKS_QUERY = /* GraphQL */ `
  query EpochBlocks($alias: String!, $epochNumber: BigInt!) {
    networkEpochBlockNumbers(
      where: { epochNumber: $epochNumber, network_: { alias: $alias } }
      first: 1
    ) {
      id
      epochNumber
      blockNumber
      acceleration
      delta
      network {
        id
        alias
      }
    }
  }
`;

interface EpochBlocksResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    epochNumber: string | number;
    blockNumber: string;
    acceleration: string;
    delta: string;
    network: {
      id: string;
      alias: string;
    };
  }>;
}

/**
 * Per-chain epoch history. Same entity / same field shape as
 * `EPOCH_BLOCKS_QUERY` but ordered desc and unbounded by epoch.
 */
const NETWORK_EPOCHS_QUERY = /* GraphQL */ `
  query NetworkEpochs($alias: String!, $limit: Int!) {
    networkEpochBlockNumbers(
      where: { network_: { alias: $alias } }
      first: $limit
      orderBy: epochNumber
      orderDirection: desc
    ) {
      id
      epochNumber
      blockNumber
      acceleration
      delta
      network {
        id
        alias
      }
    }
  }
`;

interface NetworkEpochsResponse {
  networkEpochBlockNumbers: Array<{
    id: string;
    epochNumber: string | number;
    blockNumber: string;
    acceleration: string;
    delta: string;
    network: {
      id: string;
      alias: string;
    };
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

  // Caches per design §4.1.2: epoch info refreshes every 5 minutes.
  const currentEpochCache = new TtlCache<'current_epoch', CurrentEpochResult>({
    ttlMs: 300_000,
    label: 'ebo-current-epoch',
  });
  // Stored Promise resolves to the row OR null when not present, so the
  // negative result is also cached briefly (avoids re-querying for known
  // missing rows within the TTL window).
  const epochBlocksCache = new TtlCache<string, EpochBlocksResult | null>({
    ttlMs: 300_000,
    label: 'ebo-epoch-blocks',
  });

  return {
    async getCurrentEpoch(callOpts) {
      return currentEpochCache.getOrFetch(
        'current_epoch',
        async (fetchOpts) => {
          const reqOpts = fetchOpts.signal ? { signal: fetchOpts.signal } : undefined;
          const latest = await gql.request<LatestEpochResponse>(
            LATEST_EPOCH_QUERY,
            undefined,
            reqOpts,
          );
          const epoch = latest.epoches[0];
          if (!epoch) {
            throw new Error('EBO subgraph returned no epochs');
          }
          return {
            epoch: toInt(epoch.epochNumber),
            blockNumbersByNetwork: epoch.blockNumbers.map((row) => ({
              network: row.network.alias,
              chainId: row.network.id,
              blockNumber: row.blockNumber,
              acceleration: row.acceleration,
              delta: row.delta,
            })),
          };
        },
        callOpts?.signal
          ? { signal: callOpts.signal, keyLabel: 'current_epoch' }
          : { keyLabel: 'current_epoch' },
      );
    },

    async getEpochBlocks(epochNumber, chain, callOpts) {
      const key = `${epochNumber}|${chain}`;
      return epochBlocksCache.getOrFetch(
        key,
        async (fetchOpts) => {
          const data = await gql.request<EpochBlocksResponse>(
            EPOCH_BLOCKS_QUERY,
            { alias: chain, epochNumber: String(epochNumber) },
            fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
          );
          const row = data.networkEpochBlockNumbers[0];
          if (!row) return null;
          return {
            network: row.network.alias,
            chainId: row.network.id,
            epochNumber: toInt(row.epochNumber),
            blockNumber: row.blockNumber,
          };
        },
        callOpts?.signal ? { signal: callOpts.signal, keyLabel: key } : { keyLabel: key },
      );
    },

    async getNetworkEpochs(chain, limit = 10, callOpts) {
      const data = await gql.request<NetworkEpochsResponse>(
        NETWORK_EPOCHS_QUERY,
        { alias: chain, limit },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return data.networkEpochBlockNumbers.map((row) => ({
        id: row.id,
        network: row.network.alias,
        chainId: row.network.id,
        epochNumber: toInt(row.epochNumber),
        blockNumber: row.blockNumber,
        acceleration: row.acceleration,
        delta: row.delta,
      }));
    },
  };
}
