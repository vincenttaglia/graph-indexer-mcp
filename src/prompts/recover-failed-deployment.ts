/**
 * Prompt: `recover_failed_deployment`
 *
 * Drives a graphman-based recovery for a specific failed deployment.
 * Required arg: `deployment_id`. The prompt always produces a plan first
 * and only invokes destructive graphman tools with explicit operator
 * confirmation.
 *
 * NOTE: all graphman recovery tools (restart, rewind, reassign, unassign,
 * drop, check-blocks, truncate chain cache, clear call cache) are LIVE MCP
 * tools backed by the graphman GraphQL API — no kubectl, no host-manual steps.
 * `graphman_rewind_deployment` and `graphman_check_blocks` (by_range) are async
 * (poll `graphman_get_execution_status`). `graphman_drop_deployment`
 * (`deleteDeployment`) auto-unassigns and force-deletes data in one call, so it
 * is the sole deletion path; the graphman `unused` record/remove flow is
 * intentionally not exposed.
 *
 * The auto-heal knowledge base is not yet implemented; the prompt notes this
 * future integration point per the design doc but does not reference any tool
 * that doesn't exist.
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

> **Tooling note:** all graphman recovery ops are **live MCP tools** backed by the graphman GraphQL API — no kubectl, no host-manual steps: \`graphman_deployment_info\`, \`graphman_pause_deployment\`, \`graphman_resume_deployment\`, \`graphman_restart_deployment\`, \`graphman_get_execution_status\`, \`graphman_rewind_deployment\`, \`graphman_reassign_deployment\`, \`graphman_unassign_deployment\`, \`graphman_drop_deployment\`, \`graphman_check_blocks\`, \`graphman_truncate_chain_cache\`, and \`graphman_clear_call_cache\`. Two are **async** — \`graphman_rewind_deployment\` and \`graphman_check_blocks\` with \`by_range\` return an \`execution_id\`; poll \`graphman_get_execution_status\` until \`SUCCEEDED\`/\`FAILED\`. The destructive ops (rewind, unassign, drop, truncate-chain-cache, clear-call-cache) each require \`confirm: true\` AND explicit operator approval. \`graphman_drop_deployment\` (\`deleteDeployment\`) **auto-unassigns and force-deletes the data in one call** — it is the sole deletion path; the graphman \`unused\` record/remove flow is intentionally not exposed.

## Optionally — try the composite first

Call \`run_health_check\` first. If deployment \`${deploymentId}\` shows up in the \`recoveryPlan\` array, the composite has already classified the failure with a concrete \`type\` ('restart' | 'rewind' | 'check_blocks' | 'clear_call_cache' | 'manual_review'), a \`rationale\`, and the exact \`args\` to pass to the corresponding graphman_* tool. That saves classification work and gives you a vetted starting point for the plan below. **All operator-approval gates in this prompt still apply** — the composite is plan-only; you still produce the full plan, get explicit confirmation, and execute step-by-step with verification between steps.

## Reference resources

- \`indexer://config\` — indexer address, graphman endpoint.
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

All tools below are live MCP tools. Async ops (\`graphman_rewind_deployment\`, \`graphman_check_blocks\` by_range) return an \`execution_id\` to poll with \`graphman_get_execution_status\`. Destructive ops require \`confirm: true\`.

| Symptom                                            | Likely fix                                                      | Tool(s)                                                                |
|----------------------------------------------------|-----------------------------------------------------------------|------------------------------------------------------------------------|
| Stuck/crashed worker but no fatalError             | Restart                                                         | \`graphman_restart_deployment\`                                          |
| Non-deterministic fatalError (RPC reorg, OOM)      | Restart, then if persists: rewind a few blocks                  | \`graphman_restart_deployment\`, then \`graphman_rewind_deployment\` (async, confirm) |
| Block cache disagrees with chain head              | Truncate chain cache, then restart                              | \`graphman_truncate_chain_cache\` (confirm), then \`graphman_restart_deployment\` |
| Bad cached eth_call results                        | Clear call cache, then restart                                  | \`graphman_clear_call_cache\` (confirm; pick a mode), then \`graphman_restart_deployment\` |
| Deterministic fatalError at known block            | Rewind to block-1, requires fixed subgraph version pre-deployed | \`graphman_rewind_deployment\` (async, confirm)                          |
| Unrecoverable / data corruption                    | Drop and resync (data loss)                                     | \`graphman_drop_deployment\` (last resort, irreversible, confirm)        |
| Active allocation will block rewind                | Close allocation first                                          | \`queue_unallocate\` (then operator must approve agent action)           |

For deterministic failures, run \`graphman_check_blocks\` (\`by_number\` at the failure block, or \`by_range\` around it — note \`by_range\` is async) to confirm whether the local cache diverges from the canonical chain. It deletes any diverging cache entries it finds (re-fetchable); if it reports divergence, consider \`graphman_truncate_chain_cache\` (confirm) before the rewind.

## Step 3 — Plan the recovery sequence

Pick the **least destructive** path that addresses the symptom. Order operations from safest to most invasive:

1. \`graphman_pause_deployment\` (safe — stop indexing while we work).
2. Cache hygiene: \`graphman_clear_call_cache\` and/or \`graphman_truncate_chain_cache\` (both confirm-gated; when block-cache disagreement is suspected — \`graphman_check_blocks\` first to confirm).
3. \`graphman_rewind_deployment\` (async, confirm) to a block before the failure (destructive — discards entity-state past the rewind block; poll \`graphman_get_execution_status\`).
4. \`graphman_restart_deployment\` (idempotent).
5. \`graphman_resume_deployment\` to re-enable indexing.

For non-deterministic failures, often just steps 1 -> 4 -> 5 is enough.

For drop-and-resync, a single \`graphman_drop_deployment\` call (\`deleteDeployment\`, confirm) **auto-unassigns and force-deletes all indexed data** — you do NOT need to pre-sequence unassign or any "unused" reaping (that flow is not exposed). It is **irreversible**; require explicit operator confirmation. If a \`Qm\` hash matches multiple deployments, the call returns the locators and errors unless you pass \`all=true\` — surface the locators and re-confirm before retrying with \`all=true\`. Resync then proceeds by re-deploying the (fixed) subgraph version.

If the indexer has an active allocation to ${deploymentId} (per \`get_indexer_allocations\`), close it first via \`queue_unallocate\` to avoid POI complications during rewind.

## Step 4 — Present the plan

Produce a numbered recovery plan with: step #, tool name, exact args, expected effect, reversibility, risk note.

**Stop and ask the operator to confirm.** Note any steps that are irreversible (rewind, drop, truncate chain cache) and that they require \`confirm: true\`.

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
