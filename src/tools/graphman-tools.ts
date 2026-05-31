import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { registerIndexerTool } from '../server/register.js';
import type {
  CheckBlocksArgs,
  ClearCallCacheArgs,
  GraphmanClient,
  RewindArgs,
} from '../clients/graphman.js';

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

// =============================================================================
// Input schemas
// =============================================================================

/** IPFS CID v0 — 46-char base58 starting with `Qm`. */
const deploymentIdSchema = z
  .string()
  .regex(
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/,
    'deployment_id must be an IPFS CID v0 (Qm…, 46 chars, base58)',
  );

/** execution ids are server-issued — keep loose but reject empty + leading dash. */
const executionIdSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith('-'), 'execution_id cannot start with -');

/** 32-byte hex block hash with 0x prefix. */
const blockHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'block_hash must be 32-byte hex (0x + 64 chars)');

/**
 * Chain names and graph-node identifiers — alnum + `_` + `-`, must NOT start
 * with `-`. Retained as an injection guard even though values now flow as
 * GraphQL variables, not CLI argv.
 */
const chainSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/,
    'chain must be alphanumeric / _ / -, and may not start with -',
  );

const nodeSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/,
    'node must be alphanumeric / _ / -, and may not start with -',
  );

const deploymentIdShape = { deployment_id: deploymentIdSchema };
const executionIdShape = { execution_id: executionIdSchema };

// ---- rewind --------------------------------------------------------------
const rewindShape = {
  deployment_id: deploymentIdSchema,
  start_block: z.boolean().optional(),
  block_hash: blockHashSchema.optional(),
  block_number: z.coerce.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
  delay_seconds: z.coerce.number().int().nonnegative().optional(),
  confirm: z.literal(true),
};
const rewindRefined = z
  .object(rewindShape)
  .refine(
    (v) => {
      const usesStart = v.start_block === true;
      const usesTarget = v.block_hash !== undefined && v.block_number !== undefined;
      // XOR: exactly one of (start_block) or (block_hash AND block_number).
      return usesStart !== usesTarget;
    },
    {
      message:
        'rewind requires EITHER start_block=true OR both block_hash and block_number, not both and not neither',
    },
  )
  .refine(
    (v) => {
      // When not rewinding to start, hash and number must be paired (no partial).
      if (v.start_block === true) return v.block_hash === undefined && v.block_number === undefined;
      return v.block_hash !== undefined && v.block_number !== undefined;
    },
    {
      message:
        'when start_block=true, omit block_hash/block_number; otherwise BOTH block_hash and block_number are required',
    },
  );

// ---- drop ----------------------------------------------------------------
const dropShape = {
  deployment_id: deploymentIdSchema,
  all: z.boolean().optional(),
  confirm: z.literal(true),
};

// ---- reassign ------------------------------------------------------------
const reassignShape = {
  deployment_id: deploymentIdSchema,
  node: nodeSchema,
};

// ---- unassign ------------------------------------------------------------
const unassignShape = {
  deployment_id: deploymentIdSchema,
  confirm: z.literal(true),
};

// ---- check_blocks --------------------------------------------------------
const checkBlocksShape = {
  chain: chainSchema,
  by_hash: blockHashSchema.optional(),
  by_number: z
    .object({
      number: z.coerce.number().int().nonnegative(),
      delete_duplicates: z.boolean().optional(),
    })
    .optional(),
  by_range: z
    .object({
      from: z.coerce.number().int().nonnegative().optional(),
      to: z.coerce.number().int().nonnegative().optional(),
      delete_duplicates: z.boolean().optional(),
    })
    .optional(),
};
const checkBlocksRefined = z
  .object(checkBlocksShape)
  .refine(
    (v) => {
      const n =
        (v.by_hash !== undefined ? 1 : 0) +
        (v.by_number !== undefined ? 1 : 0) +
        (v.by_range !== undefined ? 1 : 0);
      return n === 1;
    },
    {
      message:
        'check_blocks requires EXACTLY ONE of by_hash, by_number, or by_range',
    },
  )
  .refine(
    (v) =>
      v.by_range === undefined ||
      v.by_range.from === undefined ||
      v.by_range.to === undefined ||
      v.by_range.to >= v.by_range.from,
    { message: 'check_blocks by_range requires to >= from' },
  );

// ---- truncate_chain_cache ------------------------------------------------
const truncateChainCacheShape = {
  chain: chainSchema,
  confirm: z.literal(true),
};

