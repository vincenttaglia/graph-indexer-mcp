import type { TypedGraphqlClient } from '../utils/graphql-client.js';
import { TtlCache } from '../utils/cache.js';
import { toQmDeploymentId } from '../utils/ipfs.js';
import type {
  CheckBlockOutcomeKind,
  CheckBlocksResponse,
  CheckBlocksResult,
  ClearCallCacheResponse,
  DeploymentInfo,
  DropResult,
  ExecutionStatus,
  ReassignResult,
} from '../types/graphman.js';

// =============================================================================
// GraphQL operation strings
// =============================================================================
//
// These are written against the graph-node `graphman-api-expand` graphman
// GraphQL schema. async-graphql converts snake_case Rust fields/args to
// lowerCamelCase. `ExecutionId`, `BlockHash` and `BlockNumber` are custom
// SCALARS that serialize as strings — a field returning `ExecutionId` is
// selected with NO sub-selection. Unions are decoded with inline fragments.
//
// Deployments are addressed via the `DeploymentSelector` input `{ hash: "Qm…" }`.

const DEPLOYMENT_INFO_QUERY = /* GraphQL */ `
  query DeploymentInfo($hash: String!) {
    deployment {
      info(deployment: { hash: $hash }) {
        hash
        shard
        chain
        nodeId
        health: versionStatus
        status {
          isPaused
          health
          latestBlock {
            number
          }
        }
      }
    }
  }
`;

const EXECUTION_INFO_QUERY = /* GraphQL */ `
  query ExecutionInfo($id: ExecutionId!) {
    execution {
      info(id: $id) {
        id
        status
        errorMessage
      }
    }
  }
`;

const PAUSE_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation PauseDeployment($hash: String!) {
    deployment {
      pause(deployment: { hash: $hash }) {
        success
      }
    }
  }
`;

const RESUME_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation ResumeDeployment($hash: String!) {
    deployment {
      resume(deployment: { hash: $hash }) {
        success
      }
    }
  }
`;

// `restart` returns a bare `ExecutionId` scalar — NO sub-selection.
const RESTART_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation RestartDeployment($hash: String!) {
    deployment {
      restart(deployment: { hash: $hash })
    }
  }
`;

// `rewind` returns a bare `ExecutionId` scalar (ASYNC).
const REWIND_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation RewindDeployment(
    $hash: String!
    $startBlock: Boolean
    $blockHash: BlockHash
    $blockNumber: BlockNumber
    $force: Boolean
    $delaySeconds: Int
  ) {
    deployment {
      rewind(
        deployments: [{ hash: $hash }]
        startBlock: $startBlock
        blockHash: $blockHash
        blockNumber: $blockNumber
        force: $force
        delaySeconds: $delaySeconds
      )
    }
  }
`;

// `deleteDeployment` returns `[String!]` (locator strings) — NO sub-selection.
const DELETE_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation DeleteDeployment($hash: String!, $all: Boolean) {
    deployment {
      deleteDeployment(deployment: { hash: $hash }, all: $all)
    }
  }
`;

// `reassign` returns the `ReassignResponse` union.
const REASSIGN_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation ReassignDeployment($hash: String!, $node: String!) {
    deployment {
      reassign(deployment: { hash: $hash }, node: $node) {
        __typename
        ... on EmptyResponse {
          success
        }
        ... on CompletedWithWarnings {
          success
          warnings
        }
      }
    }
  }
`;

const UNASSIGN_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation UnassignDeployment($hash: String!) {
    deployment {
      unassign(deployment: { hash: $hash }) {
        success
      }
    }
  }
