import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import type {
  Block,
  ChainIndexingStatus,
  SubgraphError,
  SubgraphIndexingStatus,
} from '../types/graphnode.js';

export interface GraphNodeClientOptions {
  /** Graph Node status endpoint, e.g. `http://localhost:8030/graphql`. */
  endpoint: string;
}

export interface GraphNodeClient {
  /**
   * Fetch indexing status for the supplied deployments, or for every
   * deployment the node is syncing when `deploymentIds` is omitted/empty.
   */
  getIndexingStatuses(deploymentIds?: string[]): Promise<SubgraphIndexingStatus[]>;
  /**
   * Convenience wrapper around `getIndexingStatuses` for a single deployment.
   * Returns `null` when graph-node doesn't know about the deployment.
   */
  getDeploymentHealth(deploymentId: string): Promise<SubgraphIndexingStatus | null>;
  /**
   * Entity count as a decimal string (BigInt over the wire). Returns `null`
   * when the deployment isn't tracked by this graph-node.
   */
  getEntityCount(deploymentId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// GraphQL query — kept here (not extracted) so the response shape and query
// stay in lockstep.
// ---------------------------------------------------------------------------

const INDEXING_STATUSES_QUERY = /* GraphQL */ `
  query IndexingStatuses($subgraphs: [String!]) {
    indexingStatuses(subgraphs: $subgraphs) {
      subgraph
      synced
      health
      fatalError {
        message
        handler
        deterministic
        block {
          number
          hash
        }
      }
      nonFatalErrors {
        message
        handler
        deterministic
        block {
          number
          hash
        }
      }
      chains {
        network
        chainHeadBlock {
          number
          hash
        }
        latestBlock {
          number
          hash
        }
        earliestBlock {
          number
          hash
        }
        lastHealthyBlock {
          number
          hash
        }
      }
      entityCount
    }
  }
`;

// ---------------------------------------------------------------------------
// Raw response shape — mirrors the GraphQL schema. Everything is nullable so
// we can defensively normalize before handing data to callers.
// ---------------------------------------------------------------------------

interface RawBlock {
  number: string;
  hash: string;
}

interface RawSubgraphError {
  message: string;
  handler?: string | null;
  deterministic?: boolean | null;
  block?: RawBlock | null;
}

interface RawChain {
  network: string;
  chainHeadBlock?: RawBlock | null;
  latestBlock?: RawBlock | null;
  earliestBlock?: RawBlock | null;
  lastHealthyBlock?: RawBlock | null;
}

interface RawIndexingStatus {
  subgraph: string;
  synced: boolean;
  health: string;
  fatalError?: RawSubgraphError | null;
  nonFatalErrors?: RawSubgraphError[] | null;
  chains?: RawChain[] | null;
  entityCount: string;
}

interface IndexingStatusesResponse {
  indexingStatuses: RawIndexingStatus[] | null;
}

// ---------------------------------------------------------------------------
// Normalization — strip nulls, coerce health to the union, drop undefineds.
// ---------------------------------------------------------------------------

function normalizeBlock(raw: RawBlock | null | undefined): Block | undefined {
  if (!raw) return undefined;
  return { number: raw.number, hash: raw.hash };
}

function normalizeError(raw: RawSubgraphError | null | undefined): SubgraphError | undefined {
  if (!raw) return undefined;
  const out: SubgraphError = {
    message: raw.message,
    deterministic: raw.deterministic ?? false,
  };
  const block = normalizeBlock(raw.block);
  if (block) out.block = block;
  if (raw.handler) out.handler = raw.handler;
  return out;
}

function normalizeChain(raw: RawChain): ChainIndexingStatus {
  const out: ChainIndexingStatus = { network: raw.network };
  const chainHead = normalizeBlock(raw.chainHeadBlock);
  if (chainHead) out.chainHeadBlock = chainHead;
  const earliest = normalizeBlock(raw.earliestBlock);
  if (earliest) out.earliestBlock = earliest;
  const latest = normalizeBlock(raw.latestBlock);
  if (latest) out.latestBlock = latest;
  const lastHealthy = normalizeBlock(raw.lastHealthyBlock);
  if (lastHealthy) out.lastHealthyBlock = lastHealthy;
  return out;
}

function coerceHealth(value: string): SubgraphIndexingStatus['health'] {
  if (value === 'healthy' || value === 'unhealthy' || value === 'failed') {
    return value;
  }
  // graph-node exposes `health` as a strict GraphQL enum; an unknown value
  // signals schema drift, not a degraded state. Surface it loudly so the
  // registration helper's try/catch returns an `isError: true` CallToolResult.
  throw new Error(`Unexpected graph-node health value: "${value}". Schema drift?`);
}

function normalizeStatus(raw: RawIndexingStatus): SubgraphIndexingStatus {
  const status: SubgraphIndexingStatus = {
    subgraph: raw.subgraph,
    synced: raw.synced,
    health: coerceHealth(raw.health),
    nonFatalErrors: (raw.nonFatalErrors ?? [])
      .map((e) => normalizeError(e))
      .filter((e): e is SubgraphError => e !== undefined),
    chains: (raw.chains ?? []).map(normalizeChain),
    entityCount: raw.entityCount,
  };
  const fatal = normalizeError(raw.fatalError);
  if (fatal) status.fatalError = fatal;
  return status;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createGraphNodeClient(opts: GraphNodeClientOptions): GraphNodeClient {
  const gql: TypedGraphqlClient = createGraphqlClient({
    endpoint: opts.endpoint,
    label: 'graph-node-status',
  });

  async function getIndexingStatuses(
    deploymentIds?: string[],
  ): Promise<SubgraphIndexingStatus[]> {
    // graph-node treats `subgraphs: null` (or omitted) as "return everything".
    // Pass `null` only when the caller didn't filter so we don't send `[]` and
    // get back an empty list.
    const variables = {
      subgraphs: deploymentIds && deploymentIds.length > 0 ? deploymentIds : null,
    };
    const data = await gql.request<IndexingStatusesResponse>(
      INDEXING_STATUSES_QUERY,
      variables,
    );
    return (data.indexingStatuses ?? []).map(normalizeStatus);
  }

  async function getDeploymentHealth(
    deploymentId: string,
  ): Promise<SubgraphIndexingStatus | null> {
    const statuses = await getIndexingStatuses([deploymentId]);
    return statuses[0] ?? null;
  }

  async function getEntityCount(deploymentId: string): Promise<string | null> {
    const status = await getDeploymentHealth(deploymentId);
    return status ? status.entityCount : null;
  }

  return {
    getIndexingStatuses,
    getDeploymentHealth,
    getEntityCount,
  };
}
