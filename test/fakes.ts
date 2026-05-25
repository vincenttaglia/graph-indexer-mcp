/**
 * Lightweight fakes / stubs for the seven service-layer clients. Every fake is
 * intentionally minimal: only the methods the service-under-test actually calls
 * are wired up. Override per-test via shallow-merge.
 */
import type { NetworkSubgraphClient, PaginatedResult } from '../src/clients/network-subgraph.js';
import type { GraphmanClient } from '../src/clients/graphman.js';
import type { GraphNodeClient } from '../src/clients/graph-node.js';
import type { QosSubgraphClient } from '../src/clients/qos-subgraph.js';
import type { EboSubgraphClient } from '../src/clients/ebo-subgraph.js';
import type { IndexerAgentClient } from '../src/clients/indexer-agent.js';
import type { PostgresClient } from '../src/clients/postgres.js';
import type {
  Allocation,
  GraphNetwork,
  Indexer,
  SubgraphDeployment,
} from '../src/types/network.js';
import type { SubgraphIndexingStatus } from '../src/types/graphnode.js';
import type { DeploymentInfo } from '../src/types/graphman.js';
import type {
  DeploymentVolumeRow,
  IndexerQoSRow,
  QueryVolumeRow,
} from '../src/types/qos.js';

export function paged<T>(items: T[], truncated = false): PaginatedResult<T> {
  return { items, truncated };
}

export function indexer(overrides: Partial<Indexer> = {}): Indexer {
  return {
    id: '0x0000000000000000000000000000000000000001',
    stakedTokens: (1_000_000n * 10n ** 18n).toString(),
    allocatedTokens: '0',
    delegatedTokens: '0',
    tokenCapacity: (1_000_000n * 10n ** 18n).toString(),
    indexingRewardCut: 1_000_000,
    queryFeeCut: 1_000_000,
    ...overrides,
  };
}

export function networkParams(overrides: Partial<GraphNetwork> = {}): GraphNetwork {
  return {
    id: '1',
    totalSupply: (10_000_000_000n * 10n ** 18n).toString(),
    totalTokensAllocated: (200_000_000n * 10n ** 18n).toString(),
    totalTokensSignalled: (100_000_000n * 10n ** 18n).toString(),
    currentEpoch: 100,
    epochLength: 6646,
    networkGRTIssuancePerBlock: (3n * 10n ** 18n).toString(),
    delegationRatio: 16,
    ...overrides,
  };
}

export interface DeploymentSpec {
  id: string;
  signal?: bigint;
  staked?: bigint;
  deniedAt?: number;
}

export function deployment(spec: DeploymentSpec): SubgraphDeployment {
  return {
    id: spec.id,
    signalledTokens: (spec.signal ?? 100_000n * 10n ** 18n).toString(),
    stakedTokens: (spec.staked ?? 1_000_000n * 10n ** 18n).toString(),
    indexingRewardAmount: '0',
    queryFeesAmount: '0',
    deniedAt: spec.deniedAt ?? 0,
  };
}

export interface AllocationSpec {
  id: string;
  deploymentId: string;
  indexerId?: string;
  allocatedTokens?: bigint;
  staked?: bigint;
  signal?: bigint;
}

export function allocation(spec: AllocationSpec): Allocation {
  return {
    id: spec.id,
    indexer: {
      id: spec.indexerId ?? '0x0000000000000000000000000000000000000001',
    },
    subgraphDeployment: {
      id: spec.deploymentId,
      signalledTokens: (spec.signal ?? 100_000n * 10n ** 18n).toString(),
      stakedTokens: (spec.staked ?? 500_000n * 10n ** 18n).toString(),
      deniedAt: 0,
    },
    allocatedTokens: (spec.allocatedTokens ?? 50_000n * 10n ** 18n).toString(),
    createdAtEpoch: 99,
    status: 'Active',
  };
}

