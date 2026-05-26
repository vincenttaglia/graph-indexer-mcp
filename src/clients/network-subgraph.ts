/**
 * Network Subgraph client.
 *
 * Thin wrapper around the shared `createGraphqlClient` that knows the field
 * shapes for the network subgraph (Indexer / Allocation / SubgraphDeployment /
 * GraphNetwork). All on-chain numeric fields stay as `string` to preserve
 * BigInt precision.
 *
 * Addresses are normalized to lowercase on the wire — the network subgraph
 * stores `Indexer.id` and `Allocation.indexer.id` as lowercase hex.
 *
 * GraphQL fragments below were sketched from the well-known network-subgraph
 * schema and the entities listed in `graph-indexer-mcp-design.md` §2.1. Any
 * field whose canonical name is uncertain is flagged with
 * `// TODO: verify against live schema` in `src/types/network.ts`.
 */

import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import { TtlCache } from '../utils/cache.js';
import { toBytes32DeploymentId } from '../utils/ipfs.js';
import type {
  Allocation,
  AllocationStatus,
  GraphNetwork,
  Indexer,
  SubgraphDeployment,
} from '../types/network.js';

export interface NetworkSubgraphClientOptions {
  endpoint: string;
}

/** Status filter accepted by `getAllocations`. */
export type AllocationStatusFilter = 'Active' | 'Closed' | 'all';

/**
 * Result of a paginated list query — `truncated` is true when the iterator
 * stopped because it hit `MAX_PAGES`, false when it stopped because the most
 * recent page was short (i.e. the natural end of the result set).
 */
export interface PaginatedResult<T> {
  items: T[];
  truncated: boolean;
}

/**
 * Optional per-call options for client methods. `signal` is forwarded through
 * the GraphQL client and ultimately to `fetch` so caller-initiated cancellation
 * aborts the in-flight request.
 */
export interface NetworkSubgraphCallOpts {
  signal?: AbortSignal;
}

