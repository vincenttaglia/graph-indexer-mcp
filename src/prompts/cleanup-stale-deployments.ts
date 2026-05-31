/**
 * Prompt: `cleanup_stale_deployments`
 *
 * Implements the design §4.3 cleanup half. The PRIMARY PATH calls the
 * Stage 3 composite tool `run_discovery` which produces pre-ordered
 * cleanup step sequences for every stale deployment. The Stage 1
 * step-by-step walkthrough is preserved as the ALTERNATIVE PATH for
 * debugging / overriding the staleness filter.
 *
 * Removal collapses to: close any remaining allocations, then a single
 * `graphman_drop_deployment` (`deleteDeployment`) call — which auto-unassigns
 * and force-deletes the indexed data, so the old unassign + "unused"
 * record/remove garbage-collection sequence is gone (those ops are
 * intentionally not exposed). `graphman_pause_deployment` and
 * `set_indexing_rule decisionBasis=never` remain as non-deletion options.
 * `graphman_drop_deployment` is irreversible and always operator-initiated —
 * never invoked from a composite plan without an explicit, deployment-named
 * operator request.
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

> **Tooling note:** all the tools in this workflow are live MCP tools over the graphman GraphQL API — no kubectl, no host-manual steps: \`queue_unallocate\`, \`graphman_pause_deployment\`, \`set_indexing_rule\`, \`graphman_drop_deployment\`, and the read-only \`graphman_deployment_info\`. **Deletion is a single op now:** \`graphman_drop_deployment\` (GraphQL \`deleteDeployment\`, \`confirm: true\`) **auto-unassigns and force-deletes the indexed data** in one call. The old multi-step garbage-collection flow (separate unassign -> "unused record" -> "unused remove" -> drop) is gone — \`graphman_unused_record\` / \`graphman_unused_remove\` are **intentionally not exposed**; do not reference them. A \`Qm\` hash matching multiple deployments makes \`graphman_drop_deployment\` error unless you pass \`all=true\` — it returns the locators so the operator can disambiguate, then re-confirm with \`all=true\`. \`graphman_pause_deployment\` and \`set_indexing_rule decisionBasis=never\` remain as **non-deletion** options (stop indexing / stop future allocation, keep the data).

## PRIMARY PATH — composite tool

Call \`run_discovery\` with the required arg:

- \`typical_allocation_grt\` — GRT decimal. Reasonable default: \`total_stake_grt / max_allocations\` from \`get_infrastructure_overview\` / \`indexer://config\`.

Optional: \`indexer_address\`, \`max_candidates\`, \`min_signal_grt\`.

The cleanup-relevant fields in \`DiscoveryResult\` are:

- \`stale\` — \`{deploymentId, reason: 'no_signal' | 'unallocated' | 'superseded' | 'orphaned', sizeBytes, paused, hasAllocation, isFrozen}\`. Frozen entries are auto-skipped here but surface them so the operator can see what was excluded.
- \`cleanup\` — pre-ordered \`{deploymentId, steps: ('close_allocation' | 'pause' | 'unassign' | 'unused_record' | 'unused_remove')[], rationale}\` per stale deployment. The step order encodes the safe-removal sequence — DO NOT reorder.

Map cleanup steps to tools:

\`run_discovery\` still EMITS the legacy step types (\`unassign\`, \`unused_record\`, \`unused_remove\`) from the old garbage-collection flow, but those ops are no longer exposed. The table below maps each emitted step to how it is actually executed now. The key change: **the whole \`unassign\` -> \`unused_record\` -> \`unused_remove\` tail collapses into one \`graphman_drop_deployment\` call** (which auto-unassigns + force-deletes).

| Composite step | Tool / execution |
|---|---|
| \`close_allocation\` | \`queue_unallocate\` (wait for close before next step) |
| \`pause\` | \`graphman_pause_deployment\` (non-deletion option — keeps data) |
| \`unassign\` | If deletion is intended: **skip** — folded into \`graphman_drop_deployment\` (it auto-unassigns). (There is no standalone-unassign-as-cleanup tool surfaced here.) |
| \`unused_record\` | **Skipped** — this GC step no longer exists; deletion is handled by \`graphman_drop_deployment\`. |
| \`unused_remove\` | Mapped to a single \`graphman_drop_deployment\` (\`deleteDeployment\`, \`confirm: true\`, \`all=true\` if the hash multi-matches) — the actual disk-reclaiming deletion. |

So a composite plan whose steps are \`close_allocation -> pause -> unassign -> unused_record -> unused_remove\` executes as: \`queue_unallocate\` (wait for close) -> \`graphman_drop_deployment\` (one confirm-gated call that unassigns + deletes). \`pause\` only runs if the operator wants to stop indexing WITHOUT deleting.

Note: \`run_discovery\` deliberately does NOT itself recommend \`graphman_drop_deployment\` in its cleanup steps — but \`unused_remove\` IS the deletion intent, and deletion is now exclusively \`graphman_drop_deployment\`. Drop is irreversible and operator-initiated only — never execute it without an explicit, separate operator request that names the deployment.

Present \`stale\` + \`cleanup\` as a markdown table (deployment_id, reason, paused, hasAllocation, isFrozen, sizeBytes, planned_steps, rationale) with the totals from Step 4 below. **STOP. Wait for explicit operator approval before executing any step via the mapped tools above.** Per-deployment confirmation is required when \`dry_run = false\`.

If the composite returns blocking errors, or you need to override the staleness filter / inspect signal+volume by hand, fall back to the ALTERNATIVE PATH below.

## ALTERNATIVE PATH — constituent-tool walkthrough

Use this path when you need to gather staleness signals manually, override the cleanup ordering, or debug a composite-suggested step.

## Reference resources

- \`indexer://config\` — indexer address, frozenlist (never remove these), graphman endpoint.
- \`indexer://overview\` — current disk usage / sync footprint. \`get_infrastructure_overview\` returns the same payload for tool-only clients.
- \`indexer://glossary\` — definitions for "drop" (deleteDeployment), "unassign", "frozen".

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

For each candidate, build the per-deployment plan based on its current state. All steps are live MCP tools over the graphman GraphQL API. Deletion is always a single \`graphman_drop_deployment\` (\`deleteDeployment\`, \`confirm: true\`) — it auto-unassigns and force-deletes, so there is no separate unassign / "unused" reaping step.

| State                                  | Sequence                                                                                                    |
|----------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Allocated + syncing                    | \`queue_unallocate\` -> wait for close -> proceed                                                             |
| Synced, unallocated, low signal — KEEP data | \`graphman_pause_deployment\` (stop indexing) and/or \`set_indexing_rule decisionBasis=never\` (stop future allocation). No deletion. |
| Synced, unallocated, low signal — DELETE | \`graphman_drop_deployment\` (\`confirm: true\`; auto-unassigns + force-deletes; \`all=true\` only if the hash multi-matches) |
| Already paused + unassigned — DELETE   | \`graphman_drop_deployment\` (\`confirm: true\`) — single call reclaims the disk                              |
| Hard removal (superseded + zero usage) | Close allocation if any (\`queue_unallocate\`, wait), then \`graphman_drop_deployment\` (IRREVERSIBLE — operator explicit confirmation per drop) |
| Frozenlist                             | SKIP — never touch.                                                                                         |

For an indexing-rule deactivation (rather than deletion), use \`set_indexing_rule\` with \`decisionBasis = 'never'\` so the agent stops considering it for future allocation; pair with \`graphman_pause_deployment\` to also stop indexing. Both keep the data — use \`graphman_drop_deployment\` only when the disk should actually be reclaimed.

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
  ? '**Stop here.** Do NOT call any mutating tool — \`queue_unallocate\`, \`graphman_pause_deployment\`, \`set_indexing_rule\`, or \`graphman_drop_deployment\`. Present the plan to the operator and wait for explicit approval. If approved, the operator will re-invoke with `dry_run=false`.'
  : 'Process candidates one at a time. For each candidate, present its sequence and ask for operator confirmation BEFORE executing the first mutating step. Execute via live tools: \`queue_unallocate\` (wait for close), \`graphman_pause_deployment\` / \`set_indexing_rule decisionBasis=never\` (non-deletion), and \`graphman_drop_deployment\` (\`confirm: true\`) for actual deletion — it auto-unassigns + force-deletes, so there is no separate unassign or "unused" step. After each step, verify via \`graphman_deployment_info\` and \`get_indexing_statuses\` before proceeding. STOP and escalate on any unexpected result. Never batch-execute \`graphman_drop_deployment\` — each drop is irreversible and requires a fresh, deployment-named confirmation; if a drop returns multiple locators (hash multi-match), surface them and re-confirm before retrying with \`all=true\`.'}
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
