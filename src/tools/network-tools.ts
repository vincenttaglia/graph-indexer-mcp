/**
 * MCP tools backed by the Network Subgraph client.
 *
 * Each tool is registered via `registerIndexerTool` so that access control,
 * error wrapping, and abort-signal forwarding are uniform. All tools are
 * `read`-class. Each handler calls `extra.signal.throwIfAborted()` up front
 * AND forwards `extra.signal` into the client call so cancellation aborts
 * the in-flight HTTP fetch, not just the handler entry. The signal is
 * combined with the per-request timeout controller inside
 * `createGraphqlClient` via `AbortSignal.any`.
 *
 * The APR math in `calculate_deployment_apr` follows the formula sketched in
 * `graph-indexer-mcp-design.md` §3.1 and §4.1 step 3:
 *
 *   issuance_per_year = network.networkGRTIssuancePerBlock * blocks_per_year
 *   reward_share      = (deployment.signalledTokens / network.totalTokensSignalled)
 *                       * issuance_per_year
 *   indexer_share     = new_allocation / (deployment.stakedTokens + new_allocation)
 *   indexer_reward_per_year = reward_share * indexer_share
 *   apr               = indexer_reward_per_year / new_allocation
 *
 * `networkGRTIssuancePerBlock` is the canonical field on the network
 * subgraph. It is the per-block GRT issuance dedicated to indexing rewards
 * (wei), denominated per Ethereum block regardless of which chain hosts the
 * Network Subgraph. To annualize we multiply by `blocks_per_year`, which
 * the caller MUST supply. The canonical value is 2,102,400 (5760 blocks/day
 * × 365), matching indexer-tools-v4. This single value applies for both
 * Ethereum mainnet and Arbitrum One. A wrong value would silently skew APR.
 *
 * Reward-denied deployments (`deniedAt != 0`) MUST be excluded from APR per
 * design §4.1. We surface `apr: 0` with `denied: true` so the caller can see
 * the deployment is on the denylist instead of silently returning a stale
 * non-zero APR.
 *
 * All on-chain values are BigInt-as-string in wei. To avoid Number precision
 * loss the intermediate math is performed against `bigint`, with a final
 * fixed-precision divide into a JS number for the APR fraction (1.0 = 100%).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerTool } from '../server/register.js';
import type { Config } from '../config.js';
import type {
  NetworkSubgraphClient,
} from '../clients/network-subgraph.js';

export interface NetworkToolDeps {
  client: NetworkSubgraphClient;
  config: Config;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Map the lowercase user-facing filter to the subgraph enum. */
function mapStatusFilter(
  v: 'active' | 'closed' | 'all',
): 'Active' | 'Closed' | 'all' {
  if (v === 'active') return 'Active';
  if (v === 'closed') return 'Closed';
  return 'all';
}

