/**
 * Lightweight fakes / stubs for the seven service-layer clients. Every fake is
 * intentionally minimal: only the methods the service-under-test actually calls
 * are wired up. Override per-test via shallow-merge.
 */
import type { NetworkSubgraphClient, PaginatedResult } from '../src/clients/network-subgraph.js';
import type { GraphmanClient, GraphmanMutationAck } from '../src/clients/graphman.js';
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
import type { DeploymentInfo, GraphmanCliResult } from '../src/types/graphman.js';
import type { CostModel, IndexingRule } from '../src/types/agent.js';
import type {
  DeploymentVolumeRow,
  IndexerQoSRow,
  QueryVolumeRow,
} from '../src/types/qos.js';

export function paged<T>(items: T[], truncated = false): PaginatedResult<T> {
  return { items, truncated };
}

export function indexer(overrides: Partial<Indexer> = {}): Indexer {
  // Default tokenCapacity to (stakedTokens + delegatedTokens) when the
  // caller doesn't explicitly override it. This mirrors the protocol
  // semantics — tokenCapacity = self + capped delegation — and ensures
  // tests that only override `stakedTokens` still produce a consistent
  // budget (otherwise capacity would stay at 1M while staked drops to e.g.
  // 100k, inflating the optimizer's per-deployment cap by 10×).
  const staked = overrides.stakedTokens ?? (1_000_000n * 10n ** 18n).toString();
  const delegated = overrides.delegatedTokens ?? '0';
  const defaultCapacity = (BigInt(staked) + BigInt(delegated)).toString();
  return {
    id: '0x0000000000000000000000000000000000000001',
    stakedTokens: staked,
    allocatedTokens: '0',
    delegatedTokens: delegated,
    tokenCapacity: defaultCapacity,
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
    /**
     * Pause state as graph-node would report it. Defaults to `false` so
     * existing fixtures keep behaving like "healthy, synced, unpaused".
     */
    paused?: boolean;
    /**
     * Index-node assignment as graph-node would report it. Defaults to
     * `'default'` — i.e. assigned. Pass `null` to simulate an unassigned
     * deployment (used by the new orphaned-classification tests).
     */
    node?: string | null;
    /** Block-history retention setting; mirrors graph-node's optional field. */
    historyBlocks?: number | null;
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
    paused: spec.paused ?? false,
    node: spec.node === undefined ? 'default' : spec.node,
    historyBlocks: spec.historyBlocks ?? null,
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
  /** Per-allocation override for getAllocationById. */
  allocationsById?: Record<string, Allocation | null>;
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
    async getAllocationById(id) {
      const allocationsById = opts.allocationsById ?? {};
      if (id in allocationsById) return allocationsById[id] ?? null;
      // Fall back to scanning activeAllocations for callers that haven't
      // populated allocationsById explicitly.
      return (
        (opts.activeAllocations ?? []).find(
          (a) => a.id.toLowerCase() === id.toLowerCase(),
        ) ?? null
      );
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
  // Default CLI result returned by every no-op CLI stub. Keeping a single
  // shape here lets a single regression in `GraphmanCliResult` flag every
  // call site at typecheck time, instead of being masked by a `Partial`
  // cast (the Stage 4 audit, Finding 4).
  const cliOk = (command: string[]): GraphmanCliResult => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    command,
  });
  const ack: GraphmanMutationAck = { success: true };
  return {
    // ---- GraphQL ----
    async getDeploymentInfo(id) {
      if (opts.throwOnGetDeploymentInfo) throw opts.throwOnGetDeploymentInfo;
      if (opts.infoById && id in opts.infoById) return opts.infoById[id]!;
      return opts.defaultInfo ?? { id, paused: false };
    },
    async pauseDeployment(_id) {
      return ack;
    },
    async resumeDeployment(_id) {
      return ack;
    },
    async restartDeployment(_id) {
      return { executionId: 'fake-exec-id' };
    },
    async getExecutionStatus(id) {
      return { id, state: 'SUCCEEDED' };
    },
    // ---- CLI fallback ----
    async rewindDeployment(id, blockNumber, blockHash) {
      return cliOk(['graphman', 'rewind', id, String(blockNumber), blockHash]);
    },
    async reassignDeployment(id, targetNode) {
      return cliOk(['graphman', 'reassign', id, targetNode]);
    },
    async unassignDeployment(id) {
      return cliOk(['graphman', 'unassign', id]);
    },
    async dropDeployment(id) {
      return cliOk(['graphman', 'drop', id]);
    },
    async unusedRecord() {
      return cliOk(['graphman', 'unused', 'record']);
    },
    async unusedRemove() {
      return cliOk(['graphman', 'unused', 'remove']);
    },
    async checkBlocks(args) {
      return cliOk(['graphman', 'check-blocks', args.chain]);
    },
    async truncateChainCache(chain) {
      return cliOk(['graphman', 'chain', 'truncate', chain]);
    },
    async clearCallCache(args) {
      return cliOk(['graphman', 'chain', 'clear-call-cache', args.chain]);
    },
  };
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

/**
 * Per-network start-block row for the fake. Mirrors the real client's
 * `EpochNetworkStartBlock` shape — `chainId` is the EVM chain id, `network`
 * is the human-readable alias (`Network.alias` in EBO). All BigInt-scale
 * values are stringified to match the real client's JSON-serializable
 * surface.
 */
export interface FakeEboNetworkBlock {
  network: string;
  chainId: string;
  blockNumber: string;
  acceleration: string;
  delta: string;
}

/**
 * Default per-network start blocks for the fake. Includes `arbitrum-one`
 * (the protocol chain) so HealthMonitor's chain inference resolves
 * deterministically without per-test overrides.
 */
const DEFAULT_BLOCKS: FakeEboNetworkBlock[] = [
  {
    network: 'arbitrum-one',
    chainId: '42161',
    blockNumber: '1000',
    acceleration: '0',
    delta: '0',
  },
  {
    network: 'mainnet',
    chainId: '1',
    blockNumber: '500',
    acceleration: '0',
    delta: '0',
  },
];

export interface FakeEboClientOpts {
  epoch?: number;
  /**
   * Per-network start-block rows. Partial rows are accepted — missing
   * `chainId` / `acceleration` / `delta` default to safe stub values so
   * existing call sites that only care about `network` + `blockNumber`
   * don't have to spell out the full shape.
   */
  blockNumbersByNetwork?: Array<Partial<FakeEboNetworkBlock> & { network: string; blockNumber: string }>;
  /** keyed by `${epoch}|${chain}` for getEpochBlocks. */
  epochBlocks?: Record<
    string,
    { network: string; chainId: string; epochNumber: number; blockNumber: string } | null
  >;
}

export function fakeEboClient(opts: FakeEboClientOpts = {}): EboSubgraphClient {
  const blockNumbersByNetwork: FakeEboNetworkBlock[] = opts.blockNumbersByNetwork
    ? opts.blockNumbersByNetwork.map((row) => ({
        network: row.network,
        chainId: row.chainId ?? '0',
        blockNumber: row.blockNumber,
        acceleration: row.acceleration ?? '0',
        delta: row.delta ?? '0',
      }))
    : DEFAULT_BLOCKS;
  return {
    async getCurrentEpoch() {
      return {
        epoch: opts.epoch ?? 100,
        blockNumbersByNetwork,
      };
    },
    async getEpochBlocks(epoch, chain) {
      const k = `${epoch}|${chain}`;
      if (opts.epochBlocks && k in opts.epochBlocks) return opts.epochBlocks[k] ?? null;
      // Default: synthesize one matching the chain's start block from current
      // epoch info so classify() can find an epochStartBlock.
      const match = blockNumbersByNetwork.find((r) => r.network === chain);
      if (match) {
        return {
          network: chain,
          chainId: match.chainId,
          epochNumber: epoch,
          blockNumber: match.blockNumber,
        };
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
    // Echo the request back as a fully-shaped IndexingRule with safe defaults
    // for the fields the caller may not have supplied. No `as` cast — if the
    // IndexingRule shape changes, this fake will fail typecheck and the
    // mismatch surfaces here instead of being silently masked (Finding 4).
    async setIndexingRule(rule) {
      const out: IndexingRule = {
        identifier: rule.identifier,
        identifierType: rule.identifierType ?? 'deployment',
        decisionBasis: rule.decisionBasis ?? 'rules',
        // Required by the agent's schema (IndexingRule.protocolNetwork is
        // `String!`); echo whatever the caller supplied so tests can assert
        // on the tool's protocolNetwork-injection contract.
        protocolNetwork: rule.protocolNetwork ?? 'arbitrum-one',
      };
      if (rule.allocationAmount !== undefined) out.allocationAmount = rule.allocationAmount;
      if (rule.allocationLifetime !== undefined) out.allocationLifetime = rule.allocationLifetime;
      if (rule.autoRenewal !== undefined) out.autoRenewal = rule.autoRenewal;
      if (rule.requireSupported !== undefined) out.requireSupported = rule.requireSupported;
      if (rule.safety !== undefined) out.safety = rule.safety;
      if (rule.custom !== undefined) out.custom = rule.custom;
      return out;
    },
    async setCostModel(model) {
      // The agent's CostModelInput accepts only { deployment, model }.
      // The returned CostModel can still carry a `variables` field
      // (it's an output-only attribute the agent derives), but we leave
      // it unset here unless a test future-extends this fake.
      const out: CostModel = {
        deployment: model.deployment,
        model: model.model,
      };
      return out;
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
