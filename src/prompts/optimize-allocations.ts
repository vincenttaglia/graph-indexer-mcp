/**
 * Prompt: `optimize_allocations`
 *
 * Walks Claude through the full allocation-optimization workflow described
 * in `graph-indexer-mcp-design.md` §4.1. The prompt recommends the Stage 3
 * composite tool `run_allocation_optimization` as the PRIMARY PATH and
 * keeps the Stage 1 constituent-tool walkthrough as an ALTERNATIVE PATH
 * for debugging / custom workflows. APR formula and per-deployment cap
 * rules from the design doc are spelled out in the alternative path so
 * Claude can verify the composite's output if needed.
 *
 * The `dry_run` arg defaults to true. When true, the prompt instructs
 * Claude to produce a plan only and wait for operator approval before
 * calling any `queue_*` mutation tool. When false, the operator has
 * explicitly opted into queuing actions on the Indexer Agent (still
 * subject to per-tool access-control via `registerIndexerTool`).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerPrompt } from '../server/register.js';

const argsSchema = {
  dry_run: z.coerce.boolean().default(true),
};

export function registerOptimizeAllocationsPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'optimize_allocations',
    description:
      'Guide through the full allocation optimization workflow (design §4.1): gather state, filter candidates, score by APR, and produce a rebalancing plan.',
    argsSchema,
    handler: (args) => {
      const dryRun = args.dry_run;
      const text = `# Allocation Optimization (design §4.1)

Goal: rebalance the indexer's stake across deployments to maximize indexing-reward APR while respecting per-deployment caps, the max-allocation count, and gas costs.

Mode: ${dryRun ? '**dry_run = true** — produce a plan only; do NOT call any queue_* tool until the operator approves.' : '**dry_run = false** — operator has opted into queuing actions on the Indexer Agent after producing the plan.'}

## PRIMARY PATH — composite tool

Call \`run_allocation_optimization\`. Optional overrides: \`indexer_address\`, \`max_allocations\`, \`max_allocation_pct\`, \`risky_deployment_cap_pct\`, \`min_signal_grt\`, \`gas_estimate_grt\`, \`min_rewards_grt_28d\`.

**Note on marginal vs realized APR:** Both numbers come from the same formula \`APR = (S/T) × issuance_per_year / (stakedTokens + new_allocation)\`, where \`stakedTokens\` is the deployment's existing total stake (which already includes the indexer's current allocation, if any). The only difference is \`new_allocation\`: dashboards show *realized* APR by setting \`new_allocation = 0\`; the optimizer reports *projected/marginal* APR by setting it to the proposed delta. On thin-staked deployments even a modest added allocation materially shifts the denominator, so the two APRs can diverge noticeably — this is a different metric, not a discrepancy.

It returns an \`OptimizationResult\` with:

- \`state\` — totalStake, availableStake, candidate counts.
- \`proposedAllocations\` — deploymentId, allocatedTokens (wei BigInt-as-string), projectedAprFraction, rationale.
- \`actions\` — concrete \`{type: 'allocate' | 'unallocate' | 'reallocate', deploymentId, amount?, allocationId?, reason}\` entries. NOTE: \`amount\` here is a **GRT decimal string** (e.g. \`"100"\`, \`"0.5"\`), matching the unit \`queue_allocate\` / \`queue_reallocate\` expect — forward it through verbatim without converting to wei.
- \`warnings\` and \`errors\` — surface these prominently.

Present \`actions\` as a markdown table and \`proposedAllocations\` as a per-deployment summary. **STOP and wait for explicit operator approval before executing any action via the individual \`queue_allocate\` / \`queue_unallocate\` / \`queue_reallocate\` tools.** \`approve_actions\` is operator-only — never call it without explicit instruction.

If the composite returns blocking errors, or you need fine-grained control / debugging of intermediate state, fall back to the ALTERNATIVE PATH below.

## ALTERNATIVE PATH — constituent-tool walkthrough

Use this path when you need to gather state manually, override individual steps, or debug what the composite would have done.

## Reference resources

Read these first so all numbers below come from one source of truth:

- \`indexer://config\` — indexer address, max_allocations, max_allocation_pct, risky_deployment_cap_pct, min_signal, gas_estimate_grt, min_rewards_grt_28d, whitelist/blacklist/frozenlist.
- \`indexer://overview\` — cached infrastructure summary (current stake, allocation count, recent epoch). The \`get_infrastructure_overview\` tool returns the same payload for clients that don't surface resources.
- \`indexer://glossary\` — Graph Protocol terminology if any term below is unclear.

## Step 1 — Gather state

Call these Stage 1 tools (in parallel where possible):

- \`get_network_parameters\` — total signal, total stake, issuance per block, GRT per block.
- \`get_indexer_allocations\` — current active allocations for the indexer (from \`indexer://config\`).
- \`get_all_signalled_deployments\` — every deployment with non-zero curation signal (the candidate universe).
- \`get_indexing_statuses\` — per-deployment health + sync state from graph-node. Eligible candidates: healthy + not paused + indexed up to the current epoch's start block (\`latestBlock >= epochStartBlock\` per the deployment's chain). graph-node's \`synced\` flag is NOT used — it has a misleading semantic (it's "has reached chain head at least once; stays true thereafter") and the actual gate is epoch-position.
- \`get_current_epoch\` — current epoch number and the start block per chain alias. Pair with \`get_indexing_statuses\` to apply the epoch-position eligibility gate.
- \`get_indexing_rules\` — current never/always/offchain rules so we don't override operator intent.
- \`get_top_queried_deployments\` — QoS volume data for tie-breaking and risk-weighting.

## Step 2 — Filter candidates

Apply the design §4.1 filters in order:

1. Drop deployments where \`get_indexing_statuses\` reports unhealthy (\`health != 'healthy'\`). Then drop deployments whose \`latestBlock < currentEpochStartBlock\` for their chain (can't earn current-epoch rewards). Do NOT use graph-node's \`synced\` flag for eligibility — it means "has reached chain head at least once; stays true thereafter" and is the wrong gate. Use \`get_current_epoch\` to obtain the per-chain epoch start block. Fail open per-candidate if either input (chain alias or latest block) is missing — the close-time HealthMonitor gate is authoritative. **Exception:** hard-reject candidates whose graph-node status is \`synced=false\` with no \`latestBlock\` — that combination means the deployment has never started indexing, not "missing data", and there is nothing to fail open about.
2. Drop deployments with \`deniedAt != 0\` (rewards denied) — surfaced by \`get_all_signalled_deployments\`.
3. Drop deployments below \`min_signal\` from \`indexer://config\`.
4. Drop blacklisted deployments. Keep frozenlist allocations as-is (do not propose changes to them).
5. Drop paused deployments. \`get_indexing_statuses\` already surfaces \`paused\` (and \`node\`) natively, so no graphman call is needed for analysis — graphman is required only when *executing* the resulting mutation plan (pause/unassign/etc.).

## Step 3 — Score by APR

For each surviving candidate, call \`calculate_deployment_apr\` with the two required arguments:

- \`deployment_id\` — the deployment under evaluation.
- \`allocation_amount\` — the proposed allocation size in wei (BigInt-as-string).

Use the formula from design §4.1 step 3 (also encoded in the tool) — spelled out here so you can verify the tool's output if needed:

\`\`\`
issuance_per_year = networkGRTIssuancePerBlock * BLOCKS_PER_YEAR
reward_share      = (deployment_signal / total_signal) * issuance_per_year
indexer_share     = new_allocation / (deployment_stake + new_allocation)
APR               = (reward_share * indexer_share) / new_allocation
\`\`\`

Equivalently, with \`S\` = deployment signal, \`T\` = total signal, \`A_i\` = new allocation, and \`A_total\` = deployment_stake + new_allocation:

\`\`\`
APR = ((S / T) * issuance_per_year * (A_i / A_total)) / A_i
\`\`\`

Net APR must subtract \`gas_estimate_grt\` amortized over expected allocation lifetime.

For **new** allocation candidates (no existing position on the deployment), additionally drop any candidate whose projected 28-day reward is below \`min_rewards_grt_28d\` (default 10 GRT). Existing allocations are exempt from this floor — only the gas floor applies to keep/close decisions on positions you already hold.

## Step 4 — Optimize

Solve for the allocation distribution that maximizes total expected APR subject to:

- Total allocation count <= \`max_allocations\`.
- Per-allocation size <= \`max_allocation_pct\` of stake (or \`risky_deployment_cap_pct\` for entries in \`risky_deployments\`).
- Whitelist entries always included if eligible.
- Frozenlist entries unchanged.

## Step 5 — Generate action plan

Diff desired state against current allocations from \`get_indexer_allocations\`:

- Allocations to close → list with deployment id, current size, reason.
- Allocations to open → list with deployment id, proposed size, expected APR.
- Allocations to resize → list with deployment id, current size, new size, delta APR.

## Step 6 — Output

Produce a markdown table with columns: action (close/open/reallocate), deployment_id, current_grt, target_grt, expected_apr, rationale. Below the table, summarize total stake redeployed, expected weighted APR before vs after, and estimated gas cost.

${dryRun
  ? '**Stop here.** Do NOT call `queue_allocate`, `queue_unallocate`, `queue_reallocate`, `set_indexing_rule`, or `set_cost_model`. Present the plan to the operator and wait for explicit approval. If the operator approves, they will re-invoke this prompt with `dry_run=false`.'
  : 'After presenting the plan, ask the operator to confirm before invoking any of: `queue_allocate`, `queue_unallocate`, `queue_reallocate`. Once confirmed, queue actions one-by-one and report each result. `approve_actions` is operator-only — never call it without explicit instruction.'}
`;
      return {
        description: `Allocation optimization workflow (dry_run=${dryRun}).`,
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
