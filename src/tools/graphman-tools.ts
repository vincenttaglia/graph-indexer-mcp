import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { registerIndexerTool } from '../server/register.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { CappedStream, GraphmanCliResult } from '../types/graphman.js';

export interface GraphmanToolDeps {
  client: GraphmanClient;
}

// =============================================================================
// Helpers
// =============================================================================

/** Max bytes preserved per CLI stream in the MCP CallToolResult payload. */
const CLI_STREAM_CAP_BYTES = 32 * 1024;

/**
 * Truncate a CLI stream to `max` bytes, preserving the TAIL (graphman errors
 * and exit summaries appear at the end of output, so keeping the head would
 * usually drop the most useful diagnostics).
 */
function capStream(s: string, max = CLI_STREAM_CAP_BYTES): CappedStream {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(-max), truncated: true };
}

function asJsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Render a graphman CLI result. Non-zero exit codes are surfaced as MCP
 * tool errors so Claude can decide whether to retry or report — but the
 * full stdout/stderr/exitCode are always included for diagnostics.
 *
 * stdout/stderr are capped at `CLI_STREAM_CAP_BYTES`; when truncated, only
 * the tail is preserved and a `truncated: true` marker is added so callers
 * can flag the elision.
 */
function asCliResult(result: GraphmanCliResult): CallToolResult {
  const stdout = capStream(result.stdout);
  const stderr = capStream(result.stderr);
  const body = {
    command: result.command,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stdout_truncated: stdout.truncated,
    stderr: stderr.text,
    stderr_truncated: stderr.truncated,
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
//
// String inputs that are forwarded as positional arguments to the graphman
// CLI are pattern-restricted to defeat leading-`-` injection (execa blocks
// shell injection, but graphman's own argv parser would still treat a value
// like `--foo` as a flag).

/** IPFS CID v0 — 46-char base58 starting with `Qm`. */
const deploymentIdSchema = z
  .string()
  .regex(
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/,
    'deployment_id must be an IPFS CID v0 (Qm…, 46 chars, base58)',
  );

/** 32-byte hex block hash with 0x prefix. */
const blockHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'block_hash must be 32-byte hex (0x + 64 chars)');

/**
 * Chain names and graph-node identifiers — alnum + `_` + `-`, must NOT start
 * with `-` (which graphman would interpret as a flag).
 */
const chainSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/,
    'chain must be alphanumeric / _ / -, and may not start with -',
  );

const targetNodeSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/,
    'target_node must be alphanumeric / _ / -, and may not start with -',
  );

/** execution ids are server-issued — keep loose but reject empty + leading dash. */
const executionIdSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith('-'), 'execution_id cannot start with -');

const deploymentIdShape = { deployment_id: deploymentIdSchema };
const executionIdShape = { execution_id: executionIdSchema };

const rewindShape = {
  deployment_id: deploymentIdSchema,
  block_number: z.coerce.number().int().nonnegative(),
  block_hash: blockHashSchema,
};

const reassignShape = {
  deployment_id: deploymentIdSchema,
  target_node: targetNodeSchema,
};

const dropShape = {
  deployment_id: deploymentIdSchema,
  confirm: z.literal(true),
};

const unusedRemoveShape = {
  older_than_minutes: z.coerce.number().int().nonnegative().optional(),
  count: z.coerce.number().int().positive().optional(),
  confirm: z.literal(true),
};

/**
 * `check_blocks` accepts either a single block_number, OR a complete
 * from/to range with `to >= from`. Anything else (both forms, partial range,
 * empty) is rejected at validation time so we never silently pass a malformed
 * invocation to the CLI.
 *
 * The MCP SDK's `inputSchema` only takes a ZodRawShape, so we keep `*Shape`
 * for registration and re-validate via the matching `*Refined` object inside
 * the handler. The refined parse throws a ZodError on violation, which the
 * tool wrapper surfaces as a normal MCP error.
 */