// ---- clear_call_cache ----------------------------------------------------
const clearCallCacheShape = {
  chain: chainSchema,
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  remove_entire_cache: z.boolean().optional(),
  ttl_days: z.coerce.number().int().positive().optional(),
  max_contracts: z.coerce.number().int().nonnegative().optional(),
  confirm: z.literal(true),
};
const clearCallCacheRefined = z
  .object(clearCallCacheShape)
  .refine(
    (v) => {
      const usesRange = v.from !== undefined || v.to !== undefined;
      const usesAll = v.remove_entire_cache === true;
      const usesTtl = v.ttl_days !== undefined;
      // Exactly one of the three modes.
      const modes = (usesRange ? 1 : 0) + (usesAll ? 1 : 0) + (usesTtl ? 1 : 0);
      return modes === 1;
    },
    {
      message:
        'clear_call_cache requires EXACTLY ONE mode: a from/to range, remove_entire_cache=true, or ttl_days',
    },
  )
  .refine(
    (v) => {
      // Range mode must supply BOTH from and to.
      const usesRange = v.from !== undefined || v.to !== undefined;
      if (!usesRange) return true;
      return v.from !== undefined && v.to !== undefined;
    },
    { message: 'clear_call_cache range mode requires BOTH from and to' },
  )
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.to >= v.from,
    { message: 'clear_call_cache requires to >= from' },
  )
  .refine((v) => v.max_contracts === undefined || v.ttl_days !== undefined, {
    message: 'clear_call_cache max_contracts requires ttl_days',
  });

// =============================================================================
// Registration
// =============================================================================

