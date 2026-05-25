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

export interface NetworkSubgraphClient {
  getIndexer(address: string): Promise<Indexer | null>;
  getActiveAllocations(indexerAddress: string): Promise<PaginatedResult<Allocation>>;
  getAllocations(
    indexerAddress: string,
    status: AllocationStatusFilter,
  ): Promise<PaginatedResult<Allocation>>;
  getDeployment(deploymentId: string): Promise<SubgraphDeployment | null>;
  getSignalledDeployments(minSignal: string): Promise<PaginatedResult<SubgraphDeployment>>;
  getNetworkParameters(): Promise<GraphNetwork>;
  getDeploymentAllocations(deploymentId: string): Promise<PaginatedResult<Allocation>>;
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
 */
async function paginate<TItem>(
  fetchPage: (skip: number) => Promise<TItem[]>,
): Promise<PaginatedResult<TItem>> {
  const out: TItem[] = [];
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
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

  async function getIndexer(address: string): Promise<Indexer | null> {
    const data = await gql.request<IndexerResponse>(GET_INDEXER_QUERY, {
      id: normalizeAddress(address),
    });
    return data.indexer ?? null;
  }

  async function getAllocations(
    indexerAddress: string,
    status: AllocationStatusFilter,
  ): Promise<PaginatedResult<Allocation>> {
    const where = buildAllocationFilter({ indexer: indexerAddress, status });
    return paginate<Allocation>(async (skip) => {
      const data = await gql.request<AllocationsResponse>(GET_ALLOCATIONS_QUERY, {
        where,
        first: PAGE_SIZE,
        skip,
      });
      return data.allocations;
    });
  }

  async function getActiveAllocations(
    indexerAddress: string,
  ): Promise<PaginatedResult<Allocation>> {
    return getAllocations(indexerAddress, 'Active');
  }

  async function getDeployment(
    deploymentId: string,
  ): Promise<SubgraphDeployment | null> {
    const data = await gql.request<DeploymentResponse>(GET_DEPLOYMENT_QUERY, {
      id: deploymentId,
    });
    return data.subgraphDeployment ?? null;
  }

  async function getSignalledDeployments(
    minSignal: string,
  ): Promise<PaginatedResult<SubgraphDeployment>> {
    return paginate<SubgraphDeployment>(async (skip) => {
      const data = await gql.request<SignalledDeploymentsResponse>(
        GET_SIGNALLED_DEPLOYMENTS_QUERY,
        { minSignal, first: PAGE_SIZE, skip },
      );
      return data.subgraphDeployments;
    });
  }

  async function getNetworkParameters(): Promise<GraphNetwork> {
    const data = await gql.request<GraphNetworkResponseRaw>(GET_NETWORK_QUERY);
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
  }

  async function getDeploymentAllocations(
    deploymentId: string,
  ): Promise<PaginatedResult<Allocation>> {
    const where = buildAllocationFilter({ deployment: deploymentId, status: 'Active' });
    return paginate<Allocation>(async (skip) => {
      const data = await gql.request<AllocationsResponse>(GET_ALLOCATIONS_QUERY, {
        where,
        first: PAGE_SIZE,
        skip,
      });
      return data.allocations;
    });
  }

  return {
    getIndexer,
    getActiveAllocations,
    getAllocations,
    getDeployment,
    getSignalledDeployments,
    getNetworkParameters,
    getDeploymentAllocations,
  };
}
