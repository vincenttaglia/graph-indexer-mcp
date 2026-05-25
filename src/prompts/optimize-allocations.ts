/**
 * Prompt: `optimize_allocations`
 *
 * Walks Claude through the full allocation-optimization workflow described
 * in `graph-indexer-mcp-design.md` §4.1. The prompt is intentionally a
 * single user-role message: it lays out the goal, the exact Stage 1 tools
 * to call (no Stage 3 composite tools — those do not exist yet), and the
 * APR formula and per-deployment cap rules from the design doc.
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

## Reference resources

Read these first so all numbers below come from one source of truth:

- \`indexer://config\` — indexer address, max_allocations, max_allocation_pct, risky_deployment_cap_pct, min_signal, gas_estimate_grt, whitelist/blacklist/frozenlist.
- \`indexer://overview\` — cached infrastructure summary (current stake, allocation count, recent epoch).
- \`indexer://glossary\` — Graph Protocol terminology if any term below is unclear.

## Step 1 — Gather state

Call these Stage 1 tools (in parallel where possible):

- \`get_network_parameters\` — total signal, total stake, issuance per block, GRT per block.
- \`get_indexer_allocations\` — current active allocations for the indexer (from \`indexer://config\`).
- \`get_all_signalled_deployments\` — every deployment with non-zero curation signal (the candidate universe).
- \`get_indexing_statuses\` — per-deployment health + sync state from graph-node; only synced+healthy deployments are eligible.
- \`get_indexing_rules\` — current never/always/offchain rules so we don't override operator intent.
- \`get_top_queried_deployments\` — QoS volume data for tie-breaking and risk-weighting.

## Step 2 — Filter candidates

Apply the design §4.1 filters in order:

1. Drop deployments where \`get_indexing_statuses\` reports unhealthy / not fully synced.
2. Drop deployments with \`deniedAt != 0\` (rewards denied) — surfaced by \`get_all_signalled_deployments\`.
3. Drop deployments below \`min_signal\` from \`indexer://config\`.
4. Drop blacklisted deployments. Keep frozenlist allocations as-is (do not propose changes to them).
5. For any deployment with graphman state, call \`graphman_deployment_info\` and drop if paused.

## Step 3 — Score by APR

For each surviving candidate, call \`calculate_deployment_apr\` with **all three required arguments**:

- \`deployment_id\` — the deployment under evaluation.
- \`allocation_amount\` — the proposed allocation size in wei (BigInt-as-string).
- \`blocks_per_year\` — the blocks-per-year constant for the chain hosting the Network Subgraph. This argument is REQUIRED (no default — a wrong default would silently skew APR by ~4x). Obtain it from operator input, from \`indexer://config\` if present, or from the chain's known value: Ethereum mainnet ~2,629,800 (12s blocks); Arbitrum One ~10,512,000 (3s nominal). Confirm with the operator if uncertain.

Use the formula from design §4.1 step 3 (also encoded in the tool) — spelled out here so you can verify the tool's output if needed:

\`\`\`
issuance_per_year = networkGRTIssuancePerBlock * blocks_per_year
reward_share      = (deployment_signal / total_signal) * issuance_per_year
indexer_share     = new_allocation / (deployment_stake + new_allocation)
APR               = (reward_share * indexer_share) / new_allocation
\`\`\`

Equivalently, with \`S\` = deployment signal, \`T\` = total signal, \`A_i\` = new allocation, and \`A_total\` = deployment_stake + new_allocation:

\`\`\`
APR = ((S / T) * issuance_per_year * (A_i / A_total)) / A_i
\`\`\`

Net APR must subtract \`gas_estimate_grt\` amortized over expected allocation lifetime.

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
