/**
 * Prompt: `cleanup_stale_deployments`
 *
 * Implements the design §4.3 cleanup half. The PRIMARY PATH calls the
 * Stage 3 composite tool `run_discovery` which produces pre-ordered
 * cleanup step sequences for every stale deployment. The Stage 1
 * step-by-step walkthrough is preserved as the ALTERNATIVE PATH for
 * debugging / overriding the staleness filter. Either path culminates
 * in the safe-removal sequence: close any remaining allocations, pause,
 * unassign, unused record/remove. `graphman_drop_deployment` is
 * always operator-initiated — never invoked from a composite plan.
 *
 * `dry_run` defaults to true. When true, only a plan is produced and no
 * destructive graphman tool is invoked. When false, the operator has
 * explicitly opted into per-step confirmation for irreversible ops.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerPrompt } from '../server/register.js';

const argsSchema = {
  dry_run: z.coerce.boolean().default(true),
};

export function registerCleanupStaleDeploymentsPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'cleanup_stale_deployments',
    description:
      'Guide through identifying and removing stale deployments (design §4.3 cleanup half) via graphman. dry_run=true produces a plan only.',
    argsSchema,
    handler: (args) => {
      const dryRun = args.dry_run;
      const text = `# Cleanup Stale Deployments (design §4.3 — cleanup half)

Goal: identify deployments the indexer is syncing that are no longer worth the disk + RPC budget, then walk through the safe-removal sequence.

Mode: ${dryRun ? '**dry_run = true** — produce a plan only; do NOT invoke any graphman destructive tool.' : '**dry_run = false** — operator has opted into per-step confirmation; each destructive op requires explicit go-ahead.'}

## PRIMARY PATH — composite tool

Call \`run_discovery\` with **required** args:

- \`blocks_per_year\` — Ethereum mainnet ~2,628,000; Arbitrum One ~10,512,000 at 3s block time. (Discovery shares this entry point with new-subgraph discovery — needed for APR projection on the opportunity half. Cleanup uses the response regardless.)
- \`typical_allocation_grt\` — GRT decimal. Reasonable default: \`total_stake_grt / max_allocations\` from \`get_infrastructure_overview\` / \`indexer://config\`.

Optional: \`indexer_address\`, \`max_candidates\`, \`min_signal_grt\`.

The cleanup-relevant fields in \`DiscoveryResult\` are:

- \`stale\` — \`{deploymentId, reason: 'no_signal' | 'unallocated' | 'superseded' | 'orphaned', sizeBytes, paused, hasAllocation, isFrozen}\`. Frozen entries are auto-skipped here but surface them so the operator can see what was excluded.
- \`cleanup\` — pre-ordered \`{deploymentId, steps: ('close_allocation' | 'pause' | 'unassign' | 'unused_record' | 'unused_remove')[], rationale}\` per stale deployment. The step order encodes the safe-removal sequence — DO NOT reorder.

Map cleanup steps to tools:

| Composite step | Tool |
|---|---|
| \`close_allocation\` | \`queue_unallocate\` (wait for close before next step) |
| \`pause\` | \`graphman_pause_deployment\` |
| \`unassign\` | \`graphman_unassign_deployment\` |
| \`unused_record\` | \`graphman_unused_record\` |
| \`unused_remove\` | \`graphman_unused_remove\` |

Note: \`run_discovery\` deliberately does NOT recommend \`graphman_drop_deployment\` in its cleanup steps. Drop is irreversible and operator-initiated only — never invoke from a composite-derived plan without an explicit, separate operator request that names the deployment.

Present \`stale\` + \`cleanup\` as a markdown table (deployment_id, reason, paused, hasAllocation, isFrozen, sizeBytes, planned_steps, rationale) with the totals from Step 4 below. **STOP. Wait for explicit operator approval before executing any step via the mapped tools above.** Per-deployment confirmation is required when \`dry_run = false\`.

If the composite returns blocking errors, or you need to override the staleness filter / inspect signal+volume by hand, fall back to the ALTERNATIVE PATH below.

## ALTERNATIVE PATH — constituent-tool walkthrough

Use this path when you need to gather staleness signals manually, override the cleanup ordering, or debug a composite-suggested step.

## Reference resources

- \`indexer://config\` — indexer address, frozenlist (never remove these), graphman endpoint.
- \`indexer://overview\` — current disk usage / sync footprint. \`get_infrastructure_overview\` returns the same payload for tool-only clients.
- \`indexer://glossary\` — definitions for "unused", "drop", "unassign", "frozen".

## Step 1 — Enumerate current sync footprint

Call in parallel:

- \`get_indexing_statuses\` — every deployment the indexer is syncing.
- \`get_indexing_rules\` — operator's declared intent per deployment.
- \`get_indexer_allocations\` — which of these are actively allocated (allocated = NOT removable until close).
- \`get_all_subgraph_sizes\` — disk usage per deployment (cleanup prioritization signal).

## Step 2 — Score each deployment for staleness

For every synced deployment, gather the staleness signals:

- \`get_deployment_signal\` — current curation signal. Zero or near-zero signal is a strong cleanup signal.
- \`get_query_volume\` — recent QoS volume. Zero queries for an extended period is another strong signal.
- \`graphman_deployment_info\` — paused state, node assignment.
- \`get_subgraph_size\` — confirm disk footprint per candidate.

Cross-check against \`get_all_signalled_deployments\` to detect upgrades — if the same subgraph has a newer deployment hash now carrying the signal, the older version is a prime cleanup target.

A deployment is a cleanup candidate when:

- Signal is below \`min_signal\` from \`indexer://config\`, AND
- Query volume is negligible (no rebates flowing), AND
- The deployment is NOT on \`frozenlist\`, AND
- (Optionally) the deployment is superseded by a newer version of the same subgraph.

## Step 3 — Determine the safe-removal sequence

For each candidate, build the per-deployment plan based on its current state:

| State                                  | Sequence                                                                                                    |
|----------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Allocated + syncing                    | \`queue_unallocate\` -> wait for close -> proceed                                                             |
| Synced, unallocated, low signal        | \`graphman_pause_deployment\` -> \`graphman_unassign_deployment\` -> \`graphman_unused_record\` -> \`graphman_unused_remove\` |
| Already paused + unassigned            | \`graphman_unused_record\` -> \`graphman_unused_remove\`                                                       |
| Hard removal (superseded + zero usage) | All of the above, then \`graphman_drop_deployment\` (IRREVERSIBLE — operator explicit confirmation per drop) |
| Frozenlist                             | SKIP — never touch.                                                                                         |

For an indexing-rule deactivation (rather than node removal), use \`set_indexing_rule\` with \`decisionBasis = 'never'\` so the agent stops considering it for future allocation.

## Step 4 — Estimate reclaim

For each candidate, sum the disk freed from \`get_subgraph_size\` / \`get_all_subgraph_sizes\`. Surface total estimated reclaim across the cleanup batch.

## Step 5 — Output

Produce a markdown table with columns: deployment_id, current_state, signal_grt, query_volume_30d, disk_gb, planned_sequence (numbered tool calls), reversibility.

Below the table:

- Total disk to reclaim.
- Count of allocations that must close first.
- Count of irreversible drops (highlight prominently).
- Anything skipped because it's on \`frozenlist\`.

${dryRun
  ? '**Stop here.** Do NOT call \`graphman_pause_deployment\`, \`graphman_unassign_deployment\`, \`graphman_unused_record\`, \`graphman_unused_remove\`, \`graphman_drop_deployment\`, \`queue_unallocate\`, or \`set_indexing_rule\`. Present the plan to the operator and wait for explicit approval. If approved, the operator will re-invoke with `dry_run=false`.'
  : 'Process candidates one at a time. For each candidate, present its sequence and ask for operator confirmation BEFORE executing the first destructive step. After each tool call, verify via \`graphman_deployment_info\` and \`get_indexing_statuses\` before proceeding. STOP and escalate on any unexpected result. Never batch-execute \`graphman_drop_deployment\` — each drop requires a fresh confirmation.'}
`;
      return {
        description: `Cleanup stale deployments (dry_run=${dryRun}).`,
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