export function registerGraphmanTools(
  server: McpServer,
  deps: GraphmanToolDeps,
): void {
  const { client } = deps;

  // ---- read / lifecycle tools ----------------------------------------------

  registerIndexerTool(server, {
    name: 'graphman_deployment_info',
    permissionClass: 'read',
    description:
      'Get deployment details via the graphman GraphQL API (pause state, shard, chain, node assignment, latest block, health).',
    inputSchema: deploymentIdShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const info = await client.getDeploymentInfo(args.deployment_id, {
        signal: extra.signal,
      });
      return asJsonResult(info);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_pause_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Pause indexing for a deployment via the graphman GraphQL API. No data is lost; resume with graphman_resume_deployment.',
    inputSchema: deploymentIdShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const ack = await client.pauseDeployment(args.deployment_id, {
        signal: extra.signal,
      });
      return asJsonResult(ack);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_resume_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Resume a previously paused deployment via the graphman GraphQL API.',
    inputSchema: deploymentIdShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const ack = await client.resumeDeployment(args.deployment_id, {
        signal: extra.signal,
      });
      return asJsonResult(ack);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_restart_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Restart a deployment (pause then resume with delay) via the graphman GraphQL API. Returns an execution_id; poll status with graphman_get_execution_status.',
    inputSchema: deploymentIdShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.restartDeployment(args.deployment_id, {
        signal: extra.signal,
      });
      return asJsonResult({ execution_id: result.executionId });
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_get_execution_status',
    permissionClass: 'read',
    description:
      'Poll the status of a long-running graphman async command via the GraphQL API. State is one of RUNNING | SUCCEEDED | FAILED.',
    inputSchema: executionIdShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const status = await client.getExecutionStatus(args.execution_id, {
        signal: extra.signal,
      });
      return asJsonResult(status);
    },
  });

  // ---- deployment mutations ------------------------------------------------

  registerIndexerTool(server, {
    name: 'graphman_rewind_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'Rewind a deployment to a specific block (block_hash + block_number), OR truncate it to its own start block (start_block=true), via the graphman GraphQL API. Destructive: discards indexed entity state after the target. Runs asynchronously — returns an execution_id to poll with graphman_get_execution_status. Requires confirm=true.',
    inputSchema: rewindShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Cross-field validation (start_block XOR hash+number) lives in the
      // refined schema — re-parse so a violation throws a ZodError that
      // registerIndexerTool surfaces as an MCP tool error.
      const v = rewindRefined.parse(args);
      const rewindArgs: RewindArgs = {};
      if (v.start_block !== undefined) rewindArgs.startBlock = v.start_block;
      if (v.block_hash !== undefined) rewindArgs.blockHash = v.block_hash;
      if (v.block_number !== undefined) rewindArgs.blockNumber = v.block_number;
      if (v.force !== undefined) rewindArgs.force = v.force;
      if (v.delay_seconds !== undefined) rewindArgs.delaySeconds = v.delay_seconds;
      const result = await client.rewindDeployment(v.deployment_id, rewindArgs, {
        signal: extra.signal,
      });
      return asJsonResult({
        execution_id: result.executionId,
        hint: 'poll graphman_get_execution_status',
      });
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_drop_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Force-delete a deployment via the graphman GraphQL API (deleteDeployment) — auto-unassigns, then deletes all indexed data and metadata. This is the sole deletion path. A Qm hash matching multiple deployments FAILS unless all=true; the deleted locators are returned. Requires confirm=true.',
    inputSchema: dropShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.dropDeployment(args.deployment_id, args.all ?? false, {
        signal: extra.signal,
      });
      return asJsonResult({ deleted_locators: result.deletedLocators });
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_reassign_deployment',
    permissionClass: 'graphman_safe',
    description:
      'Assign or reassign a deployment to a different graph-node instance via the graphman GraphQL API. Safe — no data is lost. May complete with warnings (surfaced in the result).',
    inputSchema: reassignShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.reassignDeployment(args.deployment_id, args.node, {
        signal: extra.signal,
      });
      const out: { success: boolean; warnings?: string[] } = { success: result.success };
      if (result.warnings) out.warnings = result.warnings;
      return asJsonResult(out);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_unassign_deployment',
    permissionClass: 'graphman_destructive',
    description:
      'Stop indexing a deployment via the graphman GraphQL API (unassign). Data is preserved; the deployment is detached from its graph-node instance. Requires confirm=true.',
    inputSchema: unassignShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const ack = await client.unassignDeployment(args.deployment_id, {
        signal: extra.signal,
      });
      return asJsonResult(ack);
    },
  });

  // ---- chain mutations -----------------------------------------------------

  registerIndexerTool(server, {
    name: 'graphman_check_blocks',
    permissionClass: 'graphman_safe',
    description:
      'Compare cached blocks against the RPC provider via the graphman GraphQL API and delete cache entries that diverge (re-fetchable, hence safe). Provide EXACTLY ONE method: by_hash, by_number{number, delete_duplicates?}, or by_range{from?, to?, delete_duplicates?}. by_hash/by_number run synchronously and return per-block results; by_range runs asynchronously and returns an execution_id to poll with graphman_get_execution_status.',
    inputSchema: checkBlocksShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Cross-field validation (exactly-one method, to>=from) lives in the
      // refined schema — re-parse to enforce it.
      const v = checkBlocksRefined.parse(args);
      const callArgs: CheckBlocksArgs = { chain: v.chain };
      if (v.by_hash !== undefined) {
        callArgs.byHash = v.by_hash;
      } else if (v.by_number !== undefined) {
        callArgs.byNumber = { number: v.by_number.number };
        if (v.by_number.delete_duplicates !== undefined) {
          callArgs.byNumber.deleteDuplicates = v.by_number.delete_duplicates;
        }
      } else if (v.by_range !== undefined) {
        callArgs.byRange = {};
        if (v.by_range.from !== undefined) callArgs.byRange.from = v.by_range.from;
        if (v.by_range.to !== undefined) callArgs.byRange.to = v.by_range.to;
        if (v.by_range.delete_duplicates !== undefined) {
          callArgs.byRange.deleteDuplicates = v.by_range.delete_duplicates;
        }
      }
      const result = await client.checkBlocks(callArgs, { signal: extra.signal });
      if (result.kind === 'execution') {
        return asJsonResult({
          execution_id: result.executionId,
          hint: 'poll graphman_get_execution_status',
        });
      }
      return asJsonResult(result.result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_truncate_chain_cache',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Delete the entire block cache for a chain via the graphman GraphQL API. Use only after confirmed cache corruption. Requires confirm=true.',
    inputSchema: truncateChainCacheShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const ack = await client.truncateChainCache(args.chain, {
        signal: extra.signal,
      });
      return asJsonResult(ack);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_clear_call_cache',
    permissionClass: 'graphman_destructive',
    description:
      'Remove entries from a chain\'s call cache via the graphman GraphQL API. Requires confirm=true AND EXACTLY ONE mode: a from/to range (to>=from), remove_entire_cache=true, or ttl_days (stale-eviction, optional max_contracts). remove_entire_cache can significantly reduce indexing performance.',
    inputSchema: clearCallCacheShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Cross-field validation (exactly-one mode, range completeness, to>=from,
      // max_contracts requires ttl_days) lives in the refined schema.
      const v = clearCallCacheRefined.parse(args);
      const callArgs: ClearCallCacheArgs = { chain: v.chain };
      if (v.from !== undefined) callArgs.from = v.from;
      if (v.to !== undefined) callArgs.to = v.to;
      if (v.remove_entire_cache !== undefined) callArgs.removeEntireCache = v.remove_entire_cache;
      if (v.ttl_days !== undefined) callArgs.ttlDays = v.ttl_days;
      if (v.max_contracts !== undefined) callArgs.maxContracts = v.max_contracts;
      const result = await client.clearCallCache(callArgs, { signal: extra.signal });
      return asJsonResult(result);
    },
  });
}