`;

// `checkBlocks` returns the `CheckBlocksResponse` union. The `byRange` method
// runs async and returns `CheckBlocksExecution { id }` (a bare `ExecutionId`
// scalar field); the others return `CheckBlocksResult`.
const CHECK_BLOCKS_MUTATION = /* GraphQL */ `
  mutation CheckBlocks($chain: String!, $method: CheckBlocksMethod!) {
    chain {
      checkBlocks(chain: $chain, method: $method) {
        __typename
        ... on CheckBlocksResult {
          diverged
          blocks {
            number
            outcome
            hashes
            diff
          }
        }
        ... on CheckBlocksExecution {
          id
        }
      }
    }
  }
`;

const TRUNCATE_CHAIN_CACHE_MUTATION = /* GraphQL */ `
  mutation TruncateChainCache($chain: String!) {
    chain {
      truncateChainCache(chain: $chain) {
        success
      }
    }
  }
`;

// `clearCallCache` returns the `ClearCallCacheResponse` union.
const CLEAR_CALL_CACHE_MUTATION = /* GraphQL */ `
  mutation ClearCallCache(
    $chain: String!
    $from: BlockNumber
    $to: BlockNumber
    $removeEntireCache: Boolean
    $ttlDays: Int
    $maxContracts: Int
  ) {
    chain {
      clearCallCache(
        chain: $chain
        from: $from
        to: $to
        removeEntireCache: $removeEntireCache
        ttlDays: $ttlDays
        maxContracts: $maxContracts
      ) {
        __typename
        ... on EmptyResponse {
          success
        }
        ... on StaleCallCacheResponse {
          effectiveTtlDays
          cacheEntriesDeleted
          contractsDeleted
        }
      }
    }
  }
