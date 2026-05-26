/**
 * Prompt: `discover_new_subgraphs`
 *
 * Implements the design §4.3 discovery half. The PRIMARY PATH calls the
 * Stage 3 composite tool `run_discovery`, which produces the ranked
 * candidate list and offchain indexing rule recommendations in one shot.
 * The Stage 1 step-by-step walkthrough is preserved as the ALTERNATIVE
 * PATH for debugging or overriding the scoring weights.
 *
 * `max_candidates` caps the size of the ranked list to keep the output
 * actionable.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerPrompt } from '../server/register.js';

const argsSchema = {
  max_candidates: z.coerce.number().int().positive().default(10),
};

export function registerDiscoverNewSubgraphsPrompt(server: McpServer): void {
  registerIndexerPrompt(server, {
    name: 'discover_new_subgraphs',
    description:
      'Guide through finding and evaluating new subgraph sync opportunities (design §4.3 discovery half), ranked by the weighted scoring formula and capped at max_candidates.',
    argsSchema,
    handler: (args) => {
      const maxCandidates = args.max_candidates;
      const text = `# Discover New Subgraphs (design §4.3 — discovery half)

Goal: identify the top ${maxCandidates} deployments the indexer is NOT currently syncing that look like profitable additions, and produce a ranked recommendation list with an offchain indexing rule for the operator to approve.

## PRIMARY PATH — composite tool

Call \`run_discovery\` with the required arg:

- \`typical_allocation_grt\` — GRT decimal (e.g. "30000"). A reasonable default is \`total_stake_grt / max_allocations\` — pull totalStake from \`indexer://overview\` or \`get_infrastructure_overview\`, and max_allocations from \`indexer://config\`.

**Note on marginal vs realized APR:** Both numbers come from the same formula \`APR = (S/T) × issuance_per_year / (stakedTokens + new_allocation)\`, where \`stakedTokens\` is the deployment's existing total stake (which already includes the indexer's current allocation, if any). The only difference is \`new_allocation\`: dashboards show *realized* APR by setting \`new_allocation = 0\`; discovery's \`projectedAprFraction\` reports *projected/marginal* APR by setting it to the proposed allocation size. On thin-staked deployments even a modest added allocation materially shifts the denominator, so the two APRs can diverge noticeably — this is a different metric, not a discrepancy.

Optional args: \`indexer_address\`, \`max_candidates\` (default 10, max 500 — pass ${maxCandidates} for this run), \`min_signal_grt\`.

**Read-path note:** discovery analysis runs entirely against \`network-subgraph\`, \`graph-node\` (which now exposes \`paused\` and \`node\` natively on \`indexingStatuses\`), and \`qos-subgraph\`. A configured graphman API is needed only when *executing* the resulting cleanup plan (pause / unassign / unused_remove / etc.), not for the analysis itself.

It returns a \`DiscoveryResult\` with:

- \`stale\` — stale deployments (deploymentId, reason, sizeBytes, paused, hasAllocation, isFrozen). Cleanup is covered by \`cleanup_stale_deployments\`; ignore here.
- \`cleanup\` — ordered cleanup step sequences per stale deployment. Same — ignore for discovery.
- \`opportunities\` — ranked \`ScoredOpportunity[]\` (already sorted by §4.3 score, capped at \`max_candidates\`). Each entry has the raw candidate fields (signalledTokens, totalStakedTokens, indexerCount, queryVolume30d, entityCount, chain) plus \`score\`, \`components\` (aprScore, volumeScore, signalScore, costScore), and \`projectedAprFraction\`. This is the discovery-facing table.
- \`ruleRecommendations\` — suggested \`{deploymentId, decisionBasis: 'offchain', allocationAmount (wei string), rationale}\` entries for the top scored opportunities. The \`rationale\` lives here, not on each opportunity — join by \`deploymentId\` when presenting.
- \`warnings\` and \`errors\` — surface prominently.

Present \`opportunities\` as a markdown table (rank, deploymentId, score, projectedAprFraction, signalledTokens, queryVolume30d, entityCount, chain) and list \`ruleRecommendations\` underneath with their rationale strings. **STOP. Wait for explicit operator approval before calling \`set_indexing_rule\` for any recommendation.** Do NOT call \`queue_allocate\` for newly-discovered deployments — they aren't synced yet; allocation belongs to a later \`optimize_allocations\` pass.

If the composite returns blocking errors, or you need to debug an individual score / override the candidate filter, fall back to the ALTERNATIVE PATH below.

## ALTERNATIVE PATH — constituent-tool walkthrough

Use this path when you need to gather candidate data manually, override scoring weights, or debug what the composite would have ranked.

## Reference resources

- \`indexer://config\` — indexer address, min_signal, max_allocations, current whitelist/blacklist.
- \`indexer://overview\` — current sync footprint and disk usage summary. \`get_infrastructure_overview\` returns the same payload for tool-only clients.
- \`indexer://glossary\` — definitions for "curation signal", "offchain", "query fee rebates".

## Step 1 — Find candidate universe

Call in parallel:

- \`get_all_signalled_deployments\` — every deployment with non-zero signal across the network.
- \`get_indexing_statuses\` — what the indexer is already syncing (any deployment in this list is NOT a candidate).
- \`get_indexer_allocations\` — current active allocations (sanity check; should be a subset of indexing statuses).
- \`get_top_queried_deployments\` — QoS volume per deployment.
- \`get_network_parameters\` — total signal and issuance for APR math.

Candidate set = signalled deployments MINUS already-syncing deployments MINUS blacklist entries MINUS deployments below \`min_signal\`.

## Step 2 — Enrich each candidate

For every candidate, call (in parallel where possible):

- \`get_deployment_signal\` — confirm current signal (may have changed since the bulk query).
- \`get_query_volume\` — QoS data scoped to this deployment.
- \`get_all_subgraph_sizes\` once, then look up \`get_subgraph_size\` for any deployment-specific drill-down. Entity count is the pre-sync proxy for storage cost.
- \`calculate_deployment_apr\` — projected APR if the indexer were to allocate. Pass the two required arguments:
  - \`deployment_id\` — the candidate deployment.
  - \`allocation_amount\` — the indexer's typical allocation size from \`indexer://config\` (wei BigInt-as-string).

APR formula (design §4.1 step 3) — spelled out so you can verify the tool's output if needed. With \`S\` = deployment signal, \`T\` = total signal, \`A_i\` = new allocation, \`A_total\` = deployment_stake + new_allocation:

\`\`\`
issuance_per_year = networkGRTIssuancePerBlock * BLOCKS_PER_YEAR
reward_share      = (S / T) * issuance_per_year * (A_i / A_total)
APR               = reward_share / A_i
\`\`\`

## Step 3 — Score each candidate

Apply the design §4.3 weighted formula:

\`\`\`
score = (potential_apr           * 0.4)
      + (query_volume_normalized * 0.3)
      + (signal_normalized       * 0.2)
      - (estimated_cost_normalized * 0.1)
\`\`\`

Normalization (min-max across the candidate set):

- \`potential_apr\` from \`calculate_deployment_apr\`.
- \`query_volume_normalized\` from \`get_query_volume\` / max(query_volume).
- \`signal_normalized\` from \`get_deployment_signal\` / max(signal).
- \`estimated_cost_normalized\` from entity_count (or actual disk size where already known) / max(cost).

Subtract a penalty for deployments with a history of frequent upgrades — surface this as a qualitative note since the data source is operator memory + the network subgraph's deployment version history.

## Step 4 — Rank and trim

Sort descending by score. Take the top ${maxCandidates}. Surface tie-breakers in the rationale column when scores are within 5% of each other.

## Step 5 — Recommend

Produce a markdown table with columns: rank, deployment_id, score, potential_apr_pct, signal_grt, query_volume_30d, entity_count, chain, rationale.

Below the table, propose an "offchain" indexing rule per candidate the operator approves. For each approved entry, the operator (or this prompt re-run with explicit approval) can invoke \`set_indexing_rule\` with \`decisionBasis = 'offchain'\` to begin syncing without allocating capital.

**Produce the ranked plan first and wait for operator approval before calling \`set_indexing_rule\`.** Do NOT call \`queue_allocate\` for any newly-discovered deployment — it isn't synced yet; allocation belongs to a later \`optimize_allocations\` pass.
`;
      return {
        description: `Discover up to ${maxCandidates} new subgraph sync opportunities.`,
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
