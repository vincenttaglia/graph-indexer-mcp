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
import type { ActionInput } from '../types/agent.js';

export interface AgentToolDeps {
  client: IndexerAgentClient;
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
  const { client } = deps;

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
      amount: z
        .string()
        .describe('GRT amount in wei as a decimal string (BigInt-as-string).'),
    },
    handler: async (args) => {
      const action: ActionInput = {
        type: 'allocate',
        deploymentID: args.deployment_id,
        amount: args.amount,
        source: ACTION_SOURCE,
        reason: 'queued via MCP queue_allocate',
        priority: DEFAULT_PRIORITY,
      };
      const result = await client.queueActions([action]);
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
      'allocation on-chain, submitting the provided Proof of Indexing. The ' +
      'POI must be valid for the allocation\'s deployment at the closing ' +
      'block or the transaction will revert.',
    inputSchema: {
      allocation_id: z
        .string()
        .describe('On-chain allocation id (0x-prefixed hex).'),
      poi: z
        .string()
        .describe('32-byte Proof of Indexing as a 0x-prefixed hex string.'),
    },
    handler: async (args) => {
      const action: ActionInput = {
        type: 'unallocate',
        // The agent's ActionInput still requires deploymentID for unallocate;
        // we leave it empty here so the agent resolves it from allocationID.
        // TODO: verify against live agent schema — if deploymentID is required,
        // a prior lookup will need to populate it.
        deploymentID: '',
        allocationID: args.allocation_id,
        poi: args.poi,
        source: ACTION_SOURCE,
        reason: 'queued via MCP queue_unallocate',
        priority: DEFAULT_PRIORITY,
      };
      const result = await client.queueActions([action]);
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
      'Queue a reallocate action: atomically closes the given allocation ' +
      '(submitting POI) and opens a fresh allocation on the same deployment ' +
      'for `new_amount` GRT wei. Executed as a single multicall on-chain.',
    inputSchema: {
      allocation_id: z
        .string()
        .describe('On-chain allocation id to close (0x-prefixed hex).'),
      poi: z
        .string()
        .describe('Proof of Indexing for the closing allocation.'),
      new_amount: z
        .string()
        .describe('GRT amount in wei (decimal string) for the new allocation.'),
    },
    handler: async (args) => {
      const action: ActionInput = {
        type: 'reallocate',
        deploymentID: '', // Resolved from allocationID by the agent.
        allocationID: args.allocation_id,
        poi: args.poi,
        amount: args.new_amount,
        source: ACTION_SOURCE,
        reason: 'queued via MCP queue_reallocate',
        priority: DEFAULT_PRIORITY,
      };
      const result = await client.queueActions([action]);
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
          'pending',
          'success',
          'failed',
          'canceled',
          'all',
        ])
        .default('all')
        .describe('Action status to filter by; `all` returns everything.'),
    },
    handler: async (args) => {
      const result = await client.getActionQueue(args.status_filter);
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
    handler: async (args) => {
      const result = await client.approveActions(args.action_ids);
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
    handler: async (args) => {
      const result = await client.cancelActions(args.action_ids);
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
      '`requireSupported`.',
    inputSchema: {
      deployment_id: z
        .string()
        .describe('Deployment IPFS hash this rule applies to.'),
      rule_params: z
        .record(z.string(), z.unknown())
        .describe(
          'Open-shape map of rule fields to set; merged with `identifier` ' +
            'and `identifierType: "deployment"`.',
        ),
    },
    handler: async (args) => {
      // identifier/identifierType are derived from deployment_id; callers
      // can still override identifierType via rule_params if they need a
      // subgraph- or group-level rule.
      const rule = {
        identifier: args.deployment_id,
        identifierType: 'deployment' as const,
        ...args.rule_params,
      } as Parameters<typeof client.setIndexingRule>[0];
      const result = await client.setIndexingRule(rule);
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
    handler: async () => {
      const result = await client.getIndexingRules();
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
    handler: async (args) => {
      const result = await client.setCostModel({
        deployment: args.deployment_id,
        model: args.model,
        variables: args.variables,
      });
      return jsonResult(result);
    },
  });
}
