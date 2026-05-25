/**
 * Network Subgraph entity types.
 *
 * Mirror of the on-chain entities the Graph Network indexes on Arbitrum. All
 * numeric on-chain values are kept as `string` to preserve BigInt precision —
 * GRT and signal amounts are wei-denominated (1e18) and overflow JavaScript's
 * Number safely above ~9 GRT.
 *
 * Fields below cover what the Stage 1 tools need today; additional fields can
 * be appended as workflows grow. Where the precise GraphQL schema name was
 * uncertain (especially around reward/fee accounting and metadata shapes),
 * the field is annotated with `// TODO: verify against live schema`.
 */

/** Allocation lifecycle status as reported by the network subgraph. */
export type AllocationStatus = 'Active' | 'Closed' | 'Null' | 'Finalized' | 'Claimed';

/**
 * Indexer entity — the operator's protocol-level account.
 *
 * `tokenCapacity` represents the indexer's maximum allocatable stake taking
 * delegation into account (own stake + delegated stake capped by the protocol
 * delegation ratio). Reward/fee cuts are PPM (parts-per-million, 1e6 = 100%).
 *
 * Note: the protocol-wide `delegationRatio` lives on `GraphNetwork`, not on
 * `Indexer`. The live network subgraph schema has no per-indexer
 * `delegationRatio` field; querying it returns a GraphQL validation error.
 */
export interface Indexer {
  id: string;
  /** Own stake (wei, BigInt-as-string). */
  stakedTokens: string;
  /** Currently allocated across all active allocations (wei). */
  allocatedTokens: string;
  /** Delegated to this indexer (wei). */
  delegatedTokens: string;
  /** Effective max allocatable stake including delegation, in wei. */
  tokenCapacity: string;
  /** Share of indexing rewards retained by indexer (PPM, 1e6 = 100%). */
  indexingRewardCut: number;
  /** Share of query fees retained by indexer (PPM). */
  queryFeeCut: number;
  /** Account this indexer pays rewards/fees from. */
  // TODO: verify against live schema
  url?: string | null;
  /** Free-form metadata (geo, name). */
  // TODO: verify against live schema
  geoHash?: string | null;
}

/**
 * Allocation entity — a stake position on a single subgraph deployment.
 *
 * `createdAtEpoch` / `closedAtEpoch` are epoch numbers (not block numbers).
 * `poi` is only populated after closure. `subgraphDeployment` is embedded as
 * a partial reference (id is always present; other fields filled when the
 * query asks for them).
 */
export interface Allocation {
  id: string;
  indexer: { id: string };
  subgraphDeployment: SubgraphDeploymentRef;
  /** Tokens allocated (wei, BigInt-as-string). */
  allocatedTokens: string;
  createdAtEpoch: number;
  createdAtBlockHash?: string;
  createdAtBlockNumber?: number;
  closedAtEpoch?: number | null;
  closedAtBlockHash?: string | null;
  closedAtBlockNumber?: number | null;
  status: AllocationStatus;
  /** Proof of indexing submitted at close, hex-encoded. Null while active. */
  poi?: string | null;
  /** Rewards collected for this allocation, wei. */
  // TODO: verify against live schema
  indexingRewards?: string;
  /** Query fees collected, wei. */
  // TODO: verify against live schema
  queryFeesCollected?: string;
}

/** Lightweight reference embedded inside Allocation results. */
export interface SubgraphDeploymentRef {
  id: string;
  /** Total curation signal in wei (BigInt-as-string). */
  signalledTokens?: string;
  /** Total tokens allocated across all indexers (wei). */
  stakedTokens?: string;
  /** 0 if rewards enabled; otherwise the block at which they were denied. */
  deniedAt?: number;
}

/**
 * SubgraphDeployment entity — the canonical record for a deployment (IPFS hash).
 *
 * Reward and fee accumulators are lifetime totals expressed in wei.
 */
export interface SubgraphDeployment {
  id: string;
  /** Total curation signal across all curators (wei). */
  signalledTokens: string;
  /** Total tokens allocated across all indexers (wei). */
  stakedTokens: string;
  /** Cumulative indexing rewards earned for this deployment (wei). */
  // TODO: verify against live schema
  indexingRewardAmount: string;
  /** Cumulative query fees collected (wei). */
  // TODO: verify against live schema
  queryFeesAmount: string;
  /**
   * Block number at which rewards were denied (e.g., chain not whitelisted).
   * 0 means rewards are enabled.
   */
  deniedAt: number;
  /** Linked Subgraph metadata when available. */
  // TODO: verify against live schema
  versions?: Array<{ subgraph: SubgraphRef }>;
}

/** Subgraph entity — human-facing wrapper around 1..N deployment versions. */
export interface Subgraph {
  id: string;
  currentVersion?: { id: string; subgraphDeployment: { id: string } } | null;
  versions?: Array<{ id: string; subgraphDeployment: { id: string } }>;
  // TODO: verify against live schema — metadata is offchain-rendered on the
  // gateway and exposed under different shapes across subgraph versions.
  metadata?: {
    displayName?: string | null;
    description?: string | null;
    image?: string | null;
  } | null;
}

export interface SubgraphRef {
  id: string;
  // TODO: verify against live schema
  metadata?: { displayName?: string | null } | null;
}

/**
 * GraphNetwork singleton — global protocol parameters used for APR math.
 *
 * `networkGRTIssuancePerBlock` is the canonical schema field on the live
 * mainnet network subgraph: it is the per-block GRT issuance dedicated to
 * indexing rewards (wei). To convert to an annualized figure, multiply by the
 * number of blocks per year on the host chain (see `blocksPerYear` in
 * `calculate_deployment_apr`). Older subgraph versions exposed
 * `networkGRTIssuance` as an annual amount — the client maps that legacy
 * spelling onto `networkGRTIssuancePerBlock = (legacyAnnual / blocksPerYear)`
 * is *not* attempted here; we read the canonical field directly and surface
 * it raw so reviewers can verify against the live schema.
 *
 * `delegationRatio` is the protocol-wide max delegation multiplier (PPM,
 * 1e6 = 1x). It lives on `GraphNetwork`, not on `Indexer`.
 */
export interface GraphNetwork {
  id: string;
  /** Total GRT in circulation (wei). */
  totalSupply: string;
  /** Sum of stakedTokens across all SubgraphDeployments (wei). */
  totalTokensAllocated: string;
  /** Sum of signalledTokens across all SubgraphDeployments (wei). */
  totalTokensSignalled: string;
  currentEpoch: number;
  /** Epoch length in blocks. */
  epochLength: number;
  /**
   * Per-block GRT issuance dedicated to indexing rewards (wei BigInt string).
   * Canonical schema field name: `networkGRTIssuancePerBlock`.
   */
  networkGRTIssuancePerBlock: string;
  /** Protocol-wide delegation capacity multiplier (PPM, 1e6 = 1x). */
  delegationRatio: number;
}
