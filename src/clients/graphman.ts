import type { TypedGraphqlClient } from '../utils/graphql-client.js';
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

export interface GraphmanClient {
  // ---- GraphQL ----
  getDeploymentInfo(deploymentId: string): Promise<DeploymentInfo>;
  pauseDeployment(deploymentId: string): Promise<GraphmanMutationAck>;
  resumeDeployment(deploymentId: string): Promise<GraphmanMutationAck>;
  restartDeployment(deploymentId: string): Promise<GraphmanRestartResult>;
  getExecutionStatus(executionId: string): Promise<ExecutionStatus>;

  // ---- CLI fallback ----
  rewindDeployment(
    deploymentId: string,
    blockNumber: number,
    blockHash: string,
  ): Promise<GraphmanCliResult>;
  reassignDeployment(
    deploymentId: string,
    targetNode: string,
  ): Promise<GraphmanCliResult>;
  unassignDeployment(deploymentId: string): Promise<GraphmanCliResult>;
  dropDeployment(deploymentId: string): Promise<GraphmanCliResult>;
  unusedRecord(): Promise<GraphmanCliResult>;
  unusedRemove(opts?: UnusedRemoveOpts): Promise<GraphmanCliResult>;
  checkBlocks(args: CheckBlocksArgs): Promise<GraphmanCliResult>;
  truncateChainCache(chain: string): Promise<GraphmanCliResult>;
  clearCallCache(args: ClearCallCacheArgs): Promise<GraphmanCliResult>;
}

// =============================================================================
// Implementation
// =============================================================================

function normalizeExecutionState(raw: string | undefined): ExecutionStatus['state'] {
  const upper = (raw ?? '').toUpperCase();
  if (upper === 'RUNNING' || upper === 'SUCCEEDED' || upper === 'FAILED') {
    return upper;
  }
  // Conservative default — surfacing FAILED on unknown state would be misleading;
  // RUNNING keeps the polling loop alive until the operator notices.
  // TODO: verify against live graphman schema for the full state set.
  return 'RUNNING';
}

export function createGraphmanClient(opts: GraphmanClientOptions): GraphmanClient {
  const { gql, kubectl, configPath } = opts;
  const cliOpts: KubectlExecOptions = {};
  if (opts.cliTimeoutMs !== undefined) cliOpts.timeoutMs = opts.cliTimeoutMs;

  async function runCli(graphmanArgs: string[]): Promise<GraphmanCliResult> {
    const result = await execGraphman(kubectl, configPath, graphmanArgs, cliOpts);
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

    async getDeploymentInfo(deploymentId): Promise<DeploymentInfo> {
      const data = await gql.request<DeploymentInfoResponse>(DEPLOYMENT_INFO_QUERY, {
        hash: deploymentId,
      });
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

    async pauseDeployment(deploymentId): Promise<GraphmanMutationAck> {
      const data = await gql.request<PauseResponse>(PAUSE_DEPLOYMENT_MUTATION, {
        hash: deploymentId,
      });
      const ack = data.deployment?.pause;
      // If the API doesn't return an explicit `success` flag, treat the absence
      // of an error as success — graphql-request would have thrown otherwise.
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (ack?.message) result.message = ack.message;
      return result;
    },

    async resumeDeployment(deploymentId): Promise<GraphmanMutationAck> {
      const data = await gql.request<ResumeResponse>(RESUME_DEPLOYMENT_MUTATION, {
        hash: deploymentId,
      });
      const ack = data.deployment?.resume;
      const result: GraphmanMutationAck = { success: ack?.success ?? true };
      if (ack?.message) result.message = ack.message;
      return result;
    },

    async restartDeployment(deploymentId): Promise<GraphmanRestartResult> {
      const data = await gql.request<RestartResponse>(RESTART_DEPLOYMENT_MUTATION, {
        hash: deploymentId,
      });
      const executionId = data.deployment?.restart?.executionId;
      if (!executionId) {
        throw new Error(
          `graphman deployment.restart returned no executionId for "${deploymentId}"`,
        );
      }
      return { executionId };
    },

    async getExecutionStatus(executionId): Promise<ExecutionStatus> {
      const data = await gql.request<ExecutionInfoResponse>(EXECUTION_INFO_QUERY, {
        id: executionId,
      });
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

    async rewindDeployment(deploymentId, blockNumber, blockHash) {
      // CLI: graphman rewind <block_hash> <block_number> <deployment>
      return runCli(['rewind', blockHash, String(blockNumber), deploymentId]);
    },

    async reassignDeployment(deploymentId, targetNode) {
      // CLI: graphman reassign <deployment> <node>
      return runCli(['reassign', deploymentId, targetNode]);
    },

    async unassignDeployment(deploymentId) {
      // CLI: graphman unassign <deployment>
      return runCli(['unassign', deploymentId]);
    },

    async dropDeployment(deploymentId) {
      // CLI: graphman drop <deployment>
      // IRREVERSIBLE — confirmation gated at the tool layer, not the client.
      return runCli(['drop', deploymentId]);
    },

    async unusedRecord() {
      // CLI: graphman unused record
      return runCli(['unused', 'record']);
    },

    async unusedRemove(opts = {}) {
      // CLI: graphman unused remove [--older <minutes>] [--count <n>]
      // TODO: verify against live graphman — some versions use `-c`/`--count`,
      // others accept only `--older`.
      const args = ['unused', 'remove'];
      if (opts.olderThanMinutes !== undefined) {
        args.push('--older', String(opts.olderThanMinutes));
      }
      if (opts.count !== undefined) {
        args.push('--count', String(opts.count));
      }
      return runCli(args);
    },

    async checkBlocks(args) {
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
      return runCli(cli);
    },

    async truncateChainCache(chain) {
      // CLI: graphman chain truncate <chain>
      // IRREVERSIBLE — confirmation gated at the tool layer.
      return runCli(['chain', 'truncate', chain]);
    },

    async clearCallCache(args) {
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
      return runCli(cli);
    },
  };
}
