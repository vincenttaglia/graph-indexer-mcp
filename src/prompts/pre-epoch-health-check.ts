/**
 * Prompt: `pre_epoch_health_check`
 *
 * Implements the design §4.2 workflow: classify every active allocation
 * as Path A closable (healthy at epoch start), Path B closable (verifiable
 * deterministic failure), or not safely closable, then queue closes for
 * the closables before the epoch boundary flips.
 *
 * PRIMARY PATH recommends the Stage 3 composite tool `run_health_check`
 * which produces the same plan in one call. The Stage 1 step-by-step
 * walkthrough is preserved as the ALTERNATIVE PATH for debugging /
 * manual override of individual classifications.
 *
 * Timing is load-bearing — Path A depends on health AT THE EPOCH-START
 * BLOCK, which the next flip will invalidate. The prompt instructs Claude
 * to compute hours-remaining first and prioritize work accordingly.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerPrompt } from '../server/register.js';

export function registerPreEpochHealthCheckPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'pre_epoch_health_check',
    description:
      'Guide through the pre-epoch-flip allocation health check (design §4.2): classify each active allocation as Path A / Path B / not-closable and queue closes for the closables.',
    handler: () => {
      const text = `# Pre-Epoch Health Check (design §4.2)

Goal: before the next epoch boundary flips, classify every active allocation as Path A closable, Path B closable, or not-closable, then queue closes for the closables.

Why this is time-sensitive: Path A closability depends on the subgraph being healthy at the CURRENT epoch-start block. Once the epoch flips, the reference block changes — a subgraph that crashed mid-epoch is closable now but won't be closable after the flip.

## PRIMARY PATH — composite tool

Call \`run_health_check\` (optional args: \`indexer_address\`, \`urgency_threshold_hours\` defaulting to 6). It returns a \`HealthCheckResult\` with:

- \`timing\` — currentEpoch, hoursUntilNextEpoch, epochLengthBlocks, currentBlock. Use \`hoursUntilNextEpoch\` to decide urgency BEFORE doing anything else.
- \`allocations\` — per-allocation closability classification (allocationId, deploymentId, allocatedTokens, health, synced, latestBlock, epochStartBlock, closability ('A' | 'B' | 'none'), closabilityReason, fatalErrorDeterministic, lastHealthyBlock, fatalErrorBlock, statusMissing).
  - \`statusMissing: boolean\` — true when graph-node has no indexing-status row for this deployment (deployment isn't assigned to the indexer's graph-node, or hasn't started indexing). When true, \`health: 'failed'\` is the type-forced default and should NOT be interpreted as a real failure. Surface these allocations to the operator as a separate "needs investigation" bucket — typically the fix is operator-side: assign the deployment to the node, or remove the allocation if intentionally retired. These rows do NOT appear in \`recoveryPlan\` (a graphman recovery would be the wrong action).
- \`risk\` — per-allocation RiskAssessment with level ('low' | 'medium' | 'high' | 'critical') and reasons.
- \`closePlan\` — closable AND worth-closing-now entries (allocationId, deploymentId, path, poiBlock?, reason). This is the operator-facing table.
- \`blockedFromClose\` — unhealthy/failed allocations that can't be safely closed this epoch (surface as operator-review table).
- \`recoveryPlan\` — graphman recovery recommendations for failed deployments (type: 'restart' | 'rewind' | 'check_blocks' | 'clear_call_cache' | 'manual_review', with deploymentId, rationale, args). Of these, only \`restart\` has a live MCP tool (\`graphman_restart_deployment\`); \`rewind\`, \`check_blocks\`, and \`clear_call_cache\` recoveries are **currently operator-manual** \`graphman\` subcommands on the graph-node host (the kubectl-exec path was removed). Surface them in the plan as manual steps, not as tool calls.
- \`warnings\` and \`errors\` — surface prominently.

Present \`closePlan\` and \`blockedFromClose\` as markdown tables and summarize timing + counts. **STOP HERE. Wait for explicit operator approval before executing any \`queue_unallocate\` for closePlan entries, OR any recovery from recoveryPlan** — noting that only \`restart\` recoveries map to a live tool (\`graphman_restart_deployment\`); \`rewind\` / \`check_blocks\` / \`clear_call_cache\` recoveries are operator-manual \`graphman\` subcommands on the host, not tool calls. \`approve_actions\` is always operator-gated.

The composite is plan-only; this prompt still walks the operator through execution after approval. If the composite returns blocking errors, or you need to debug an individual classification, fall back to the ALTERNATIVE PATH below.

## ALTERNATIVE PATH — constituent-tool walkthrough

Use this path when you need to inspect a single allocation's classification by hand, override the matrix decision, or debug the composite's output.

## Reference resources

- \`indexer://config\` — indexer address, agent endpoint.
- \`indexer://overview\` — cached infrastructure summary.
- \`indexer://glossary\` — definitions for "Path A", "Path B", "POI", "epoch-start block".

## Step 1 — Determine timing

Call in parallel:

- \`get_current_epoch\` — current epoch number and start block from the EBO subgraph.
- \`get_epoch_blocks\` — epoch-start blocks for each chain the indexer serves.
- \`get_epoch_time_remaining\` — hours/blocks remaining until the next flip.
- \`get_network_parameters\` — epoch length and current network head.

If \`get_epoch_time_remaining\` reports less than ~2 hours, treat every step below as urgent and skip non-essential analysis.

## Step 2 — Enumerate active allocations

Call \`get_indexer_allocations\` for the indexer in \`indexer://config\` (status = active). For each allocation, record: deployment id, allocated GRT, allocation age, chain id.

## Step 3 — Classify each allocation

For every active allocation, call \`get_deployment_health\` (graph-node) and \`get_deployment_allocations\` (network subgraph, to cross-reference with other indexers). Then apply the design §4.2 decision matrix:

| Health   | Subgraph head vs epoch start | Error type        | Closable?            | Action                                     |
|----------|------------------------------|-------------------|----------------------|--------------------------------------------|
| healthy  | above                        | n/a               | Path A YES           | Close only if rebalancing (skip here)      |
| healthy  | below (still syncing)        | n/a               | NO (not at block yet)| Wait; monitor sync progress                |
| unhealthy| above                        | non-fatal         | Path A YES           | Queue close BEFORE epoch flip              |
| unhealthy| below                        | non-fatal         | NO                   | Alert operator — cannot generate valid POI |
| failed   | above (was above pre-fail)   | deterministic     | Path B YES           | Verify failure block with other indexers   |
| failed   | above (was above pre-fail)   | non-deterministic | Path A YES (if healthy at epoch start) | Close with epoch-start POI       |
| failed   | below                        | deterministic     | Path B YES           | Verify failure block with other indexers   |
| failed   | below                        | non-deterministic | NO                   | Operator review — cannot safely close      |

For Path B candidates with a deterministic fatalError, use \`rpc_call\` (\`eth_getBlockByNumber\` at the suspected failure block on the deployment's chain — discover chain aliases via \`list_rpc_chains\`) to compare the canonical block against graph-node's state, and corroborate with peer POIs from \`get_deployment_allocations\`, before queueing the close.

## Step 4 — Assess urgency

For each closable allocation, compute a priority score:

- Higher allocation GRT -> higher priority.
- Closer to epoch boundary -> higher priority.
- Still-degrading subgraph (sync gap growing) -> higher priority.

Process Path A closes first (they expire at the flip). Path B closes can wait if the failure block is already well past.

## Step 5 — Build the close plan (do NOT queue yet)

For each closable allocation, draft a row in the close plan with deployment id, allocated GRT, path (A/B), and a one-line reason citing the decision-matrix row that classified it. For each unhealthy-but-degrading allocation that is NOT closable, draft a row for operator review with a clear explanation of why (which row of the decision matrix it matches).

For Path A closables flagged as "healthy but stale RPC", use \`rpc_call\` (\`eth_blockNumber\` on the deployment's chain — discover aliases via \`list_rpc_chains\`) to get the true chain head and compare it against graph-node's reported head, before deciding whether to include them in the close plan.

For post-close failed deployments, recommend (but do NOT auto-invoke) the \`recover_failed_deployment\` prompt for follow-up. Of the graphman recovery steps, only \`graphman_restart_deployment\` is a live MCP tool; \`graphman rewind\` and \`graphman clear call-cache\` are operator-manual subcommands on the graph-node host.

## Step 6 — Output the plan and STOP

Produce two (or three) markdown tables:

1. **Close plan (pending operator approval)** — deployment_id, allocated_grt, path (A/B), reason. Leave a \`queued_action_id\` column blank; it will be filled in only after queueing.
2. **Operator review** — deployment_id, allocated_grt, health, sync_gap, status_missing, why-not-closable. Include a \`status_missing\` column so the operator can tell at a glance which rows have no graph-node indexing-status (where the right action is "assign or remove allocation", not "recover").
3. **Needs investigation (status missing)** — OPTIONAL separate table when any allocation has \`statusMissing: true\`: deployment_id, allocated_grt, suggested_action ("assign deployment to graph-node" or "remove allocation if intentionally retired"). Do NOT recommend graphman recovery for these rows — they will not appear in \`recoveryPlan\` for that reason.

Below the tables, summarize: time-to-flip, total GRT proposed to close this epoch, count by path, count requiring operator review, count with \`statusMissing\`.

**STOP HERE.** Present the close plan as a table and wait for the operator to explicitly say "proceed", "queue these", or otherwise approve the plan. Do NOT call \`queue_unallocate\` until the operator approves. Do NOT call \`approve_actions\` — that is always operator-gated.

## Step 7 — Queue after explicit operator approval

Only after the operator has explicitly approved the close plan above, call \`queue_unallocate\` one allocation at a time, in the priority order from Step 4. For each call, report the returned action ID and a brief result (success / error message) before moving to the next allocation. If any \`queue_unallocate\` call fails, stop and surface the error to the operator before continuing with the remaining allocations.
`;
      return {
        description: 'Pre-epoch allocation health check.',
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