`;

// =============================================================================
// Response shapes (defensive — we accept partial objects)
// =============================================================================

interface RawDeploymentInfo {
  hash?: string;
  shard?: string;
  chain?: string;
  nodeId?: string | null;
  health?: string;
  status?: {
    isPaused?: boolean | null;
    health?: string;
    latestBlock?: { number?: string } | null;
  } | null;
}

interface DeploymentInfoResponse {
  deployment?: {
    info?: RawDeploymentInfo[];
  };
}

interface ExecutionInfoResponse {
  execution?: {
    info?: {
      id?: string;
      status?: string;
      errorMessage?: string | null;
    };
  };
}

interface MutationAck {
  success?: boolean;
}

interface PauseResponse {
  deployment?: { pause?: MutationAck };
}
interface ResumeResponse {
  deployment?: { resume?: MutationAck };
}
interface RestartResponse {
  deployment?: { restart?: string };
}
interface RewindResponse {
  deployment?: { rewind?: string };
}
interface DeleteResponse {
  deployment?: { deleteDeployment?: string[] };
}
interface ReassignResponse {
  deployment?: {
    reassign?: {
      __typename?: string;
      success?: boolean;
      warnings?: string[];
    };
  };
}
interface UnassignResponse {
  deployment?: { unassign?: MutationAck };
}
interface CheckBlocksResponseRaw {
  chain?: {
    checkBlocks?: {
      __typename?: string;
      diverged?: number;
      blocks?: Array<{
        number?: number | null;
        outcome?: string;
        hashes?: string[];
        diff?: string | null;
      }>;
      id?: string;
    };
  };
}
interface TruncateResponse {
  chain?: { truncateChainCache?: MutationAck };
}
interface ClearCallCacheResponseRaw {
  chain?: {
    clearCallCache?: {
      __typename?: string;
      success?: boolean;
      effectiveTtlDays?: number;
      cacheEntriesDeleted?: number;
      contractsDeleted?: number;
    };
  };
}

// =============================================================================
// Client options & interface
// =============================================================================

export interface GraphmanClientOptions {
  /** GraphQL client pointed at the graphman API (port 8050). */
  gql: TypedGraphqlClient;
}

export interface GraphmanMutationAck {
  success: boolean;
  message?: string;
}

export interface GraphmanRestartResult {
  executionId: string;
}

/** Arguments for `rewindDeployment`. Either `startBlock`, or both hash+number. */
export interface RewindArgs {
  /** Rewind to the deployment's own start block (truncate). */
  startBlock?: boolean;
  /** Target block hash (hex). Required unless `startBlock`. */
  blockHash?: string;
  /** Target block number. Required unless `startBlock`. */
  blockNumber?: number;
  /** Rewind even if the target block hash is missing from the block cache. */
  force?: boolean;
  /** Seconds to wait after pausing before rewinding. */
  delaySeconds?: number;
}

/** One of the three mutually-exclusive `checkBlocks` methods. */
export interface CheckBlocksArgs {
  chain: string;
  byHash?: string;
  byNumber?: { number: number; deleteDuplicates?: boolean };
  byRange?: { from?: number; to?: number; deleteDuplicates?: boolean };
}

/** One of the three mutually-exclusive `clearCallCache` modes. */
export interface ClearCallCacheArgs {
  chain: string;
  from?: number;
  to?: number;
  removeEntireCache?: boolean;
  ttlDays?: number;
  maxContracts?: number;
}

/**
 * Optional per-call options for graphman methods. `signal` is forwarded to the
 * underlying GraphQL request so caller-initiated cancellation aborts the
 * in-flight HTTP request.
 */
export interface GraphmanCallOpts {
  signal?: AbortSignal;
}

export interface GraphmanClient {
  // ---- deployment queries / lifecycle ----
  getDeploymentInfo(deploymentId: string, opts?: GraphmanCallOpts): Promise<DeploymentInfo>;
  pauseDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanMutationAck>;
  resumeDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanMutationAck>;
  restartDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanRestartResult>;
  getExecutionStatus(executionId: string, opts?: GraphmanCallOpts): Promise<ExecutionStatus>;

  // ---- deployment mutations ----
  rewindDeployment(
    deploymentId: string,
    args: RewindArgs,
    opts?: GraphmanCallOpts,
  ): Promise<GraphmanRestartResult>;
  dropDeployment(
    deploymentId: string,
    all: boolean,
    opts?: GraphmanCallOpts,
  ): Promise<DropResult>;
  reassignDeployment(
    deploymentId: string,
    node: string,
    opts?: GraphmanCallOpts,
  ): Promise<ReassignResult>;
  unassignDeployment(
    deploymentId: string,
    opts?: GraphmanCallOpts,
  ): Promise<GraphmanMutationAck>;

  // ---- chain mutations ----
  checkBlocks(args: CheckBlocksArgs, opts?: GraphmanCallOpts): Promise<CheckBlocksResponse>;
  truncateChainCache(chain: string, opts?: GraphmanCallOpts): Promise<GraphmanMutationAck>;
  clearCallCache(
    args: ClearCallCacheArgs,
    opts?: GraphmanCallOpts,
  ): Promise<ClearCallCacheResponse>;
}

// =============================================================================
// Implementation
// =============================================================================

function normalizeExecutionState(raw: string | undefined): ExecutionStatus['state'] {
  const upper = (raw ?? '').toUpperCase();
  // graph-node's ExecutionStatus enum is Initializing | Running | Failed |
  // Succeeded. Treat INITIALIZING as RUNNING (still in-flight) so callers keep
  // polling; surface anything else as an error rather than silently coercing.
  if (upper === 'INITIALIZING' || upper === 'RUNNING') return 'RUNNING';
  if (upper === 'SUCCEEDED' || upper === 'FAILED') return upper;
  throw new Error(
    `graphman returned unknown execution state ${JSON.stringify(raw)}; ` +
      `expected one of INITIALIZING | RUNNING | SUCCEEDED | FAILED`,
  );
}

const CHECK_BLOCK_OUTCOMES: readonly CheckBlockOutcomeKind[] = [
  'Matched',
  'Diverged',
  'NotFound',
  'DuplicatesDeleted',
  'DuplicatesSkipped',
];

function normalizeOutcome(raw: string | undefined): CheckBlockOutcomeKind {
  // The GraphQL enum serializes as SCREAMING_SNAKE_CASE; map back to our
  // PascalCase variants by case-insensitive match.
  const found = CHECK_BLOCK_OUTCOMES.find(
    (o) => o.toUpperCase() === (raw ?? '').toUpperCase().replace(/_/g, ''),
  );
  if (!found) {
    throw new Error(
      `graphman checkBlocks returned unknown outcome ${JSON.stringify(raw)}`,
    );
  }
  return found;
}

export function createGraphmanClient(opts: GraphmanClientOptions): GraphmanClient {
  const { gql } = opts;

  // Per design §4.1.2: deployment info cached for 5 minutes. Mutations
  // (pause/resume/restart/rewind/drop/reassign/unassign) MUST invalidate
  // the corresponding entry on success — otherwise stale "paused: false"
  // reads can mislead the optimizer for up to 5 minutes after a pause.
  const deploymentInfoCache = new TtlCache<string, DeploymentInfo>({
    ttlMs: 300_000,
    label: 'graphman',
  });

  function invalidateDeployment(deploymentId: string, reason: string): void {
    const key = deploymentId.toLowerCase();
    deploymentInfoCache.invalidate(key);
    process.stderr.write(`[cache graphman ${key}] invalidate (after ${reason})\n`);
  }

  function sig(callOpts?: GraphmanCallOpts): { signal: AbortSignal } | undefined {
    return callOpts?.signal ? { signal: callOpts.signal } : undefined;
  }

  return {
    // -------------------------------------------------------------------------
    // Deployment queries / lifecycle
    // -------------------------------------------------------------------------

    async getDeploymentInfo(deploymentId, callOpts): Promise<DeploymentInfo> {
      const qm = toQmDeploymentId(deploymentId);
      const key = qm.toLowerCase();
      return deploymentInfoCache.getOrFetch(
        key,
        async (fetchOpts) => {
          const data = await gql.request<DeploymentInfoResponse>(
            DEPLOYMENT_INFO_QUERY,
            { hash: qm },
            fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
          );
          // `deployment.info` returns a LIST; a `hash` selector yields one row
          // (or none if the deployment is unknown to this graph-node).
          const info = data.deployment?.info?.[0];
          if (!info || typeof info.hash !== 'string') {
            throw new Error(
              `graphman deployment.info returned no record for "${deploymentId}"`,
            );
          }
          const result: DeploymentInfo = {
            id: info.hash,
            paused: Boolean(info.status?.isPaused),
          };
          if (info.shard !== undefined) result.shard = info.shard;
          if (info.chain !== undefined) result.chain = info.chain;
          if (info.nodeId != null) result.node = info.nodeId;
          const latest = info.status?.latestBlock?.number;
          if (latest !== undefined && latest !== null) {
            result.latestBlock = Number(latest);
          }
          // Prefer the live sync health from `status` (HEALTHY/UNHEALTHY/FAILED)
          // over the version status when present.
          const health = info.status?.health ?? info.health;
          if (health !== undefined) result.health = health;
          return result;
        },
        callOpts?.signal ? { signal: callOpts.signal, keyLabel: key } : { keyLabel: key },
      );
    },

    async pauseDeployment(deploymentId, callOpts): Promise<GraphmanMutationAck> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<PauseResponse>(
        PAUSE_DEPLOYMENT_MUTATION,
        { hash: qm },
        sig(callOpts),
      );
      const ack = data.deployment?.pause;
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (result.success) invalidateDeployment(qm, 'pauseDeployment');
      return result;
    },

    async resumeDeployment(deploymentId, callOpts): Promise<GraphmanMutationAck> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<ResumeResponse>(
        RESUME_DEPLOYMENT_MUTATION,
        { hash: qm },
        sig(callOpts),
      );
      const ack = data.deployment?.resume;
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (result.success) invalidateDeployment(qm, 'resumeDeployment');
      return result;
    },

    async restartDeployment(deploymentId, callOpts): Promise<GraphmanRestartResult> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<RestartResponse>(
        RESTART_DEPLOYMENT_MUTATION,
        { hash: qm },
        sig(callOpts),
      );
      const executionId = data.deployment?.restart;
      if (!executionId) {
        throw new Error(
          `graphman deployment.restart returned no executionId for "${deploymentId}"`,
        );
      }
      invalidateDeployment(qm, 'restartDeployment');
      return { executionId };
    },

    async getExecutionStatus(executionId, callOpts): Promise<ExecutionStatus> {
      const data = await gql.request<ExecutionInfoResponse>(
        EXECUTION_INFO_QUERY,
        { id: executionId },
        sig(callOpts),
      );
      const info = data.execution?.info;
      if (!info || typeof info.id !== 'string') {
        throw new Error(
          `graphman execution.info returned no record for "${executionId}"`,
        );
      }
      const result: ExecutionStatus = {
        id: info.id,
        state: normalizeExecutionState(info.status),
      };
      if (info.errorMessage) result.error = info.errorMessage;
      return result;
    },

    // -------------------------------------------------------------------------
    // Deployment mutations
    // -------------------------------------------------------------------------

    async rewindDeployment(deploymentId, args, callOpts): Promise<GraphmanRestartResult> {
      const qm = toQmDeploymentId(deploymentId);
      const variables: {
        hash: string;
        startBlock?: boolean;
        blockHash?: string;
        blockNumber?: string;
        force?: boolean;
        delaySeconds?: number;
      } = { hash: qm };
      if (args.startBlock !== undefined) variables.startBlock = args.startBlock;
      if (args.blockHash !== undefined) variables.blockHash = args.blockHash;
      // BlockNumber is a String-serialized scalar on the wire.
      if (args.blockNumber !== undefined) variables.blockNumber = String(args.blockNumber);
      if (args.force !== undefined) variables.force = args.force;
      if (args.delaySeconds !== undefined) variables.delaySeconds = args.delaySeconds;

      const data = await gql.request<RewindResponse>(
        REWIND_DEPLOYMENT_MUTATION,
        variables,
        sig(callOpts),
      );
      const executionId = data.deployment?.rewind;
      if (!executionId) {
        throw new Error(
          `graphman deployment.rewind returned no executionId for "${deploymentId}"`,
        );
      }
      invalidateDeployment(qm, 'rewindDeployment');
      return { executionId };
    },

    async dropDeployment(deploymentId, all, callOpts): Promise<DropResult> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<DeleteResponse>(
        DELETE_DEPLOYMENT_MUTATION,
        { hash: qm, all },
        sig(callOpts),
      );
      const deletedLocators = data.deployment?.deleteDeployment ?? [];
      invalidateDeployment(qm, 'dropDeployment');
      return { deletedLocators };
    },

    async reassignDeployment(deploymentId, node, callOpts): Promise<ReassignResult> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<ReassignResponse>(
        REASSIGN_DEPLOYMENT_MUTATION,
        { hash: qm, node },
        sig(callOpts),
      );
      const raw = data.deployment?.reassign;
      const result: ReassignResult = { success: raw?.success ?? true };
      if (raw?.warnings && raw.warnings.length > 0) result.warnings = raw.warnings;
      invalidateDeployment(qm, 'reassignDeployment');
      return result;
    },

    async unassignDeployment(deploymentId, callOpts): Promise<GraphmanMutationAck> {
      const qm = toQmDeploymentId(deploymentId);
      const data = await gql.request<UnassignResponse>(
        UNASSIGN_DEPLOYMENT_MUTATION,
        { hash: qm },
        sig(callOpts),
      );
      const ack = data.deployment?.unassign;
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (result.success) invalidateDeployment(qm, 'unassignDeployment');
      return result;
    },

    // -------------------------------------------------------------------------
    // Chain mutations
    // -------------------------------------------------------------------------

    async checkBlocks(args, callOpts): Promise<CheckBlocksResponse> {
      // Build the `CheckBlocksMethod` input with exactly one variant populated.
      // BlockNumber values go on the wire as strings.
      const method: {
        byHash?: string;
        byNumber?: { number: string; deleteDuplicates?: boolean };
        byRange?: { from?: string; to?: string; deleteDuplicates?: boolean };
      } = {};
      if (args.byHash !== undefined) {
        method.byHash = args.byHash;
      } else if (args.byNumber !== undefined) {
        method.byNumber = { number: String(args.byNumber.number) };
        if (args.byNumber.deleteDuplicates !== undefined) {
          method.byNumber.deleteDuplicates = args.byNumber.deleteDuplicates;
        }
      } else if (args.byRange !== undefined) {
        method.byRange = {};
        if (args.byRange.from !== undefined) method.byRange.from = String(args.byRange.from);
        if (args.byRange.to !== undefined) method.byRange.to = String(args.byRange.to);
        if (args.byRange.deleteDuplicates !== undefined) {
          method.byRange.deleteDuplicates = args.byRange.deleteDuplicates;
        }
      }

      const data = await gql.request<CheckBlocksResponseRaw>(
        CHECK_BLOCKS_MUTATION,
        { chain: args.chain, method },
        sig(callOpts),
      );
      const raw = data.chain?.checkBlocks;
      if (!raw) {
        throw new Error('graphman chain.checkBlocks returned no response');
      }
      if (raw.__typename === 'CheckBlocksExecution') {
        if (!raw.id) {
          throw new Error('graphman checkBlocks (byRange) returned no execution id');
        }
        return { kind: 'execution', executionId: raw.id };
      }
      const result: CheckBlocksResult = {
        diverged: raw.diverged ?? 0,
        blocks: (raw.blocks ?? []).map((b) => {
          const out: CheckBlocksResult['blocks'][number] = {
            outcome: normalizeOutcome(b.outcome),
            hashes: b.hashes ?? [],
          };
          if (b.number !== undefined && b.number !== null) out.number = b.number;
          if (b.diff != null) out.diff = b.diff;
          return out;
        }),
      };
      return { kind: 'result', result };
    },

    async truncateChainCache(chain, callOpts): Promise<GraphmanMutationAck> {
      const data = await gql.request<TruncateResponse>(
        TRUNCATE_CHAIN_CACHE_MUTATION,
        { chain },
        sig(callOpts),
      );
      const ack = data.chain?.truncateChainCache;
      return { success: ack?.success ?? true };
    },

    async clearCallCache(args, callOpts): Promise<ClearCallCacheResponse> {
      const variables: {
        chain: string;
        from?: string;
        to?: string;
        removeEntireCache?: boolean;
        ttlDays?: number;
        maxContracts?: number;
      } = { chain: args.chain };
      // BlockNumber values go on the wire as strings.
      if (args.from !== undefined) variables.from = String(args.from);
      if (args.to !== undefined) variables.to = String(args.to);
      if (args.removeEntireCache !== undefined) {
        variables.removeEntireCache = args.removeEntireCache;
      }
      if (args.ttlDays !== undefined) variables.ttlDays = args.ttlDays;
      if (args.maxContracts !== undefined) variables.maxContracts = args.maxContracts;

      const data = await gql.request<ClearCallCacheResponseRaw>(
        CLEAR_CALL_CACHE_MUTATION,
        variables,
        sig(callOpts),
      );
      const raw = data.chain?.clearCallCache;
      if (!raw) {
        throw new Error('graphman chain.clearCallCache returned no response');
      }
      if (raw.__typename === 'StaleCallCacheResponse') {
        return {
          kind: 'stale',
          stats: {
            effectiveTtlDays: raw.effectiveTtlDays ?? 0,
            cacheEntriesDeleted: raw.cacheEntriesDeleted ?? 0,
            contractsDeleted: raw.contractsDeleted ?? 0,
          },
        };
      }
      return { kind: 'empty', success: raw.success ?? true };
    },
  };
}
