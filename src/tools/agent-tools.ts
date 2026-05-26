/**
 * MCP tools for the Indexer Agent Management API.
 *
 * Nine tools cover the control-plane surface defined in design §5.6:
 *   - Action queue: queue_allocate / queue_unallocate / queue_reallocate,
 *     get_action_queue, approve_actions, cancel_actions.
 *   - Indexing rules: set_indexing_rule, get_indexing_rules.
 *   - Cost models: set_cost_model.
 *
 * Permission classes follow access-control.ts: queue/mutation tools are
 * `agent_queue`, approve/cancel are `agent_approve`, reads are `read`.
 *
 * All `queue_*` tools wrap their single input action in `[action]` before
 * delegating to `IndexerAgentClient.queueActions`, matching the agent's
 * bulk-mutation shape.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { registerIndexerTool } from '../server/register.js';
import type { IndexerAgentClient } from '../clients/indexer-agent.js';
import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { ActionInput } from '../types/agent.js';

export interface AgentToolDeps {
  client: IndexerAgentClient;
  /**
   * Network subgraph client — needed to look up the allocation's
   * `isLegacy` flag at queue time for unallocate / reallocate actions.
   * The flag is immutable per allocation, so a fresh fetch is fine
   * (no caching tier required on this code path).
   */
  networkClient: NetworkSubgraphClient;
  config: Config;
}

/**
 * Common "source" tag we stamp on every action the MCP queues. Operators can
 * grep the agent's action history by source to see what came from Claude vs.
 * the agent's own rules engine vs. indexer-cli.
 */
const ACTION_SOURCE = 'graph-indexer-mcp';

/** Default priority for MCP-queued actions; lower = sooner. */
const DEFAULT_PRIORITY = 0;

// ---------------------------------------------------------------------------
// Shared input validators
// ---------------------------------------------------------------------------

/** Non-empty decimal digit string — GRT wei amount. */
const wei = z
  .string()
  .regex(/^[0-9]+$/, 'must be a non-negative decimal wei string');

/**
 * Sentinel all-zero POI (`0x` + 64 zeros). Submitted in place of a real Proof
 * of Indexing when the caller opts into a forfeit-rewards close via the
 * `force_zero_poi` flag on `queue_unallocate` / `queue_reallocate`. The
 * indexer-agent treats this value as "no valid POI provided" and closes the
 * allocation without claiming indexing rewards. We never let Claude pass a
 * hand-crafted POI through these tools — POI generation is a graph-node
 * concern and the only safe knob to expose is binary: let the agent compute
 * (default) vs. force-zero.
 */
const ZERO_POI = '0x' + '0'.repeat(64);

/**
 * POI bundle sent on `unallocate` / `reallocate` when the caller sets
 * `force_zero_poi=true`. All four fields move together:
 *   - `poi` and `publicPOI`: the all-zero sentinel
 *   - `poiBlockNumber`: 0 (matches the zero POI)
 *   - `force`: true, so the agent skips re-verification of the POI
 *
 * Default branch (`force_zero_poi=false`) returns `{}` so all four fields
 * are absent from the wire payload; the agent then computes a real POI at
 * close time and the allocation claims rewards.
 *
 * Mirrors the `buildPoiFields('0x0')` branch in indexer-tools-v4's
 * AllocationWizard (`src/stores/wizardStore.ts`).
 */
function poiBundle(
  forceZeroPoi: boolean,
): Pick<ActionInput, 'poi' | 'publicPOI' | 'poiBlockNumber' | 'force'> {
  if (!forceZeroPoi) return {};
  return {
    poi: ZERO_POI,
    publicPOI: ZERO_POI,
    poiBlockNumber: 0,
    force: true,
  };
}

/** 0x-prefixed 40-hex-char allocation id (Ethereum address shape). */
const allocationIdHex = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{40}$/,
    'must be 0x-prefixed 40-char hex allocation id',
  );

/**
 * Keys that callers MUST NOT supply via `rule_params` — they are derived from
 * `deployment_id` and overriding them would let a deployment-scoped tool
 * mutate the global / group / subgraph rule instead. Keep in sync with the
 * Zod refine on the rule_params schema below and with the spread order in
 * the set_indexing_rule handler.
 */
const RESERVED_RULE_KEYS = new Set(['identifier', 'identifierType']);

