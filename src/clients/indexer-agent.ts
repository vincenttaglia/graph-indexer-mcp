/**
 * Typed client for the Indexer Agent Management GraphQL API.
 *
 * The agent serves this on localhost (default `:18000/graphql`) and is
 * unauthenticated — we rely on it being bound to loopback. All queries and
 * mutations route through the shared `createGraphqlClient` so we inherit
 * retry/timeout/logging behaviour.
 *
 * The agent's schema is not formally versioned; field names below were taken
 * from the design document (§2.4) and the indexer-agent reference. Anywhere
 * we had to guess at an enum value or input shape we left a
 * `// TODO: verify against live agent schema` marker so it's easy to grep for
 * fix-ups once we can introspect a live agent.
 */

import { createGraphqlClient, type TypedGraphqlClient } from '../utils/graphql-client.js';
import type {
  Action,
  ActionInput,
  CostModel,
  IndexingRule,
} from '../types/agent.js';

// ---------------------------------------------------------------------------
// Query / mutation documents
// ---------------------------------------------------------------------------

/**
 * Shared field set for Action results — kept as one fragment so query and
 * each mutation return the same shape and our parser stays trivial.
 */
const ACTION_FIELDS = /* GraphQL */ `
  id
  type
  deploymentID
  allocationID
  amount
  poi
  status
  source
  reason
  priority
  transaction
  failureReason
`;

const ACTIONS_QUERY = /* GraphQL */ `
  query Actions($filter: ActionFilter) {
    actions(filter: $filter) {
      ${ACTION_FIELDS}
    }
  }
`;

const QUEUE_ACTIONS_MUTATION = /* GraphQL */ `
  mutation QueueActions($actions: [ActionInput!]!) {
    queueActions(actions: $actions) {
      ${ACTION_FIELDS}
    }
  }
`;

// Schema verification (2026-05-25) against the canonical indexer-agent at
// https://github.com/graphprotocol/indexer/blob/main/packages/indexer-common/src/indexer-management/client.ts
// turned up two relevant facts that shape the mutations below:
//
//   1. `approveActions(actionIDs: [String!]!): [Action]!` and
//      `cancelActions(actionIDs: [String!]!): [Action]!` BOTH exist as
//      first-class mutations. The previous fix-pass note that "approve is a
//      guessed mutation that should be routed through updateActions" was
//      incorrect — both canonical mutations are restored below.
//
//   2. `ActionFilter` has only a singular `id: Int` field — no `id_in`,
//      `ids`, or `actionIDs` for bulk filtering. So the
//      `updateActions(filter: { id_in: [...] }, ...)` shape we briefly used
//      to emulate bulk approve/cancel could never have worked anyway; the
//      schema does not support bulk filter-by-id-list.
//
// Quirk worth noting: `Action.id` is `Int!` in the schema, yet
// `approveActions` / `cancelActions` accept `[String!]!`. We pass the agent-
// supplied id straight back as a string (the agent stringifies it in JSON
// transit) and that matches what indexer-cli does in practice.
const APPROVE_ACTIONS_MUTATION = /* GraphQL */ `
  mutation ApproveActions($actionIDs: [String!]!) {
    approveActions(actionIDs: $actionIDs) {
      ${ACTION_FIELDS}
    }
  }
`;

const CANCEL_ACTIONS_MUTATION = /* GraphQL */ `
  mutation CancelActions($actionIDs: [String!]!) {
    cancelActions(actionIDs: $actionIDs) {
      ${ACTION_FIELDS}
    }
  }
`;

const INDEXING_RULES_QUERY = /* GraphQL */ `
  query IndexingRules($merged: Boolean) {
    indexingRules(merged: $merged) {
      identifier
      identifierType
      allocationAmount
      allocationLifetime
      decisionBasis
      requireSupported
      safety
      custom
    }
  }
`;

const SET_INDEXING_RULE_MUTATION = /* GraphQL */ `
  mutation SetIndexingRule($rule: IndexingRuleInput!) {
    setIndexingRule(rule: $rule) {
      identifier
      identifierType
      allocationAmount
      allocationLifetime
      decisionBasis
      requireSupported
      safety
      custom
    }
  }
`;