export interface NetworkSubgraphClient {
  getIndexer(address: string, opts?: NetworkSubgraphCallOpts): Promise<Indexer | null>;
  getActiveAllocations(
    indexerAddress: string,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>>;
  getAllocations(
    indexerAddress: string,
    status: AllocationStatusFilter,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>>;
  getAllocationById(
    allocationId: string,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<Allocation | null>;
  getDeployment(
    deploymentId: string,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<SubgraphDeployment | null>;
  getSignalledDeployments(
    minSignal: string,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<SubgraphDeployment>>;
  getNetworkParameters(opts?: NetworkSubgraphCallOpts): Promise<GraphNetwork>;
  getDeploymentAllocations(
    deploymentId: string,
    opts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>>;
}

// =============================================================================
// GraphQL fragments / queries
// =============================================================================

// NOTE: `delegationRatio` is intentionally NOT listed here — the live network
// subgraph schema defines `delegationRatio` on `GraphNetwork` (protocol-wide),
// not on `Indexer`. Querying it on `Indexer` produces a GraphQL validation
// error. See `getNetworkParameters` for the corresponding field.
const INDEXER_FIELDS = /* GraphQL */ `
  fragment IndexerFields on Indexer {
    id
    stakedTokens
    allocatedTokens
    delegatedTokens
    tokenCapacity
    indexingRewardCut
    queryFeeCut
    url
    geoHash
  }
`;

const ALLOCATION_FIELDS = /* GraphQL */ `
  fragment AllocationFields on Allocation {
    id
    indexer {
      id
    }
    subgraphDeployment {
      id
      signalledTokens
      stakedTokens
      deniedAt
    }
    allocatedTokens
    createdAtEpoch
    createdAtBlockHash
    createdAtBlockNumber
    closedAtEpoch
    closedAtBlockHash
    closedAtBlockNumber
    status
    poi
    indexingRewards
    queryFeesCollected
    isLegacy
  }
`;

const DEPLOYMENT_FIELDS = /* GraphQL */ `
  fragment DeploymentFields on SubgraphDeployment {
    id
    signalledTokens
    stakedTokens
    indexingRewardAmount
    queryFeesAmount
    deniedAt
  }
`;

const GET_INDEXER_QUERY = /* GraphQL */ `
  ${INDEXER_FIELDS}
  query GetIndexer($id: ID!) {
    indexer(id: $id) {
      ...IndexerFields
    }
  }
`;

const GET_ALLOCATIONS_QUERY = /* GraphQL */ `
  ${ALLOCATION_FIELDS}
  query GetAllocations($where: Allocation_filter!, $first: Int!, $skip: Int!) {
    allocations(
      where: $where
      first: $first
      skip: $skip
      orderBy: createdAtBlockNumber
      orderDirection: desc
    ) {
      ...AllocationFields
    }
  }
`;

const GET_DEPLOYMENT_QUERY = /* GraphQL */ `
  ${DEPLOYMENT_FIELDS}
  query GetDeployment($id: ID!) {
    subgraphDeployment(id: $id) {
      ...DeploymentFields
    }
  }
`;

const GET_ALLOCATION_BY_ID_QUERY = /* GraphQL */ `
  ${ALLOCATION_FIELDS}
  query GetAllocationById($id: ID!) {
    allocation(id: $id) {
      ...AllocationFields
    }
  }
`;

const GET_SIGNALLED_DEPLOYMENTS_QUERY = /* GraphQL */ `
  ${DEPLOYMENT_FIELDS}
  query GetSignalledDeployments($minSignal: BigInt!, $first: Int!, $skip: Int!) {
    subgraphDeployments(
      where: { signalledTokens_gte: $minSignal }
      first: $first
      skip: $skip
      orderBy: signalledTokens
      orderDirection: desc
    ) {
      ...DeploymentFields
    }
  }
`;

// `networkGRTIssuancePerBlock` is the canonical field on the live mainnet
// network subgraph (per-block issuance, wei). It REPLACES the older
// `networkGRTIssuance` (which was an annual rate in some forks). We expose
// the per-block value raw and let callers convert using a chain-specific
// `blocksPerYear` constant. `delegationRatio` is the protocol-wide cap.
const GET_NETWORK_QUERY = /* GraphQL */ `
  query GetNetworkParameters {
    graphNetwork(id: "1") {
      id
      totalSupply
      totalTokensAllocated
      totalTokensSignalled
      currentEpoch
      epochLength
      networkGRTIssuancePerBlock
      delegationRatio
    }
  }
`;

// =============================================================================
// Implementation
// =============================================================================

/** Page size for unbounded list queries; the network subgraph caps at 1000. */
const PAGE_SIZE = 1000;
/** Hard cap on pages we will fetch to avoid runaway queries. */
const MAX_PAGES = 20;

interface IndexerResponse {
  indexer: Indexer | null;
}

interface AllocationsResponse {
  allocations: Allocation[];
}

interface DeploymentResponse {
  subgraphDeployment: SubgraphDeployment | null;
}

interface AllocationByIdResponse {
  allocation: Allocation | null;
}

interface SignalledDeploymentsResponse {
  subgraphDeployments: SubgraphDeployment[];
}

interface GraphNetworkResponseRaw {
  graphNetwork:
    | (Omit<GraphNetwork, 'networkGRTIssuancePerBlock' | 'delegationRatio'> & {
        networkGRTIssuancePerBlock?: string | null;
        delegationRatio?: number | null;
      })
    | null;
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

/**
 * Build the `Allocation_filter` portion of a query.
 *
 * Status filtering uses the subgraph's enum values directly (`Active`,
 * `Closed`). When `status === 'all'`, no status predicate is emitted so both
 * historical and active rows are returned.
 */
function buildAllocationFilter(opts: {
  indexer?: string;
  deployment?: string;
  status?: AllocationStatusFilter;
}): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (opts.indexer) where['indexer'] = normalizeAddress(opts.indexer);
  if (opts.deployment) where['subgraphDeployment'] = opts.deployment;
  if (opts.status && opts.status !== 'all') {
    where['status'] = opts.status satisfies AllocationStatus;
  }
  return where;
}

/**
 * Paginate a list endpoint. Stops when a page returns fewer than `PAGE_SIZE`
 * rows (natural end) or when `MAX_PAGES` is reached (defensive cap). When the
 * cap is hit, `truncated` is true so callers can warn the user that the
 * result set was clipped at `MAX_PAGES * PAGE_SIZE` rows.
 *
 * Honors `signal` between pages so a cancellation observed after one page
 * doesn't trigger the next request. The signal is also passed into each
 * `fetchPage` call by the caller.
 */
async function paginate<TItem>(
  fetchPage: (skip: number) => Promise<TItem[]>,
  signal?: AbortSignal,
): Promise<PaginatedResult<TItem>> {
  const out: TItem[] = [];
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    signal?.throwIfAborted();
    const rows = await fetchPage(page * PAGE_SIZE);
    out.push(...rows);
    if (rows.length < PAGE_SIZE) {
      truncated = false;
      break;
    }
  }
  return { items: out, truncated };
}

export function createNetworkSubgraphClient(
  opts: NetworkSubgraphClientOptions,
): NetworkSubgraphClient {
  const gql: TypedGraphqlClient = createGraphqlClient({
    endpoint: opts.endpoint,
    label: 'network-subgraph',
  });

  // Caches per design §4.1.2:
  //   - network parameters: 1 hour (slow-moving protocol config)
  //   - deployment-scoped reads: 15 minutes (curation signal drifts slowly)
  const networkParamsCache = new TtlCache<'network_params', GraphNetwork>({
    ttlMs: 3_600_000,
    label: 'network',
  });
  const deploymentCache = new TtlCache<string, SubgraphDeployment | null>({
    ttlMs: 900_000,
    label: 'network-deployment',
  });
  const deploymentAllocationsCache = new TtlCache<string, PaginatedResult<Allocation>>({
    ttlMs: 900_000,
    label: 'network-deployment-allocations',
  });
  const signalledDeploymentsCache = new TtlCache<string, PaginatedResult<SubgraphDeployment>>({
    ttlMs: 900_000,
    label: 'network-signalled',
  });

  async function getIndexer(
    address: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<Indexer | null> {
    const data = await gql.request<IndexerResponse>(
      GET_INDEXER_QUERY,
      { id: normalizeAddress(address) },
      callOpts?.signal ? { signal: callOpts.signal } : undefined,
    );
    return data.indexer ?? null;
  }

  async function getAllocations(
    indexerAddress: string,
    status: AllocationStatusFilter,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>> {
    const where = buildAllocationFilter({ indexer: indexerAddress, status });
    return paginate<Allocation>(async (skip) => {
      const data = await gql.request<AllocationsResponse>(
        GET_ALLOCATIONS_QUERY,
        { where, first: PAGE_SIZE, skip },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return data.allocations;
    }, callOpts?.signal);
  }

  async function getActiveAllocations(
    indexerAddress: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>> {
    return getAllocations(indexerAddress, 'Active', callOpts);
  }

  async function getAllocationById(
    allocationId: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<Allocation | null> {
    // Allocation.id is a 0x-prefixed hex address — lowercase it for the
    // network subgraph's `id: ID!` lookup so callers can pass either case.
    // No caching here: queue-time lookups are rare and the field that
    // matters (`isLegacy`) is immutable once the allocation exists.
    const id = allocationId.toLowerCase();
    const data = await gql.request<AllocationByIdResponse>(
      GET_ALLOCATION_BY_ID_QUERY,
      { id },
      callOpts?.signal ? { signal: callOpts.signal } : undefined,
    );
    return data.allocation ?? null;
  }

  async function getDeployment(
    deploymentId: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<SubgraphDeployment | null> {
    // Network subgraph stores SubgraphDeployment.id as bytes32. Normalize
    // here so callers can pass either bytes32 or Qm form — passing a Qm
    // straight through silently returns null.
    const bytes32Id = toBytes32DeploymentId(deploymentId);
    return deploymentCache.getOrFetch(
      bytes32Id,
      async (fetchOpts) => {
        const data = await gql.request<DeploymentResponse>(
          GET_DEPLOYMENT_QUERY,
          { id: bytes32Id },
          fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
        );
        return data.subgraphDeployment ?? null;
      },
      callOpts?.signal
        ? { signal: callOpts.signal, keyLabel: bytes32Id }
        : { keyLabel: bytes32Id },
    );
  }

  async function getSignalledDeployments(
    minSignal: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<SubgraphDeployment>> {
    const key = String(minSignal);
    return signalledDeploymentsCache.getOrFetch(
      key,
      async (fetchOpts) =>
        paginate<SubgraphDeployment>(async (skip) => {
          const data = await gql.request<SignalledDeploymentsResponse>(
            GET_SIGNALLED_DEPLOYMENTS_QUERY,
            { minSignal, first: PAGE_SIZE, skip },
            fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
          );
          return data.subgraphDeployments;
        }, fetchOpts.signal),
      callOpts?.signal ? { signal: callOpts.signal, keyLabel: key } : { keyLabel: key },
    );
  }

  async function getNetworkParameters(
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<GraphNetwork> {
    return networkParamsCache.getOrFetch(
      'network_params',
      async (fetchOpts) => {
        const data = await gql.request<GraphNetworkResponseRaw>(
          GET_NETWORK_QUERY,
          undefined,
          fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
        );
        if (!data.graphNetwork) {
          throw new Error('GraphNetwork singleton (id="1") not found in network subgraph.');
        }
        const raw = data.graphNetwork;
        return {
          id: raw.id,
          totalSupply: raw.totalSupply,
          totalTokensAllocated: raw.totalTokensAllocated,
          totalTokensSignalled: raw.totalTokensSignalled,
          currentEpoch: raw.currentEpoch,
          epochLength: raw.epochLength,
          networkGRTIssuancePerBlock: raw.networkGRTIssuancePerBlock ?? '0',
          delegationRatio: raw.delegationRatio ?? 0,
        };
      },
      callOpts?.signal
        ? { signal: callOpts.signal, keyLabel: 'network_params' }
        : { keyLabel: 'network_params' },
    );
  }

  async function getDeploymentAllocations(
    deploymentId: string,
    callOpts?: NetworkSubgraphCallOpts,
  ): Promise<PaginatedResult<Allocation>> {
    // Network subgraph stores `Allocation.subgraphDeployment.id` as bytes32
    // (the `where.subgraphDeployment` filter — see buildAllocationFilter).
    // Normalize here so callers can pass either bytes32 or Qm form —
    // passing a Qm straight through silently returns 0 allocations.
    const bytes32Id = toBytes32DeploymentId(deploymentId);
    return deploymentAllocationsCache.getOrFetch(
      bytes32Id,
      async (fetchOpts) => {
        const where = buildAllocationFilter({ deployment: bytes32Id, status: 'Active' });
        return paginate<Allocation>(async (skip) => {
          const data = await gql.request<AllocationsResponse>(
            GET_ALLOCATIONS_QUERY,
            { where, first: PAGE_SIZE, skip },
            fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
          );
          return data.allocations;
        }, fetchOpts.signal);
      },
      callOpts?.signal
        ? { signal: callOpts.signal, keyLabel: bytes32Id }
        : { keyLabel: bytes32Id },
    );
  }

  return {
    getIndexer,
    getActiveAllocations,
    getAllocations,
    getAllocationById,
    getDeployment,
    getSignalledDeployments,
    getNetworkParameters,
    getDeploymentAllocations,
  };
}