/**
 * Pretty-print a JSON-able value as a single MCP text content block. We
 * standardize on JSON-with-2-space-indent so tool outputs stay machine-
 * readable for downstream prompt steps while remaining human-friendly when
 * inspected in transcripts.
 */
function jsonResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

export function registerAgentTools(server: McpServer, deps: AgentToolDeps): void {
  const { client, networkClient, config } = deps;

  /**
   * Look up an allocation by id and return its `isLegacy` flag, throwing
   * a clear error if the allocation can't be found. The indexer-agent
   * requires this flag on every close/reallocate action — without it the
   * GraphQL mutation is rejected — so we must look it up before queueing.
   *
   * Notes:
   *   - `isLegacy === undefined` on the schema row is treated as `false`
   *     (Horizon default). Older schemas without the field fall through
   *     to the same default.
   *   - Missing allocations throw rather than defaulting to a value —
   *     queueing an unallocate against a non-existent allocation would
   *     fail at the agent anyway, but failing fast here surfaces a
   *     cleaner error to the operator.
   */
  async function lookupIsLegacy(
    allocationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const allocation = await networkClient.getAllocationById(allocationId, {
      signal,
    });
    if (allocation === null) {
      throw new Error(
        `Cannot queue action: allocation ${allocationId} not found in the ` +
          `network subgraph. The agent requires \`isLegacy\` on every close/` +
          `reallocate action and we cannot determine it for a missing allocation.`,
      );
    }
    return allocation.isLegacy ?? false;
  }

  // -----------------------------------------------------------------------
  // queue_allocate — open a new allocation on a deployment
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'queue_allocate',
    permissionClass: 'agent_queue',
    description:
      'Queue an allocate action on the indexer agent: opens a new allocation ' +
      'against the given deployment for `amount` GRT (wei, decimal string). ' +
      'The action is added to the agent queue in `queued` status and must be ' +
      'approved (via approve_actions or by an operator) before execution.',
    inputSchema: {
      deployment_id: z.string().describe('Subgraph deployment IPFS hash (Qm…).'),
      amount: wei.describe(
        'GRT amount in wei as a decimal string (BigInt-as-string).',
      ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const action: ActionInput = {
        type: 'allocate',
        deploymentID: args.deployment_id,
        amount: args.amount,
        source: ACTION_SOURCE,
        reason: 'queued via MCP queue_allocate',
        priority: DEFAULT_PRIORITY,
        status: 'queued',
        protocolNetwork: config.protocolNetwork,
        // New allocations are always Horizon-era — legacy positions can
        // only exist on contracts that no longer accept new opens.
        isLegacy: false,
      };
      const result = await client.queueActions([action], { signal: extra.signal });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // queue_unallocate — close an existing allocation
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'queue_unallocate',
    permissionClass: 'agent_queue',
    description:
      'Queue an unallocate (close-allocation) action: closes the given ' +
      'allocation on-chain. `deployment_id` and `allocation_id` are required; ' +
      'the caller must supply the deployment the allocation belongs to (look ' +
      'it up via the network subgraph if needed). Proof of Indexing is NOT ' +
      'a tool input — POI generation is a graph-node concern and Claude does ' +
      'not have visibility into the right value. The only knob is ' +
      '`force_zero_poi`: when false (default) the indexer-agent computes a ' +
      'real POI itself at close time and the allocation claims indexing ' +
      'rewards; when true the action is submitted with an all-zero POI, ' +
      'which closes the allocation but forfeits the indexing-reward share.',
    inputSchema: {
      deployment_id: z
        .string()
        .describe(
          'Subgraph deployment IPFS hash (Qm…) the allocation belongs to.',
        ),
      allocation_id: allocationIdHex.describe(
        'On-chain allocation id (0x-prefixed 40-char hex).',
      ),
      force_zero_poi: z
        .boolean()
        .default(false)
        .describe(
          'When false (default) the indexer-agent computes the POI + ' +
            'publicPOI at close time and the allocation claims rewards. ' +
            'When true the action is submitted with the all-zero POI bundle ' +
            '(poi=0x00…, publicPOI=0x00…, poiBlockNumber=0, force=true), ' +
            'forfeiting indexing rewards for this allocation. Use only when ' +
            'graph-node cannot produce a valid POI for the closing block.',
        ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // POI is binary by design here: omit the four-field bundle (agent
      // computes everything, default reward path) or set the all-zero
      // bundle (forfeit rewards, `force: true`). We never let Claude push
      // a hand-crafted POI through this tool — that's a footgun for the
      // operator's revenue, and POI generation belongs in graph-node.
      const isLegacy = await lookupIsLegacy(args.allocation_id, extra.signal);
      const action: ActionInput = {
        type: 'unallocate',
        deploymentID: args.deployment_id,
        allocationID: args.allocation_id,
        // amount is required on every ActionInput, including unallocate;
        // the agent's schema rejects mutations without it. Matches the
        // wizard's `amount: '0'` convention.
        amount: '0',
        ...poiBundle(args.force_zero_poi),
        source: ACTION_SOURCE,
        reason: args.force_zero_poi
          ? 'queued via MCP queue_unallocate (force_zero_poi=true; rewards forfeited)'
          : 'queued via MCP queue_unallocate',
        priority: DEFAULT_PRIORITY,
        status: 'queued',
        protocolNetwork: config.protocolNetwork,
        isLegacy,
      };
      const result = await client.queueActions([action], { signal: extra.signal });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // queue_reallocate — atomic close + reopen on the same deployment
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'queue_reallocate',
    permissionClass: 'agent_queue',
    description:
      'Queue a reallocate action: atomically closes the given allocation and ' +
      'opens a fresh allocation on the same deployment for `new_amount` GRT ' +
      'wei. Executed as a single multicall on-chain. `deployment_id`, ' +
      '`allocation_id`, and `new_amount` are required; the caller must supply ' +
      'the deployment the allocation belongs to. Proof of Indexing is NOT a ' +
      'tool input — see `force_zero_poi`: false (default) lets the agent ' +
      'compute a real POI at close time and claim indexing rewards, true ' +
      'submits an all-zero POI and forfeits the rewards for the closing leg.',
    inputSchema: {
      deployment_id: z
        .string()
        .describe(
          'Subgraph deployment IPFS hash (Qm…) the allocation belongs to ' +
            '(also the deployment the fresh allocation opens on).',
        ),
      allocation_id: allocationIdHex.describe(
        'On-chain allocation id to close (0x-prefixed 40-char hex).',
      ),
      force_zero_poi: z
        .boolean()
        .default(false)
        .describe(
          'When false (default) the indexer-agent computes POI + publicPOI ' +
            'for the closing leg and claims rewards. When true the closing ' +
            'leg is submitted with the all-zero POI bundle (poi=0x00…, ' +
            'publicPOI=0x00…, poiBlockNumber=0, force=true), forfeiting the ' +
            'closing rewards. Use only when graph-node cannot produce a valid POI.',
        ),
      new_amount: wei.describe(
        'GRT amount in wei (decimal string) for the new allocation.',
      ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // See queue_unallocate above: POI is binary. Omit the four-field
      // bundle (agent computes, default reward path) vs. set the all-zero
      // bundle (forfeit rewards, force: true). Never accept a
      // caller-supplied POI string through this tool.
      const isLegacy = await lookupIsLegacy(args.allocation_id, extra.signal);
      const action: ActionInput = {
        type: 'reallocate',
        deploymentID: args.deployment_id,
        allocationID: args.allocation_id,
        amount: args.new_amount,
        ...poiBundle(args.force_zero_poi),
        source: ACTION_SOURCE,
        reason: args.force_zero_poi
          ? 'queued via MCP queue_reallocate (force_zero_poi=true; rewards forfeited)'
          : 'queued via MCP queue_reallocate',
        priority: DEFAULT_PRIORITY,
        status: 'queued',
        protocolNetwork: config.protocolNetwork,
        isLegacy,
      };
      const result = await client.queueActions([action], { signal: extra.signal });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // get_action_queue — read pending/historical actions
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_action_queue',
    permissionClass: 'read',
    description:
      'List actions in the indexer-agent queue, optionally filtered by ' +
      'status. Use `all` (default) to see every action regardless of ' +
      'lifecycle stage.',
    inputSchema: {
      status_filter: z
        .enum([
          'queued',
          'approved',
          'deploying',
          'pending',
          'success',
          'failed',
          'canceled',
          'all',
        ])
        .default('all')
        .describe('Action status to filter by; `all` returns everything.'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.getActionQueue(args.status_filter, {
        signal: extra.signal,
      });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // approve_actions — move queued actions to approved
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'approve_actions',
    permissionClass: 'agent_approve',
    description:
      'Approve one or more queued actions so the agent will execute them on ' +
      'the next worker cycle. Requires `full` access level (or an explicit ' +
      'override) — this commits real GRT on-chain.',
    inputSchema: {
      action_ids: z
        .array(z.string())
        .min(1)
        .describe('Action ids to approve (as returned by get_action_queue).'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.approveActions(args.action_ids, {
        signal: extra.signal,
      });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // cancel_actions — cancel pending/queued/approved actions
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'cancel_actions',
    permissionClass: 'agent_approve',
    description:
      'Cancel one or more actions in the agent queue. Has no effect on ' +
      'actions that have already been executed (status `success` / `failed`).',
    inputSchema: {
      action_ids: z
        .array(z.string())
        .min(1)
        .describe('Action ids to cancel.'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.cancelActions(args.action_ids, {
        signal: extra.signal,
      });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // set_indexing_rule — upsert a per-deployment indexing rule
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'set_indexing_rule',
    permissionClass: 'agent_queue',
    description:
      'Create or update an indexing rule for a deployment. `rule_params` is ' +
      'passed through to the agent\'s `setIndexingRule` mutation; common ' +
      'fields include `allocationAmount` (wei string), `allocationLifetime` ' +
      '(epochs), `decisionBasis` (`rules|never|always|offchain`), and ' +
      '`requireSupported`. `identifier` and `identifierType` are derived ' +
      'from `deployment_id` and cannot be overridden via `rule_params` — ' +
      'this tool is strictly deployment-scoped.',
    inputSchema: {
      deployment_id: z
        .string()
        .describe('Deployment IPFS hash this rule applies to.'),
      rule_params: z
        .record(z.string(), z.unknown())
        // Belt: reject reserved keys at the schema layer so the caller sees a
        // clear validation error rather than silent stripping.
        .refine(
          (params) =>
            !Object.keys(params).some((k) => RESERVED_RULE_KEYS.has(k)),
          {
            message:
              'rule_params must not contain `identifier` or `identifierType`; ' +
              'they are derived from deployment_id.',
          },
        )
        .describe(
          'Open-shape map of rule fields to set; `identifier` / ' +
            '`identifierType` are reserved and rejected.',
        ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      // Suspenders: even though the schema rejects reserved keys, strip them
      // again here and put derived fields LAST so a spread can never override
      // them. This is a deployment-scoped tool; do not let user input change
      // the rule scope.
      const filteredParams = Object.fromEntries(
        Object.entries(args.rule_params).filter(
          ([k]) => !RESERVED_RULE_KEYS.has(k),
        ),
      );
      const rule = {
        ...filteredParams,
        identifier: args.deployment_id,
        identifierType: 'deployment' as const,
      } as Parameters<typeof client.setIndexingRule>[0];
      const result = await client.setIndexingRule(rule, { signal: extra.signal });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // get_indexing_rules — list all current rules (merged)
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_indexing_rules',
    permissionClass: 'read',
    description:
      'Return all indexing rules currently configured on the agent, with ' +
      'group/global defaults merged in for deployment-level rules.',
    handler: async (_args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.getIndexingRules({ signal: extra.signal });
      return jsonResult(result);
    },
  });

  // -----------------------------------------------------------------------
  // set_cost_model — upsert an Agora cost model for a deployment
  // -----------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'set_cost_model',
    permissionClass: 'agent_queue',
    description:
      'Set or update the Agora cost model for a deployment. `model` is the ' +
      'Agora source; `variables` is an optional JSON string of model ' +
      'parameters. Use deployment id `global` to set the fallback model.',
    inputSchema: {
      deployment_id: z
        .string()
        .describe('Deployment IPFS hash, or `global` for the fallback model.'),
      model: z.string().describe('Agora cost-model source code.'),
      variables: z
        .string()
        .optional()
        .describe('Optional JSON-encoded variables object.'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.setCostModel(
        {
          deployment: args.deployment_id,
          model: args.model,
          variables: args.variables,
        },
        { signal: extra.signal },
      );
      return jsonResult(result);
    },
  });
}
