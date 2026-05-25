/**
 * Prompt: `cleanup_stale_deployments`
 *
 * Implements the design §4.3 cleanup half. Identifies deployments the
 * indexer is syncing that no longer warrant disk + RPC budget, then
 * walks Claude through the safe-removal sequence: close any remaining
 * allocations, pause, unassign, unused record/remove, or full drop.
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

## Reference resources

- \`indexer://config\` — indexer address, frozenlist (never remove these), graphman endpoint.
- \`indexer://overview\` — current disk usage / sync footprint.
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