export function indexingStatus(
  spec: {
    id: string;
    health?: 'healthy' | 'unhealthy' | 'failed';
    synced?: boolean;
    chain?: string;
    latestBlock?: number;
    lastHealthyBlock?: number;
    fatalError?: {
      message: string;
      deterministic: boolean;
      blockNumber?: number;
    };
    entityCount?: string;
  },
): SubgraphIndexingStatus {
  const chains = [
    {
      network: spec.chain ?? 'mainnet',
      latestBlock:
        spec.latestBlock !== undefined
          ? { number: String(spec.latestBlock), hash: '0xabc' }
          : undefined,
      lastHealthyBlock:
        spec.lastHealthyBlock !== undefined
          ? { number: String(spec.lastHealthyBlock), hash: '0xdef' }
          : undefined,
    },
  ];
  const out: SubgraphIndexingStatus = {
    subgraph: spec.id,
    synced: spec.synced ?? true,
    health: spec.health ?? 'healthy',
    nonFatalErrors: [],
    chains,
    entityCount: spec.entityCount ?? '0',
  };
  if (spec.fatalError) {
    out.fatalError = {
      message: spec.fatalError.message,
      deterministic: spec.fatalError.deterministic,
      block:
        spec.fatalError.blockNumber !== undefined
          ? { number: String(spec.fatalError.blockNumber), hash: '0xfff' }
          : undefined,
    };
  }
  return out;
}

export interface FakeNetworkClientOpts {
  indexer?: Indexer | null;
  activeAllocations?: Allocation[];
  signalledDeployments?: SubgraphDeployment[];
  signalledTruncated?: boolean;
  networkParams?: GraphNetwork;
  /** Per-deployment override for getDeployment hydration. */
  deploymentsById?: Record<string, SubgraphDeployment | null>;
  /** Per-deployment override for getDeploymentAllocations. */
  deploymentAllocations?: Record<string, Allocation[]>;
  /** Force getIndexer to throw. */
  throwOnGetIndexer?: Error;
  throwOnGetSignalledDeployments?: Error;
  throwOnGetNetworkParameters?: Error;
  throwOnGetActiveAllocations?: Error;
}

export function fakeNetworkClient(opts: FakeNetworkClientOpts = {}): NetworkSubgraphClient {
  const deploymentsById = opts.deploymentsById ?? {};
  return {
    async getIndexer() {
      if (opts.throwOnGetIndexer) throw opts.throwOnGetIndexer;
      return opts.indexer === undefined ? indexer() : opts.indexer;
    },
    async getActiveAllocations() {
      if (opts.throwOnGetActiveAllocations) throw opts.throwOnGetActiveAllocations;
      return paged(opts.activeAllocations ?? []);
    },
    async getAllocations() {
      return paged(opts.activeAllocations ?? []);
    },
    async getDeployment(id) {
      if (id in deploymentsById) return deploymentsById[id] ?? null;
      return null;
    },
    async getSignalledDeployments() {
      if (opts.throwOnGetSignalledDeployments) throw opts.throwOnGetSignalledDeployments;
      return paged(opts.signalledDeployments ?? [], opts.signalledTruncated ?? false);
    },
    async getNetworkParameters() {
      if (opts.throwOnGetNetworkParameters) throw opts.throwOnGetNetworkParameters;
      return opts.networkParams ?? networkParams();
    },
    async getDeploymentAllocations(id) {
      const items = opts.deploymentAllocations?.[id] ?? [];
      return paged(items);
    },
  };
}

export interface FakeGraphNodeClientOpts {
  statuses?: SubgraphIndexingStatus[];
  /** Override per-deployment via id → status. */
  statusById?: Record<string, SubgraphIndexingStatus | null>;
  entityCountById?: Record<string, string | null>;
  throwOnGetIndexingStatuses?: Error;
  throwOnGetDeploymentHealth?: Error;
}

export function fakeGraphNodeClient(opts: FakeGraphNodeClientOpts = {}): GraphNodeClient {
  return {
    async getIndexingStatuses(ids) {
      if (opts.throwOnGetIndexingStatuses) throw opts.throwOnGetIndexingStatuses;
      if (opts.statuses) {
        if (!ids || ids.length === 0) return opts.statuses;
        return opts.statuses.filter((s) => ids.includes(s.subgraph));
      }
      if (!ids) return [];
      const out: SubgraphIndexingStatus[] = [];
      for (const id of ids) {
        const s = opts.statusById?.[id];
        if (s) out.push(s);
      }
      return out;
    },
    async getDeploymentHealth(id) {
      if (opts.throwOnGetDeploymentHealth) throw opts.throwOnGetDeploymentHealth;
      if (opts.statusById && id in opts.statusById) return opts.statusById[id] ?? null;
      if (opts.statuses) {
        return opts.statuses.find((s) => s.subgraph === id) ?? null;
      }
      return null;
    },
    async getEntityCount(id) {
      if (opts.entityCountById && id in opts.entityCountById) {
        return opts.entityCountById[id] ?? null;
      }
      return null;
    },
  };
}