const checkBlocksShape = {
  chain: chainSchema,
  block_number: z.coerce.number().int().nonnegative().optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
};
const checkBlocksRefined = z
  .object(checkBlocksShape)
  .refine(
    (v) => {
      const hasSingle = v.block_number !== undefined;
      const hasRange = v.from !== undefined || v.to !== undefined;
      return hasSingle !== hasRange; // XOR: exactly one form
    },
    {
      message:
        'check_blocks requires EITHER block_number OR a from/to range, not both and not neither',
    },
  )
  .refine(
    (v) => {
      if (v.from === undefined && v.to === undefined) return true;
      return v.from !== undefined && v.to !== undefined;
    },
    { message: 'when using a range, BOTH from and to must be provided' },
  )
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.to >= v.from,
    { message: 'check_blocks requires to >= from' },
  );

const truncateChainCacheShape = {
  chain: chainSchema,
  confirm: z.literal(true),
};

/**
 * `clear_call_cache` is destructive. Requires `confirm: true`, AND requires
 * exactly one of:
 *   - remove_all: true (alone, no from/to)
 *   - a complete from/to range with `to >= from`
 *
 * A bare invocation (no remove_all, no range) would have made graphman remove
 * the entire call cache implicitly — refuse it.
 */
const clearCallCacheShape = {
  chain: chainSchema,
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  remove_all: z.boolean().optional(),
  confirm: z.literal(true),
};
const clearCallCacheRefined = z
  .object(clearCallCacheShape)
  .refine(
    (v) => {
      const usesAll = v.remove_all === true;
      const usesRange = v.from !== undefined || v.to !== undefined;
      return usesAll !== usesRange; // XOR
    },
    {
      message:
        'clear_call_cache requires EITHER remove_all=true OR a from/to range, not both and not neither',
    },
  )
  .refine(
    (v) => {
      if (v.remove_all === true) {
        return v.from === undefined && v.to === undefined;
      }
      return v.from !== undefined && v.to !== undefined;
    },
    {
      message:
        'when remove_all=true, omit from/to; when using a range, BOTH from and to must be provided',
    },
  )
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.to >= v.from,
    { message: 'clear_call_cache requires to >= from' },
  );

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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.dropDeployment(args.deployment_id);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_unused_record',
    permissionClass: 'graphman_destructive',
    description:
      'Scan shards and mark unused deployments via the graphman CLI. First step in disk-reclamation; pairs with graphman_unused_remove.',
    handler: async (_args, extra) => {
      extra.signal.throwIfAborted();
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
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
      'Compare cached blocks against the RPC provider via the graphman CLI. Provide EITHER block_number (single block) OR both from and to (range, to>=from). Read-only diagnostic.',
    inputSchema: checkBlocksShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Cross-field validation can't be expressed in the raw shape — re-parse
      // through the refined object schema; a refinement failure throws a
      // ZodError that registerIndexerTool surfaces as an MCP tool error.
      const validated = checkBlocksRefined.parse(args);
      const argsForCli: {
        chain: string;
        blockNumber?: number;
        from?: number;
        to?: number;
      } = { chain: validated.chain };
      if (validated.block_number !== undefined) {
        argsForCli.blockNumber = validated.block_number;
      }
      if (validated.from !== undefined) argsForCli.from = validated.from;
      if (validated.to !== undefined) argsForCli.to = validated.to;
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
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.truncateChainCache(args.chain);
      return asCliResult(result);
    },
  });

  registerIndexerTool(server, {
    name: 'graphman_clear_call_cache',
    permissionClass: 'graphman_destructive',
    description:
      'IRREVERSIBLE: Remove call cache entries for a chain via the graphman CLI. Requires confirm=true AND exactly one of: remove_all=true (alone) OR a complete from/to range (to>=from). A bare invocation is REJECTED to prevent accidental full-cache wipes.',
    inputSchema: clearCallCacheShape,
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Cross-field validation (XOR remove_all vs range, range completeness,
      // to>=from) lives in the refined schema — re-parse to enforce it.
      const validated = clearCallCacheRefined.parse(args);
      const cliArgs: {
        chain: string;
        from?: number;
        to?: number;
        removeAll?: boolean;
      } = { chain: validated.chain };
      if (validated.from !== undefined) cliArgs.from = validated.from;
      if (validated.to !== undefined) cliArgs.to = validated.to;
      if (validated.remove_all !== undefined) cliArgs.removeAll = validated.remove_all;
      const result = await client.clearCallCache(cliArgs);
      return asCliResult(result);
    },
  });
}
