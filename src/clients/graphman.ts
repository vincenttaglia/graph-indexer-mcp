import type { TypedGraphqlClient } from '../utils/graphql-client.js';
import { TtlCache } from '../utils/cache.js';
import {
  execGraphman,
  type KubectlContext,
  type KubectlExecOptions,
} from '../utils/kubectl.js';
import type {
  DeploymentInfo,
  ExecutionStatus,
  GraphmanCliResult,
} from '../types/graphman.js';

// =============================================================================
// GraphQL operation strings
// =============================================================================
//
// These mirror the operations documented in design §2.6:
//   deployment.info(deployment)
//   deployment.pause(deployment)
//   deployment.resume(deployment)
//   deployment.restart(deployment)
//   execution.info(id)
//
// Deployments are addressed by IPFS hash via `{ hash: "Qm..." }` per the
// design doc. The exact field names on the response objects are best-effort;
// the live schema may differ across graph-node versions.
//
// TODO: verify against live graphman schema (response field names, mutation
// payload shapes, whether mutations return `success` booleans or just the
// updated entity).

const DEPLOYMENT_INFO_QUERY = /* GraphQL */ `
  query DeploymentInfo($hash: String!) {
    deployment {
      info(deployment: { hash: $hash }) {
        id
        paused
        shard
        chain
        node
        latestBlock
        health
      }
    }
  }
`;

const EXECUTION_INFO_QUERY = /* GraphQL */ `
  query ExecutionInfo($id: String!) {
    execution {
      info(id: $id) {
        id
        state
        error
      }
    }
  }
`;

const PAUSE_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation PauseDeployment($hash: String!) {
    deployment {
      pause(deployment: { hash: $hash }) {
        success
        message
      }
    }
  }
`;

const RESUME_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation ResumeDeployment($hash: String!) {
    deployment {
      resume(deployment: { hash: $hash }) {
        success
        message
      }
    }
  }
`;

const RESTART_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation RestartDeployment($hash: String!) {
    deployment {
      restart(deployment: { hash: $hash }) {
        executionId
      }
    }
  }