function asText(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Parse a BigInt-as-string. Accepts decimal integers only (wei units). Throws
 * a friendly error on garbage input so the MCP error surface is informative.
 */
function parseWei(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Parameter "${name}" must be a non-negative integer string in wei (got: ${JSON.stringify(value)}).`,
    );
  }
  return BigInt(value);
}

/**
 * Divide two bigints into a JS number, preserving up to `precision` decimal
 * digits before the conversion. Returns 0 when the denominator is zero.
 */
function ratioToNumber(num: bigint, den: bigint, precision = 18): number {
  if (den === 0n) return 0;
  const scale = 10n ** BigInt(precision);
  const scaled = (num * scale) / den;
  return Number(scaled) / Number(scale);
}

export function registerNetworkTools(
  server: McpServer,
  deps: NetworkToolDeps,
): void {
  // ---------------------------------------------------------------------------
  // get_indexer_allocations
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_indexer_allocations',
    permissionClass: 'read',
    description:
      'Fetch allocations for an indexer from the network subgraph. ' +
      'Filter by status (active/closed/all).',
    inputSchema: {
      indexer_address: z
        .string()
        .regex(EVM_ADDRESS, 'must be a 0x-prefixed 40-character hex address'),
      status_filter: z.enum(['active', 'closed', 'all']).default('active'),
    },
    handler: async ({ indexer_address, status_filter }, extra) => {
      extra.signal.throwIfAborted();
      const { items, truncated } = await deps.client.getAllocations(
        indexer_address,
        mapStatusFilter(status_filter),
        { signal: extra.signal },
      );
      return asText({
        indexer: indexer_address.toLowerCase(),
        status_filter,
        count: items.length,
        truncated,
        allocations: items,
      });
    },
  });

  // ---------------------------------------------------------------------------
  // get_deployment_signal
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_deployment_signal',
    permissionClass: 'read',
    description:
      'Get signal, total stake, and reward info for a single subgraph deployment.',
    inputSchema: {
      deployment_id: z.string().min(1),
    },
    handler: async ({ deployment_id }, extra) => {
      extra.signal.throwIfAborted();
      const deployment = await deps.client.getDeployment(deployment_id, {
        signal: extra.signal,
      });
      if (!deployment) {
        return asText({ deployment_id, found: false });
      }
      return asText({ deployment_id, found: true, deployment });
    },
  });

  // ---------------------------------------------------------------------------
  // get_all_signalled_deployments
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_all_signalled_deployments',
    permissionClass: 'read',
    description:
      'List all subgraph deployments with curation signal at least min_signal (wei, BigInt-as-string).',
    inputSchema: {
      min_signal: z
        .string()
        .regex(/^\d+$/, 'min_signal must be a non-negative integer string in wei'),
    },
    handler: async ({ min_signal }, extra) => {
      extra.signal.throwIfAborted();
      const { items, truncated } = await deps.client.getSignalledDeployments(min_signal, {
        signal: extra.signal,
      });
      return asText({
        min_signal,
        count: items.length,
        truncated,
        deployments: items,
      });
    },
  });

  // ---------------------------------------------------------------------------
  // get_network_parameters
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_network_parameters',
    permissionClass: 'read',
    description:
      'Fetch global network parameters: total supply, total signalled, total allocated, current epoch, epoch length, per-block GRT issuance, delegation ratio (PPM).',
    handler: async (_args, extra) => {
      extra.signal.throwIfAborted();
      const network = await deps.client.getNetworkParameters({ signal: extra.signal });
      return asText(network);
    },
  });

  // ---------------------------------------------------------------------------
  // get_deployment_allocations
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_deployment_allocations',
    permissionClass: 'read',
    description:
      'List all indexers currently allocated to a specific deployment (active allocations only).',
    inputSchema: {
      deployment_id: z.string().min(1),
    },
    handler: async ({ deployment_id }, extra) => {
      extra.signal.throwIfAborted();
      const { items, truncated } = await deps.client.getDeploymentAllocations(deployment_id, {
        signal: extra.signal,
      });
      return asText({
        deployment_id,
        count: items.length,
        truncated,
        allocations: items,
      });
    },
  });

  // ---------------------------------------------------------------------------
  // calculate_deployment_apr
  // ---------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'calculate_deployment_apr',
    permissionClass: 'read',
    description:
      'Estimate the indexing-reward APR for opening (or growing) an allocation on a deployment. ' +
      'Inputs are wei BigInt strings. Returns APR as a decimal fraction (1.0 = 100%). ' +
      'Deployments with rewards denied (deniedAt != 0) return apr=0 and denied=true.',
    inputSchema: {
      deployment_id: z.string().min(1),
      allocation_amount: z
        .string()
        .regex(/^\d+$/, 'allocation_amount must be a non-negative integer string in wei'),
      blocks_per_year: z
        .coerce.number()
        .int()
        .positive()
        .describe(
          'Blocks per year used to annualize networkGRTIssuancePerBlock. ' +
            'Required, no default. Recommended value: 2102400 (matches ' +
            'indexer-tools-v4 canonical formula — 5760 blocks/day × 365). ' +
            'Applies for both Ethereum mainnet and Arbitrum: ' +
            'networkGRTIssuancePerBlock is denominated per Ethereum block ' +
            'regardless of which chain hosts the network subgraph.',
        ),
    },
    handler: async ({ deployment_id, allocation_amount, blocks_per_year }, extra) => {
      extra.signal.throwIfAborted();

      const newAllocation = parseWei('allocation_amount', allocation_amount);
      if (newAllocation === 0n) {
        throw new Error('allocation_amount must be > 0 to compute APR.');
      }

      const [deployment, network] = await Promise.all([
        deps.client.getDeployment(deployment_id, { signal: extra.signal }),
        deps.client.getNetworkParameters({ signal: extra.signal }),
      ]);

      if (!deployment) {
        throw new Error(`Deployment ${deployment_id} not found in network subgraph.`);
      }

      // Rewards-denied deployments earn no indexing rewards (design §4.1).
      // Surface a clear `denied: true` field with apr=0 rather than returning
      // a nonzero APR based on stale signal/issuance state.
      if (BigInt(deployment.deniedAt ?? 0) > 0n) {
        return asText({
          deployment_id,
          allocation_amount,
          apr: 0,
          denied: true,
          reason: `Deployment rewards were denied at block ${deployment.deniedAt}.`,
          formula_inputs: {
            deployment_signalled_tokens: deployment.signalledTokens,
            deployment_staked_tokens: deployment.stakedTokens,
            deployment_denied_at: deployment.deniedAt,
          },
        });
      }

      const blocksPerYear = BigInt(blocks_per_year);

      const signalled = parseWei('deployment.signalledTokens', deployment.signalledTokens);
      const totalSignalled = parseWei(
        'network.totalTokensSignalled',
        network.totalTokensSignalled,
      );
      const issuancePerBlock = parseWei(
        'network.networkGRTIssuancePerBlock',
        network.networkGRTIssuancePerBlock,
      );
      const existingStake = parseWei('deployment.stakedTokens', deployment.stakedTokens);
      const denomStake = existingStake + newAllocation;

      // issuance_per_year [wei] = per-block issuance * blocks_per_year
      const issuancePerYear = issuancePerBlock * blocksPerYear;

      // reward_share = (signal_i / total_signal) * issuance_per_year   [wei/year]
      const rewardSharePerYear =
        totalSignalled === 0n ? 0n : (signalled * issuancePerYear) / totalSignalled;

      // indexer_share = new_allocation / (total_allocated + new_allocation)
      const indexerSharePerYear =
        denomStake === 0n ? 0n : (rewardSharePerYear * newAllocation) / denomStake;

      // APR = indexer_reward_per_year / new_allocation, returned as a decimal
      // fraction. Single scaled divide avoids the double-floor that the prior
      // two-step intermediate division introduced.
      const apr = ratioToNumber(indexerSharePerYear, newAllocation);

      // Friendly debug/explainability fields — every input is echoed verbatim
      // so the caller (and the operator reviewing a recommendation) can audit.
      return asText({
        deployment_id,
        allocation_amount,
        apr,
        denied: false,
        reward_share: rewardSharePerYear.toString(),
        indexer_share: indexerSharePerYear.toString(),
        formula_inputs: {
          deployment_signalled_tokens: deployment.signalledTokens,
          deployment_staked_tokens: deployment.stakedTokens,
          deployment_denied_at: deployment.deniedAt,
          network_total_tokens_signalled: network.totalTokensSignalled,
          network_total_tokens_allocated: network.totalTokensAllocated,
          network_issuance_per_block: network.networkGRTIssuancePerBlock,
          blocks_per_year: blocksPerYear.toString(),
          network_issuance_per_year: issuancePerYear.toString(),
          new_allocation_plus_existing_stake: denomStake.toString(),
        },
      });
    },
  });
}
