/**
 * Prompt: `recover_failed_deployment`
 *
 * Drives a graphman-based recovery for a specific failed deployment.
 * Required arg: `deployment_id`. The prompt always produces a plan first
 * and only invokes destructive graphman tools (rewind, truncate, drop)
 * with explicit operator confirmation. The auto-heal knowledge base is
 * not yet implemented; the prompt notes this future integration point
 * per the design doc but does not reference any tool that doesn't exist.
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

export function registerRecoverFailedDeploymentPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'recover_failed_deployment',
    description:
      'Guide through diagnosing and recovering a failed deployment via graphman (restart, rewind, cache clear). Always produces a plan first; destructive operations require operator confirmation.',
    argsSchema,
    handler: (args) => {
      const deploymentId = args.deployment_id;
      const text = `# Recover Failed Deployment

Goal: walk through graphman-based recovery options for deployment \`${deploymentId}\` and queue (with operator approval) the least-destructive sequence that returns it to a healthy syncing state.

This prompt mixes diagnostic reads with potentially destructive graphman writes. **Always produce a recovery plan first and obtain explicit operator confirmation before invoking any destructive tool.**

## Optionally — try the composite first

Call \`run_health_check\` first. If deployment \`${deploymentId}\` shows up in the \`recoveryPlan\` array, the composite has already classified the failure with a concrete \`type\` ('restart' | 'rewind' | 'check_blocks' | 'clear_call_cache' | 'manual_review'), a \`rationale\`, and the exact \`args\` to pass to the corresponding graphman_* tool. That saves classification work and gives you a vetted starting point for the plan below. **All operator-approval gates in this prompt still apply** — the composite is plan-only; you still produce the full plan, get explicit confirmation, and execute step-by-step with verification between steps.

## Reference resources

- \`indexer://config\` — indexer address, graphman endpoint, kubectl context.
- \`indexer://overview\` — infrastructure summary.
- \`indexer://glossary\` — definitions for "rewind", "block cache", "call cache", "POI", "deterministic vs non-deterministic error".

## Step 1 — Confirm current state

Call in parallel:

- \`get_deployment_health\` with deployment ${deploymentId} — verify it is actually failed/unhealthy and capture the fatalError details.
- \`graphman_deployment_info\` with deployment ${deploymentId} — current node assignment, pause state, namespace, head block.
- \`get_deployment_allocations\` — peer indexers + their POIs around the failure block.
- \`get_indexer_allocations\` — does the indexer have an active allocation to this deployment?

If the deployment is healthy now, abort with a note and recommend \`investigate_unhealthy\` instead.

## Step 2 — Classify the failure for recovery selection

| Symptom                                            | Likely fix                                                      | Tool(s)                                                                |
|----------------------------------------------------|-----------------------------------------------------------------|------------------------------------------------------------------------|
| Stuck/crashed worker but no fatalError             | Restart                                                         | \`graphman_restart_deployment\`                                          |
| Non-deterministic fatalError (RPC reorg, OOM)      | Restart, then if persists: rewind a few blocks                  | \`graphman_restart_deployment\`, \`graphman_rewind_deployment\`            |
| Block cache disagrees with chain head              | Truncate chain cache, then restart                              | \`graphman_truncate_chain_cache\`, \`graphman_restart_deployment\`         |
| Bad cached eth_call results                        | Clear call cache, then restart                                  | \`graphman_clear_call_cache\`, \`graphman_restart_deployment\`             |
| Deterministic fatalError at known block            | Rewind to block-1, requires fixed subgraph version pre-deployed | \`graphman_rewind_deployment\`                                           |
| Unrecoverable / data corruption                    | Drop and resync (data loss)                                     | \`graphman_drop_deployment\` (last resort, irreversible)                 |
| Active allocation will block rewind                | Close allocation first                                          | \`queue_unallocate\` (then operator must approve agent action)           |

For deterministic failures, call \`graphman_check_blocks\` on the failure block to confirm whether the local cache disagrees with the canonical chain. If it does, prepend \`graphman_truncate_chain_cache\` to the recovery plan.

## Step 3 — Plan the recovery sequence

Pick the **least destructive** path that addresses the symptom. Order operations from safest to most invasive:

1. \`graphman_pause_deployment\` (safe — stop indexing while we work).
2. Cache hygiene: \`graphman_clear_call_cache\` and/or \`graphman_truncate_chain_cache\` (when block cache disagreement is suspected).
3. \`graphman_rewind_deployment\` to a block before the failure (destructive — discards entity-state past the rewind block).
4. \`graphman_restart_deployment\` (idempotent).
5. \`graphman_resume_deployment\` to re-enable indexing.

For non-deterministic failures, often just steps 1 -> 4 -> 5 is enough.

For drop-and-resync, also queue \`graphman_unassign_deployment\`, then \`graphman_unused_record\`, then \`graphman_unused_remove\`, and finally \`graphman_drop_deployment\`. **All four are irreversible — require operator confirmation for each.**

If the indexer has an active allocation to ${deploymentId} (per \`get_indexer_allocations\`), close it first via \`queue_unallocate\` to avoid POI complications during rewind.

## Step 4 — Present the plan

Produce a numbered recovery plan with: step #, tool name, exact args, expected effect, reversibility, risk note.

**Stop and ask the operator to confirm.** Note any steps that are irreversible (rewind, drop, unused remove, truncate chain cache).

## Step 5 — Execute (only after explicit confirmation)

Once confirmed, execute steps in order. After each step:

- Re-call \`get_deployment_health\` to verify the expected effect.
- If the deployment is healthy, stop early and skip remaining steps.
- If a step fails, surface the error and ask the operator how to proceed — do NOT auto-escalate to a more destructive step.

## Step 6 — Verify and report

After recovery, call \`get_deployment_health\`, \`graphman_deployment_info\`, and \`graphman_get_execution_status\` for the last graphman operation to confirm the final state. Report:

- Steps actually executed.
- Final health and lag.
- Any allocation closures that occurred.
- Recommended next checkpoint (e.g., "re-evaluate sync progress in 1h; if still degraded, escalate to operator").

Note: the design doc mentions a future auto-heal knowledge base — until that ships, the operator is the source of confidence ratings.
`;
      return {
        description: `Recover failed deployment ${deploymentId} via graphman.`,
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