`;

// =============================================================================
// Response shapes (defensive — we accept partial objects)
// =============================================================================

interface DeploymentInfoResponse {
  deployment?: {
    info?: Partial<DeploymentInfo> & { id?: string; paused?: boolean };
  };
}

interface ExecutionInfoResponse {
  execution?: {
    info?: {
      id?: string;
      state?: string;
      error?: string | null;
    };
  };
}

interface MutationAck {
  success?: boolean;
  message?: string | null;
}

interface PauseResponse {
  deployment?: { pause?: MutationAck };
}
interface ResumeResponse {
  deployment?: { resume?: MutationAck };
}
interface RestartResponse {
  deployment?: { restart?: { executionId?: string } };
}

// =============================================================================
// Client options & interface
// =============================================================================

export interface GraphmanClientOptions {
  /** GraphQL client pointed at the graphman API (port 8050). */
  gql: TypedGraphqlClient;
  /** kubectl context used for CLI fallback (namespace + pod label). */
  kubectl: KubectlContext;
  /** Path to graph-node config.toml, passed to graphman as `--config`. */
  configPath: string;
  /** Default per-call timeout for CLI fallback. */
  cliTimeoutMs?: number;
}

export interface GraphmanMutationAck {
  success: boolean;
  message?: string;
}

export interface GraphmanRestartResult {
  executionId: string;
}

export interface CheckBlocksArgs {
  chain: string;
  blockNumber?: number;
  from?: number;
  to?: number;
}

export interface ClearCallCacheArgs {
  chain: string;
  from?: number;
  to?: number;
  removeAll?: boolean;
}

export interface UnusedRemoveOpts {
  olderThanMinutes?: number;
  count?: number;
}

/**
 * Optional per-call options for graphman methods. `signal` is forwarded to the
 * underlying GraphQL request or kubectl exec so caller-initiated cancellation
 * aborts the in-flight HTTP request or subprocess.
 */
export interface GraphmanCallOpts {
  signal?: AbortSignal;
}

export interface GraphmanClient {
  // ---- GraphQL ----
  getDeploymentInfo(deploymentId: string, opts?: GraphmanCallOpts): Promise<DeploymentInfo>;
  pauseDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanMutationAck>;
  resumeDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanMutationAck>;
  restartDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanRestartResult>;
  getExecutionStatus(executionId: string, opts?: GraphmanCallOpts): Promise<ExecutionStatus>;

  // ---- CLI fallback ----
  rewindDeployment(
    deploymentId: string,
    blockNumber: number,
    blockHash: string,
    opts?: GraphmanCallOpts,
  ): Promise<GraphmanCliResult>;
  reassignDeployment(
    deploymentId: string,
    targetNode: string,
    opts?: GraphmanCallOpts,
  ): Promise<GraphmanCliResult>;
  unassignDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  dropDeployment(deploymentId: string, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  unusedRecord(opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  unusedRemove(args?: UnusedRemoveOpts, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  checkBlocks(args: CheckBlocksArgs, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  truncateChainCache(chain: string, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
  clearCallCache(args: ClearCallCacheArgs, opts?: GraphmanCallOpts): Promise<GraphmanCliResult>;
}

// =============================================================================
// Implementation
// =============================================================================

function normalizeExecutionState(raw: string | undefined): ExecutionStatus['state'] {
  const upper = (raw ?? '').toUpperCase();
  if (upper === 'RUNNING' || upper === 'SUCCEEDED' || upper === 'FAILED') {
    return upper;
  }
  // Throw on unknown state rather than silently coercing — silent coercion to
  // RUNNING (the prior behaviour) would mask schema drift and trap callers in
  // an indefinite polling loop. Surface the raw value so operators can update
  // the allow-list (or the graphman schema).
  throw new Error(
    `graphman returned unknown execution state ${JSON.stringify(raw)}; ` +
      `expected one of RUNNING | SUCCEEDED | FAILED`,
  );
}

export function createGraphmanClient(opts: GraphmanClientOptions): GraphmanClient {
  const { gql, kubectl, configPath } = opts;
  const baseCliOpts: KubectlExecOptions = {};
  if (opts.cliTimeoutMs !== undefined) baseCliOpts.timeoutMs = opts.cliTimeoutMs;

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

  /**
   * Compose the kubectl options for a CLI invocation, layering the caller-
   * supplied AbortSignal on top of the constructor-time defaults so the
   * external signal reaches `execa({ cancelSignal })`.
   */
  function cliOptsFor(callOpts?: GraphmanCallOpts): KubectlExecOptions {
    const out: KubectlExecOptions = { ...baseCliOpts };
    if (callOpts?.signal) out.signal = callOpts.signal;
    return out;
  }

  async function runCli(
    graphmanArgs: string[],
    callOpts?: GraphmanCallOpts,
  ): Promise<GraphmanCliResult> {
    const result = await execGraphman(
      kubectl,
      configPath,
      graphmanArgs,
      cliOptsFor(callOpts),
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      command: ['graphman', '--config', configPath, ...graphmanArgs],
    };
  }

  return {
    // -------------------------------------------------------------------------
    // GraphQL operations
    // -------------------------------------------------------------------------

    async getDeploymentInfo(deploymentId, callOpts): Promise<DeploymentInfo> {
      const key = deploymentId.toLowerCase();
      return deploymentInfoCache.getOrFetch(
        key,
        async (fetchOpts) => {
          const data = await gql.request<DeploymentInfoResponse>(
            DEPLOYMENT_INFO_QUERY,
            { hash: deploymentId },
            fetchOpts.signal ? { signal: fetchOpts.signal } : undefined,
          );
          const info = data.deployment?.info;
          if (!info || typeof info.id !== 'string') {
            throw new Error(
              `graphman deployment.info returned no record for "${deploymentId}"`,
            );
          }
          const result: DeploymentInfo = {
            id: info.id,
            paused: Boolean(info.paused),
          };
          if (info.shard !== undefined) result.shard = info.shard;
          if (info.chain !== undefined) result.chain = info.chain;
          if (info.node !== undefined) result.node = info.node;
          if (info.latestBlock !== undefined) result.latestBlock = info.latestBlock;
          if (info.health !== undefined) result.health = info.health;
          return result;
        },
        callOpts?.signal ? { signal: callOpts.signal, keyLabel: key } : { keyLabel: key },
      );
    },

    async pauseDeployment(deploymentId, callOpts): Promise<GraphmanMutationAck> {
      const data = await gql.request<PauseResponse>(
        PAUSE_DEPLOYMENT_MUTATION,
        { hash: deploymentId },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      const ack = data.deployment?.pause;
      // If the API doesn't return an explicit `success` flag, treat the absence
      // of an error as success — graphql-request would have thrown otherwise.
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (ack?.message) result.message = ack.message;
      if (result.success) invalidateDeployment(deploymentId, 'pauseDeployment');
      return result;
    },

    async resumeDeployment(deploymentId, callOpts): Promise<GraphmanMutationAck> {
      const data = await gql.request<ResumeResponse>(
        RESUME_DEPLOYMENT_MUTATION,
        { hash: deploymentId },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      const ack = data.deployment?.resume;
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (ack?.message) result.message = ack.message;
      if (result.success) invalidateDeployment(deploymentId, 'resumeDeployment');
      return result;
    },

    async restartDeployment(deploymentId, callOpts): Promise<GraphmanRestartResult> {
      const data = await gql.request<RestartResponse>(
        RESTART_DEPLOYMENT_MUTATION,
        { hash: deploymentId },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      const executionId = data.deployment?.restart?.executionId;
      if (!executionId) {
        throw new Error(
          `graphman deployment.restart returned no executionId for "${deploymentId}"`,
        );
      }
      // Restart changes node assignment / sync state; bust the cached info
      // so the next read reflects the post-restart state.
      invalidateDeployment(deploymentId, 'restartDeployment');
      return { executionId };
    },

    async getExecutionStatus(executionId, callOpts): Promise<ExecutionStatus> {
      const data = await gql.request<ExecutionInfoResponse>(
        EXECUTION_INFO_QUERY,
        { id: executionId },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      const info = data.execution?.info;
      if (!info || typeof info.id !== 'string') {
        throw new Error(
          `graphman execution.info returned no record for "${executionId}"`,
        );
      }
      const result: ExecutionStatus = {
        id: info.id,
        state: normalizeExecutionState(info.state),
      };
      if (info.error) result.error = info.error;
      return result;
    },

    // -------------------------------------------------------------------------
    // CLI fallback operations
    // -------------------------------------------------------------------------
    //
    // Arg ordering follows the CLI usage table in design §2.6. Where the CLI
    // syntax is uncertain (e.g. `unused remove` flag names, `chain call-cache`
    // subcommand layout) we follow the most commonly documented form and
    // leave a TODO so operators can confirm against their graph-node version.

    async rewindDeployment(deploymentId, blockNumber, blockHash, callOpts) {
      // CLI: graphman rewind <block_hash> <block_number> <deployment>
      const result = await runCli(
        ['rewind', blockHash, String(blockNumber), deploymentId],
        callOpts,
      );
      if (result.exitCode === 0) invalidateDeployment(deploymentId, 'rewindDeployment');
      return result;
    },

    async reassignDeployment(deploymentId, targetNode, callOpts) {
      // CLI: graphman reassign <deployment> <node>
      const result = await runCli(['reassign', deploymentId, targetNode], callOpts);
      if (result.exitCode === 0) invalidateDeployment(deploymentId, 'reassignDeployment');
      return result;
    },

    async unassignDeployment(deploymentId, callOpts) {
      // CLI: graphman unassign <deployment>
      const result = await runCli(['unassign', deploymentId], callOpts);
      if (result.exitCode === 0) invalidateDeployment(deploymentId, 'unassignDeployment');
      return result;
    },

    async dropDeployment(deploymentId, callOpts) {
      // CLI: graphman drop <deployment>
      // IRREVERSIBLE — confirmation gated at the tool layer, not the client.
      const result = await runCli(['drop', deploymentId], callOpts);
      if (result.exitCode === 0) invalidateDeployment(deploymentId, 'dropDeployment');
      return result;
    },

    async unusedRecord(callOpts) {
      // CLI: graphman unused record
      return runCli(['unused', 'record'], callOpts);
    },

    async unusedRemove(args = {}, callOpts) {
      // CLI: graphman unused remove [--older <minutes>] [--count <n>]
      // TODO: verify against live graphman — some versions use `-c`/`--count`,
      // others accept only `--older`.
      const cli = ['unused', 'remove'];
      if (args.olderThanMinutes !== undefined) {
        cli.push('--older', String(args.olderThanMinutes));
      }
      if (args.count !== undefined) {
        cli.push('--count', String(args.count));
      }
      return runCli(cli, callOpts);
    },

    async checkBlocks(args, callOpts) {
      // CLI:
      //   graphman chain check-blocks <chain> by-number <n>
      //   graphman chain check-blocks <chain> by-range --from <n> --to <n>
      const cli = ['chain', 'check-blocks', args.chain];
      if (args.blockNumber !== undefined) {
        cli.push('by-number', String(args.blockNumber));
      } else if (args.from !== undefined || args.to !== undefined) {
        cli.push('by-range');
        if (args.from !== undefined) cli.push('--from', String(args.from));
        if (args.to !== undefined) cli.push('--to', String(args.to));
      } else {
        throw new Error(
          'checkBlocks requires either `blockNumber` or at least one of `from`/`to`',
        );
      }
      return runCli(cli, callOpts);
    },

    async truncateChainCache(chain, callOpts) {
      // CLI: graphman chain truncate <chain>
      // IRREVERSIBLE — confirmation gated at the tool layer.
      return runCli(['chain', 'truncate', chain], callOpts);
    },

    async clearCallCache(args, callOpts) {
      // CLI: graphman chain call-cache <chain> remove [--from <n>] [--to <n>] [--remove-entire-cache]
      // TODO: verify against live graphman — the subcommand name (`call-cache`
      // vs `callcache`) and the entire-cache flag (`--remove-entire-cache`
      // vs `--remove-all`) have varied across versions.
      const cli = ['chain', 'call-cache', args.chain, 'remove'];
      if (args.removeAll) {
        cli.push('--remove-entire-cache');
      } else {
        if (args.from !== undefined) cli.push('--from', String(args.from));
        if (args.to !== undefined) cli.push('--to', String(args.to));
      }
      return runCli(cli, callOpts);
    },
  };
}
