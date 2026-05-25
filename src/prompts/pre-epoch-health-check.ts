/**
 * Prompt: `pre_epoch_health_check`
 *
 * Implements the design §4.2 workflow: classify every active allocation
 * as Path A closable (healthy at epoch start), Path B closable (verifiable
 * deterministic failure), or not safely closable, then queue closes for
 * the closables before the epoch boundary flips.
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

For Path B candidates with a deterministic fatalError, call \`graphman_check_blocks\` to corroborate the failure block before queueing the close.

## Step 4 — Assess urgency

For each closable allocation, compute a priority score:

- Higher allocation GRT -> higher priority.
- Closer to epoch boundary -> higher priority.
- Still-degrading subgraph (sync gap growing) -> higher priority.

Process Path A closes first (they expire at the flip). Path B closes can wait if the failure block is already well past.

## Step 5 — Build the close plan (do NOT queue yet)

For each closable allocation, draft a row in the close plan with deployment id, allocated GRT, path (A/B), and a one-line reason citing the decision-matrix row that classified it. For each unhealthy-but-degrading allocation that is NOT closable, draft a row for operator review with a clear explanation of why (which row of the decision matrix it matches).

For Path A closables flagged as "healthy but stale RPC", call \`graphman_check_blocks\` to diagnose before deciding whether to include them in the close plan.

For post-close failed deployments, recommend (but do NOT auto-invoke) the \`recover_failed_deployment\` prompt for follow-up via graphman_restart_deployment / graphman_rewind_deployment / graphman_clear_call_cache.

## Step 6 — Output the plan and STOP

Produce two markdown tables:

1. **Close plan (pending operator approval)** — deployment_id, allocated_grt, path (A/B), reason. Leave a \`queued_action_id\` column blank; it will be filled in only after queueing.
2. **Operator review** — deployment_id, allocated_grt, health, sync_gap, why-not-closable.

Below the tables, summarize: time-to-flip, total GRT proposed to close this epoch, count by path, count requiring operator review.

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
