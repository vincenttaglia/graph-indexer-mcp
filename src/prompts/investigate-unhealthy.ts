/**
 * Prompt: `investigate_unhealthy`
 *
 * Targeted diagnostic walkthrough for a specific deployment that the
 * indexer is reporting as unhealthy (per `get_deployment_health`).
 * Required arg: `deployment_id` — accepts either a Qm... CIDv0 hash or
 * a 0x-prefixed 32-byte hex id.
 *
 * The prompt is read-only: it instructs Claude to gather diagnostic data
 * and recommend a remediation path (often the `recover_failed_deployment`
 * follow-up prompt) without invoking any mutation tool directly.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerPrompt } from '../server/register.js';

const argsSchema = {
  deployment_id: z
    .string()
    .regex(
      /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|0x[a-fA-F0-9]{64})$/,
      'must be Qm... or 0x... deployment ID',
    ),
};

export function registerInvestigateUnhealthyPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'investigate_unhealthy',
    description:
      'Guide through diagnosing a specific unhealthy deployment: gather health, sync, signal, allocation, and graphman state, then recommend remediation.',
    argsSchema,
    handler: (args) => {
      const deploymentId = args.deployment_id;
      const text = `# Investigate Unhealthy Deployment

Goal: diagnose the unhealthy state of deployment \`${deploymentId}\` and recommend a remediation path.

## Before diving in — try the composite first

Consider calling \`run_health_check\` first. If deployment \`${deploymentId}\` shows up in the \`blockedFromClose\` list, the \`closabilityReason\` and \`fatalErrorDeterministic\` / \`lastHealthyBlock\` / \`fatalErrorBlock\` fields often give you the diagnosis immediately. If it shows up in \`recoveryPlan\` with a concrete \`type\` ('restart' | 'rewind' | 'check_blocks' | 'clear_call_cache' | 'manual_review'), you can short-circuit straight to a \`recover_failed_deployment\` recommendation. This prompt is still read-only — even if the composite returns a recoveryPlan entry, do NOT auto-execute graphman_* tools from here.

## Reference resources

- \`indexer://config\` — indexer address and graph-node/graphman endpoints.
- \`indexer://overview\` — recent infrastructure context.
- \`indexer://glossary\` — definitions for "deterministic error", "fatalError", "POI", "sync gap".

## Step 1 — Gather deployment state

Call in parallel:

- \`get_deployment_health\` with deployment ${deploymentId} — health enum, fatalError, latestBlock, chainHead, lag.
- \`get_deployment_signal\` — current curation signal (is anyone still curating this?).
- \`get_deployment_allocations\` — who else is indexing this; cross-check failure block against peer POIs.
- \`graphman_deployment_info\` with deployment ${deploymentId} — node assignment, paused state, namespace, schema.
- \`get_entity_count\` with deployment ${deploymentId} — entity count progression (large drop = data loss).
- \`get_subgraph_size\` with deployment ${deploymentId} — current disk footprint.
- \`get_subgraph_manifest\` with deployment ${deploymentId} — fetches the deployment's manifest from IPFS: the subgraph's network(s), each \`dataSources[].network\` / \`address\` (the contracts indexed), and \`startBlock\`. This tells you WHICH chain to RPC-check in Steps 2–3 and which contracts are involved — keep the network name and startBlock handy.

## Step 2 — Classify the failure mode

Use \`get_deployment_health\` output to bucket the issue:

- **Health = \`healthy\` but lagging** — RPC issue or congestion. Investigate node logs, then confirm the chain head directly: call \`list_rpc_chains\` (zero-arg) to find the alias + permitted methods for the deployment's network (from the \`get_subgraph_manifest\` output), then \`rpc_call\` that chain — \`eth_blockNumber\` for the true chain head, or \`eth_getBlockByNumber\` at the deployment's \`latestBlock\` — and compare the TRUE chain head against graph-node's \`chainHead\` / \`latestBlock\` from \`get_deployment_health\`. A large gap means graph-node is genuinely behind the chain or its block cache is stale (the role the old \`check_blocks\` step played).
- **Health = \`unhealthy\`, no fatalError** — non-fatal error in the latest block; check whether it's transient. May self-heal.
- **Health = \`failed\`, deterministic fatalError** — schema/handler bug. Recovery typically requires rewind to before the bad block and a deploy of a fixed version. Cross-verify failure block with peers from \`get_deployment_allocations\`.
- **Health = \`failed\`, non-deterministic fatalError** — RPC reorg / chain cache corruption / OOM. Often recoverable in place via restart + cache clear + rewind.

## Step 3 — Cross-reference

For \`failed\` cases, use \`rpc_call\` (\`eth_getBlockByNumber\` at the suspected failure block, on the deployment's chain — discover the chain alias via \`list_rpc_chains\`) and compare the canonical block hash returned to graph-node's view and to peer indexers' POIs from \`get_deployment_allocations\`. A mismatch indicates the local block cache diverges from the canonical chain. Note: the actual fix — truncating the chain cache at that block before a rewind can succeed — is an **operator-manual** \`graphman chain truncate\` step on the graph-node host (no MCP tool).

If the deployment was recently upgraded (compare current deployment_id to historic versions from \`get_all_signalled_deployments\`), suspect a schema-incompatible upgrade.

## Step 4 — Check operational impact

- Is the indexer currently allocated to this deployment? Cross-reference \`get_indexer_allocations\` with deployment ${deploymentId}.
- If allocated, this becomes a §4.2 closability question — flag for inclusion in the next \`pre_epoch_health_check\` run.

## Step 5 — Recommend

Produce a markdown report with sections:

1. **Diagnosis** — health/sync state, failure mode classification, evidence.
2. **Operational impact** — allocation status, time-to-epoch-flip exposure.
3. **Recommended remediation** — one of:
   - "wait" (transient, will self-heal),
   - "operator review" (ambiguous, needs human),
   - "invoke \`recover_failed_deployment\` with deployment_id=${deploymentId}" (clear graphman recovery path),
   - "drop and resync" (data loss — operator-manual \`graphman drop\` on the graph-node host; no MCP tool; irreversible),
   - "close allocation before epoch flip" (when applicable).
4. **Risk and reversibility notes** — explicit callout when destructive tools are involved.

**This prompt is read-only.** Do NOT call any mutation tool — the live ones today are \`graphman_pause_deployment\`, \`graphman_resume_deployment\`, \`graphman_restart_deployment\`, \`queue_unallocate\`, and \`set_indexing_rule\` — from this prompt. (The diagnostic tools used above, including \`rpc_call\`, \`list_rpc_chains\`, and \`get_subgraph_manifest\`, are read-only and fine to call.) Operator-manual \`graphman\` subcommands such as rewind, drop, chain truncate, and clear call-cache have no MCP tool and are never invoked from here regardless. Present the diagnosis + plan, then let the operator (or the follow-up prompt) execute.
`;
      return {
        description: `Investigate unhealthy deployment ${deploymentId}.`,
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  });
}
