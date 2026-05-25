import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { registerIndexerTool } from '../server/register.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { GraphmanCliResult } from '../types/graphman.js';

export interface GraphmanToolDeps {
  client: GraphmanClient;
}

// =============================================================================
// Helpers
// =============================================================================

function asJsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Render a graphman CLI result. Non-zero exit codes are surfaced as MCP
 * tool errors so Claude can decide whether to retry or report — but the
 * full stdout/stderr/exitCode are always included for diagnostics.
 */
function asCliResult(result: GraphmanCliResult): CallToolResult {
  const body = {
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  const payload: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
  if (result.exitCode !== 0) payload.isError = true;
  return payload;
}

// =============================================================================
// Input schemas
// =============================================================================

const deploymentIdShape = { deployment_id: z.string() };
const executionIdShape = { execution_id: z.string() };

const rewindShape = {
  deployment_id: z.string(),
  block_number: z.coerce.number().int().nonnegative(),
  block_hash: z.string(),
};

const reassignShape = {
  deployment_id: z.string(),
  target_node: z.string(),
};

const dropShape = {
  deployment_id: z.string(),
  confirm: z.literal(true),
};

const unusedRemoveShape = {
  older_than_minutes: z.coerce.number().int().nonnegative().optional(),
  count: z.coerce.number().int().positive().optional(),
  confirm: z.literal(true),
};

const checkBlocksShape = {
  chain: z.string(),
  block_number: z.coerce.number().int().nonnegative().optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
};

const truncateChainCacheShape = {
  chain: z.string(),
  confirm: z.literal(true),
};

const clearCallCacheShape = {
  chain: z.string(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  remove_all: z.boolean().optional(),
};

// =============================================================================
// Registration
// =============================================================================

export function registerGraphmanTools(
  server: McpServer,
  deps: GraphmanToolDeps,
): void {
  const { client } = deps;

  // ---- GraphQL-backed tools ------------------------------------------------

  registerIndexerTool(server, {
    name: 'graphman_deployment_info',
    permissionClass: 'read',
    description:
      'Get deployment details via the graphman GraphQL API (pause state, shard, chain, node assignment, latest block, health).',
    inputSchema: deploymentIdShape,
    handler: async (args) => {
      const info = await client.getDeploymentInfo(args.deployment_id);
      return asJsonResult(info);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_pause_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Pause indexing for a deployment via the graphman GraphQL API. No data is lost; resume with graphman_resume_deployment.',
    inputSchema: deploymentIdShape,
    handler: async (args) => {
      const ack = await client.pauseDeployment(args.deployment_id);
      return asJsonResult(ack);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_resume_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Resume a previously paused deployment via the graphman GraphQL API.',
    inputSchema: deploymentIdShape,
    handler: async (args) => {
      const ack = await client.resumeDeployment(args.deployment_id);
      return asJsonResult(ack);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_restart_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Restart a deployment (pause then resume with delay) via the graphman GraphQL API. Returns an execution_id; poll status with graphman_get_execution_status.',
    inputSchema: deploymentIdShape,
    handler: async (args) => {
      const result = await client.restartDeployment(args.deployment_id);
      return asJsonResult({ execution_id: result.executionId });
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_get_execution_status',
    permissionClass: 'read',
    description:
      'Poll the status of a long-running graphman async command via the GraphQL API. State is one of RUNNING | SUCCEEDED | FAILED.',
    inputSchema: executionIdShape,
    handler: async (args) => {
      const status = await client.getExecutionStatus(args.execution_id);
      return asJsonResult(status);
    },
  });

  // ---- CLI-fallback tools --------------------------------------------------

  registerIndexerTool(server, {
    name: 'graphman_rewind_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'Rewind a deployment to a specific block via the graphman CLI (kubectl exec). Clears indexed data after the target block — preserves the deployment but is destructive to indexed state.',
    inputSchema: rewindShape,
    handler: async (args) => {
      const result = await client.rewindDeployment(
        args.deployment_id,
        args.block_number,
        args.block_hash,
      );
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_reassign_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Move a deployment to a different graph-node instance via the graphman CLI. Safe operation — no data is lost.',
    inputSchema: reassignShape,
    handler: async (args) => {
      const result = await client.reassignDeployment(
        args.deployment_id,
        args.target_node,
      );
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_unassign_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'Stop indexing a deployment permanently via the graphman CLI. Data is preserved; the deployment is detached from its current graph-node instance.',
    inputSchema: deploymentIdShape,
    handler: async (args) => {
      const result = await client.unassignDeployment(args.deployment_id);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_drop_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Full removal of a deployment via the graphman CLI — unassigns, removes the name binding, and deletes indexed data. Requires confirm=true.',
    inputSchema: dropShape,
    handler: async (args) => {
      const result = await client.dropDeployment(args.deployment_id);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_unused_record',
    permissionClass: 'graphman_destructive',
    description:
      'Scan shards and mark unused deployments via the graphman CLI. First step in disk-reclamation; pairs with graphman_unused_remove.',
    handler: async () => {
      const result = await client.unusedRecord();
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_unused_remove',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Delete data for deployments previously marked unused via the graphman CLI. Optional filters: older_than_minutes, count. Requires confirm=true.',
    inputSchema: unusedRemoveShape,
    handler: async (args) => {
      const opts: { olderThanMinutes?: number; count?: number } = {};
      if (args.older_than_minutes !== undefined) {
        opts.olderThanMinutes = args.older_than_minutes;
      }
      if (args.count !== undefined) opts.count = args.count;
      const result = await client.unusedRemove(opts);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_check_blocks',
    permissionClass: 'read',
    description:
      'Compare cached blocks against the RPC provider via the graphman CLI. Either by single block (block_number) or by range (from/to). Read-only diagnostic.',
    inputSchema: checkBlocksShape,
    handler: async (args) => {
      const argsForCli: {
        chain: string;
        blockNumber?: number;
        from?: number;
        to?: number;
      } = { chain: args.chain };
      if (args.block_number !== undefined) argsForCli.blockNumber = args.block_number;
      if (args.from !== undefined) argsForCli.from = args.from;
      if (args.to !== undefined) argsForCli.to = args.to;
      const result = await client.checkBlocks(argsForCli);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_truncate_chain_cache',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Clear the entire block cache for a chain via the graphman CLI. Use only after confirmed cache corruption. Requires confirm=true.',
    inputSchema: truncateChainCacheShape,
    handler: async (args) => {
      const result = await client.truncateChainCache(args.chain);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_clear_call_cache',
    permissionClass: 'graphman_destructive',
    description:
      'Remove call cache entries for a chain via the graphman CLI. Use from/to for a range, or remove_all=true to wipe the entire call cache for the chain.',
    inputSchema: clearCallCacheShape,
    handler: async (args) => {
      const cliArgs: {
        chain: string;
        from?: number;
        to?: number;
        removeAll?: boolean;
      } = { chain: args.chain };
      if (args.from !== undefined) cliArgs.from = args.from;
      if (args.to !== undefined) cliArgs.to = args.to;
      if (args.remove_all !== undefined) cliArgs.removeAll = args.remove_all;
      const result = await client.clearCallCache(cliArgs);
      return asCliResult(result);
    },
  });
}