export interface FakeGraphmanClientOpts {
  infoById?: Record<string, DeploymentInfo>;
  defaultInfo?: DeploymentInfo;
  throwOnGetDeploymentInfo?: Error;
}

export function fakeGraphmanClient(opts: FakeGraphmanClientOpts = {}): GraphmanClient {
  const base: Partial<GraphmanClient> = {
    async getDeploymentInfo(id) {
      if (opts.throwOnGetDeploymentInfo) throw opts.throwOnGetDeploymentInfo;
      if (opts.infoById && id in opts.infoById) return opts.infoById[id]!;
      return opts.defaultInfo ?? { id, paused: false };
    },
  };
  return base as GraphmanClient;
}

export interface FakeQosClientOpts {
  topQueried?: DeploymentVolumeRow[];
  queryVolume?: QueryVolumeRow[];
  indexerQoS?: IndexerQoSRow[];
  throwOnTopQueried?: Error;
  throwOnQueryVolume?: Error;
}

export function fakeQosClient(opts: FakeQosClientOpts = {}): QosSubgraphClient {
  return {
    async getTopQueriedDeployments() {
      if (opts.throwOnTopQueried) throw opts.throwOnTopQueried;
      return opts.topQueried ?? [];
    },
    async getQueryVolume() {
      if (opts.throwOnQueryVolume) throw opts.throwOnQueryVolume;
      return opts.queryVolume ?? [];
    },
    async getIndexerQoS() {
      return opts.indexerQoS ?? [];
    },
  };
}

export interface FakeEboClientOpts {
  epochNumber?: number;
  networkBlocks?: Array<{ network: string; blockNumber: string }>;
  /** keyed by `${epoch}|${chain}` for getEpochBlocks. */
  epochBlocks?: Record<string, { network: string; epochNumber: number; blockNumber: string } | null>;
}

export function fakeEboClient(opts: FakeEboClientOpts = {}): EboSubgraphClient {
  return {
    async getCurrentEpoch() {
      return {
        epochNumber: opts.epochNumber ?? 100,
        networkBlocks: opts.networkBlocks ?? [
          { network: 'arbitrum-one', blockNumber: '1000' },
          { network: 'mainnet', blockNumber: '500' },
        ],
      };
    },
    async getEpochBlocks(epoch, chain) {
      const k = `${epoch}|${chain}`;
      if (opts.epochBlocks && k in opts.epochBlocks) return opts.epochBlocks[k] ?? null;
      // Default: synthesize one matching the chain's start block from current
      // epoch info so classify() can find an epochStartBlock.
      const match = opts.networkBlocks?.find((r) => r.network === chain);
      if (match) {
        return { network: chain, epochNumber: epoch, blockNumber: match.blockNumber };
      }
      return null;
    },
    async getNetworkEpochs() {
      return [];
    },
  };
}

export function fakeAgentClient(): IndexerAgentClient {
  return {
    async getActionQueue() {
      return [];
    },
    async queueActions() {
      return [];
    },
    async approveActions() {
      return [];
    },
    async cancelActions() {
      return [];
    },
    async getIndexingRules() {
      return [];
    },
    async setIndexingRule(rule) {
      return rule as never;
    },
    async setCostModel(model) {
      return model as never;
    },
  };
}

export interface FakePostgresClientOpts {
  sizes?: Array<{ deploymentId: string; namespace: string; sizeBytes: string }>;
  throwOnGetAllSubgraphSizes?: Error;
}

export function fakePostgresClient(opts: FakePostgresClientOpts = {}): PostgresClient {
  return {
    async getDeploymentNamespace() {
      return null;
    },
    async getSubgraphSize() {
      return null;
    },
    async getAllSubgraphSizes() {
      if (opts.throwOnGetAllSubgraphSizes) throw opts.throwOnGetAllSubgraphSizes;
      return opts.sizes ?? [];
    },
    async close() {
      // noop
    },
  };
}