const SET_COST_MODEL_MUTATION = /* GraphQL */ `
  mutation SetCostModel($costModel: CostModelInput!) {
    setCostModel(costModel: $costModel) {
      deployment
      model
      variables
    }
  }
`;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface ActionsResponse {
  actions: Action[];
}
interface QueueActionsResponse {
  queueActions: Action[];
}
interface ApproveActionsResponse {
  approveActions: Action[];
}
interface CancelActionsResponse {
  cancelActions: Action[];
}
interface IndexingRulesResponse {
  indexingRules: IndexingRule[];
}
interface SetIndexingRuleResponse {
  setIndexingRule: IndexingRule;
}
interface SetCostModelResponse {
  setCostModel: CostModel;
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export interface IndexerAgentClientOptions {
  /** Full GraphQL endpoint, e.g. `http://localhost:18000/graphql`. */
  endpoint: string;
}

/**
 * Optional per-call options for client methods. `signal` is forwarded to the
 * GraphQL client so caller-initiated cancellation aborts the in-flight fetch.
 */
export interface IndexerAgentCallOpts {
  signal?: AbortSignal;
}

export interface IndexerAgentClient {
  /**
   * @param statusFilter Pass `'all'` (default) for no filter, otherwise an
   * Action status. The agent's `actions(filter:)` argument is an object; we
   * translate the simple status string into `{ status }` here.
   */
  getActionQueue(statusFilter?: string, opts?: IndexerAgentCallOpts): Promise<Action[]>;
  queueActions(actions: ActionInput[], opts?: IndexerAgentCallOpts): Promise<Action[]>;
  approveActions(actionIds: string[], opts?: IndexerAgentCallOpts): Promise<Action[]>;
  cancelActions(actionIds: string[], opts?: IndexerAgentCallOpts): Promise<Action[]>;
  getIndexingRules(opts?: IndexerAgentCallOpts): Promise<IndexingRule[]>;
  setIndexingRule(
    rule: Partial<IndexingRule> & { identifier: string },
    opts?: IndexerAgentCallOpts,
  ): Promise<IndexingRule>;
  setCostModel(
    model: {
      deployment: string;
      model: string;
      variables?: string;
    },
    opts?: IndexerAgentCallOpts,
  ): Promise<CostModel>;
}

/**
 * Construct an `IndexerAgentClient` bound to the given endpoint. The
 * underlying GraphQL client handles retries on transient failures and
 * emits a `[gql indexer-agent]` line to stderr per attempt.
 */
export function createIndexerAgentClient(
  opts: IndexerAgentClientOptions,
): IndexerAgentClient {
  const gql: TypedGraphqlClient = createGraphqlClient({
    endpoint: opts.endpoint,
    label: 'indexer-agent',
  });

  return {
    async getActionQueue(
      statusFilter?: string,
      callOpts?: IndexerAgentCallOpts,
    ): Promise<Action[]> {
      // 'all' / undefined → omit the filter entirely so the agent returns
      // every action regardless of state.
      const filter =
        statusFilter && statusFilter !== 'all' ? { status: statusFilter } : undefined;
      const res = await gql.request<ActionsResponse>(
        ACTIONS_QUERY,
        { filter },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.actions ?? [];
    },

    async queueActions(
      actions: ActionInput[],
      callOpts?: IndexerAgentCallOpts,
    ): Promise<Action[]> {
      // The agent expects each ActionInput to carry source/reason/priority.
      // Callers (tools) populate those before calling us so this is a
      // pass-through.
      const res = await gql.request<QueueActionsResponse>(
        QUEUE_ACTIONS_MUTATION,
        { actions },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.queueActions ?? [];
    },

    async approveActions(
      actionIds: string[],
      callOpts?: IndexerAgentCallOpts,
    ): Promise<Action[]> {
      // Canonical `approveActions(actionIDs: [String!]!)` mutation — see
      // schema comment above the mutation declaration for verification source.
      const res = await gql.request<ApproveActionsResponse>(
        APPROVE_ACTIONS_MUTATION,
        { actionIDs: actionIds },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.approveActions ?? [];
    },

    async cancelActions(
      actionIds: string[],
      callOpts?: IndexerAgentCallOpts,
    ): Promise<Action[]> {
      // Canonical `cancelActions(actionIDs: [String!]!)` mutation — preserves
      // cancellation-specific resolver behaviour (cleanup, dependent-action
      // handling) that a generic status update would bypass.
      const res = await gql.request<CancelActionsResponse>(
        CANCEL_ACTIONS_MUTATION,
        { actionIDs: actionIds },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.cancelActions ?? [];
    },

    async getIndexingRules(callOpts?: IndexerAgentCallOpts): Promise<IndexingRule[]> {
      // `merged: true` returns deployment rules with their group/global
      // defaults applied — usually what an operator wants to inspect.
      const res = await gql.request<IndexingRulesResponse>(
        INDEXING_RULES_QUERY,
        { merged: true },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.indexingRules ?? [];
    },

    async setIndexingRule(
      rule: Partial<IndexingRule> & { identifier: string },
      callOpts?: IndexerAgentCallOpts,
    ): Promise<IndexingRule> {
      // TODO: verify against live agent schema — `identifierType` defaults to
      // `'deployment'` in the agent if omitted; we send what the caller gives
      // us. `safety` / `custom` are forwarded as-is.
      const res = await gql.request<SetIndexingRuleResponse>(
        SET_INDEXING_RULE_MUTATION,
        { rule },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.setIndexingRule;
    },

    async setCostModel(
      model: {
        deployment: string;
        model: string;
        variables?: string;
      },
      callOpts?: IndexerAgentCallOpts,
    ): Promise<CostModel> {
      const res = await gql.request<SetCostModelResponse>(
        SET_COST_MODEL_MUTATION,
        { costModel: model },
        callOpts?.signal ? { signal: callOpts.signal } : undefined,
      );
      return res.setCostModel;
    },
  };
}
