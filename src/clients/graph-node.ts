import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import { TtlCache } from '../utils/cache.js';
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

/**
 * Optional per-call options for client methods. `signal` is forwarded to the
 * GraphQL client so caller-initiated cancellation aborts the in-flight fetch.
 */
export interface GraphNodeCallOpts {
  signal?: AbortSignal;
}

export interface GraphNodeClient {
  /**
   * Fetch indexing status for the supplied deployments, or for every
   * deployment the node is syncing when `deploymentIds` is omitted/empty.
   */
  getIndexingStatuses(
    deploymentIds?: string[],
    opts?: GraphNodeCallOpts,
  ): Promise<SubgraphIndexingStatus[]>;
  /**
   * Convenience wrapper around `getIndexingStatuses` for a single deployment.
   * Returns `null` when graph-node doesn't know about the deployment.
   */
  getDeploymentHealth(
    deploymentId: string,
    opts?: GraphNodeCallOpts,
  ): Promise<SubgraphIndexingStatus | null>;
  /**
   * Entity count as a decimal string (BigInt over the wire). Returns `null`
   * when the deployment isn't tracked by this graph-node.
   */
  getEntityCount(
    deploymentId: string,
    opts?: GraphNodeCallOpts,
  ): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// GraphQL queries — kept here (not extracted) so the response shape and query
// stay in lockstep.
//
// Two distinct queries on purpose: graph-node panics with "entered unreachable
// code" when `indexingStatuses(subgraphs: $subgraphs)` is invoked with
// `$subgraphs` explicitly null. To get "all deployments" we must omit the
// argument entirely; to filter we must pass a non-null `[String!]!`.
// ---------------------------------------------------------------------------

const INDEXING_STATUSES_SELECTION = /* GraphQL */ `
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
`;

const INDEXING_STATUSES_ALL_QUERY = /* GraphQL */ `
  query IndexingStatusesAll {
    indexingStatuses {
      ${INDEXING_STATUSES_SELECTION}
    }
  }
`;

const INDEXING_STATUSES_BY_IDS_QUERY = /* GraphQL */ `
  query IndexingStatusesByIds($subgraphs: [String!]!) {
    indexingStatuses(subgraphs: $subgraphs) {
      ${INDEXING_STATUSES_SELECTION}
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

  // Caches per design §4.1.2: indexing status refreshes every 5 minutes.
  const statusesCache = new TtlCache<string, SubgraphIndexingStatus[]>({
    ttlMs: 300_000,
    label: 'graph-node-statuses',
  });
  const healthCache = new TtlCache<string, SubgraphIndexingStatus | null>({
    ttlMs: 300_000,
    label: 'graph-node-health',
  });

  async function getIndexingStatuses(
    deploymentIds?: string[],
    callOpts?: GraphNodeCallOpts,
  ): Promise<SubgraphIndexingStatus[]> {
    // Short-circuit: an explicit empty filter means "no deployments asked
    // for", so return [] without an upstream call. graph-node's GraphQL
    // would treat `subgraphs: []` ambiguously (some versions return "all",
    // mirroring `null`); short-circuiting also keeps the cache key for
    // `[]` distinct from `undefined` ('all'), since previously both
    // collided on key 'all' with identical payloads.
    if (deploymentIds !== undefined && deploymentIds.length === 0) {
      return [];
    }

    // Cache key:
    //   - 'all' when no filter (graph-node returns every tracked deployment)
    //   - sorted-and-joined deployment IDs otherwise, so equivalent filters
    //     (regardless of input ordering) share a cache slot.
    const key =
      deploymentIds && deploymentIds.length > 0
        ? [...deploymentIds].sort().join(',')
        : 'all';
    return statusesCache.getOrFetch(
      key,
      async (fetchOpts) => {
        // Route to one of two distinct GraphQL operations. graph-node panics
        // ("entered unreachable code") when `subgraphs: null` is passed
        // explicitly, so the "all deployments" path must omit the argument
        // entirely via a separate query with no variables. The `[]` input is
        // short-circuited above, so by here `deploymentIds` is either
        // undefined (→ all) or non-empty (→ by-ids).
        const data =
          deploymentIds && deploymentIds.length > 0
            ? await gql.request<IndexingStatusesResponse>(
                INDEXING_STATUSES_BY_IDS_QUERY,
                { subgraphs: deploymentIds },
                fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
              )
            : await gql.request<IndexingStatusesResponse>(
                INDEXING_STATUSES_ALL_QUERY,
                undefined,
                fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
              );
        return (data.indexingStatuses ?? []).map(normalizeStatus);
      },
      callOpts?.signal ? { signal: callOpts.signal, keyLabel: key } : { keyLabel: key },
    );
  }

  async function getDeploymentHealth(
    deploymentId: string,
    callOpts?: GraphNodeCallOpts,
  ): Promise<SubgraphIndexingStatus | null> {
    return healthCache.getOrFetch(
      deploymentId,
      async (fetchOpts) => {
        // Call the underlying GraphQL directly — invoking getIndexingStatuses
        // here would route through statusesCache under a single-element key,
        // creating two cache layers for the same data.
        const data = await gql.request<IndexingStatusesResponse>(
          INDEXING_STATUSES_BY_IDS_QUERY,
          { subgraphs: [deploymentId] },
          fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
        );
        const statuses = (data.indexingStatuses ?? []).map(normalizeStatus);
        return statuses[0] ?? null;
      },
      callOpts?.signal
        ? { signal: callOpts.signal, keyLabel: deploymentId }
        : { keyLabel: deploymentId },
    );
  }

  async function getEntityCount(
    deploymentId: string,
    callOpts?: GraphNodeCallOpts,
  ): Promise<string | null> {
    const status = await getDeploymentHealth(deploymentId, callOpts);
    return status ? status.entityCount : null;
  }

  return {
    getIndexingStatuses,
    getDeploymentHealth,
    getEntityCount,
  };
}
