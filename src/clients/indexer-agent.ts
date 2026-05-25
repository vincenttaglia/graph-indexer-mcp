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

// TODO: verify against live agent schema — the reference indexer-agent uses
// `updateActions(filter, action)` for state transitions. We expose
// approveActions as the common bulk-id case; the underlying mutation accepts
// an ActionFilter with `id` (or `ids`) and an ActionUpdateInput. If the live
// schema uses `ids: [String!]` switch to that.
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

export interface IndexerAgentClient {
  /**
   * @param statusFilter Pass `'all'` (default) for no filter, otherwise an
   * Action status. The agent's `actions(filter:)` argument is an object; we
   * translate the simple status string into `{ status }` here.
   */
  getActionQueue(statusFilter?: string): Promise<Action[]>;
  queueActions(actions: ActionInput[]): Promise<Action[]>;
  approveActions(actionIds: string[]): Promise<Action[]>;
  cancelActions(actionIds: string[]): Promise<Action[]>;
  getIndexingRules(): Promise<IndexingRule[]>;
  setIndexingRule(
    rule: Partial<IndexingRule> & { identifier: string },
  ): Promise<IndexingRule>;
  setCostModel(model: {
    deployment: string;
    model: string;
    variables?: string;
  }): Promise<CostModel>;
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
    async getActionQueue(statusFilter?: string): Promise<Action[]> {
      // 'all' / undefined → omit the filter entirely so the agent returns
      // every action regardless of state.
      const filter =
        statusFilter && statusFilter !== 'all' ? { status: statusFilter } : undefined;
      const res = await gql.request<ActionsResponse>(ACTIONS_QUERY, { filter });
      return res.actions ?? [];
    },

    async queueActions(actions: ActionInput[]): Promise<Action[]> {
      // The agent expects each ActionInput to carry source/reason/priority.
      // Callers (tools) populate those before calling us so this is a
      // pass-through.
      const res = await gql.request<QueueActionsResponse>(QUEUE_ACTIONS_MUTATION, {
        actions,
      });
      return res.queueActions ?? [];
    },

    async approveActions(actionIds: string[]): Promise<Action[]> {
      const res = await gql.request<ApproveActionsResponse>(
        APPROVE_ACTIONS_MUTATION,
        { actionIDs: actionIds },
      );
      return res.approveActions ?? [];
    },

    async cancelActions(actionIds: string[]): Promise<Action[]> {
      const res = await gql.request<CancelActionsResponse>(CANCEL_ACTIONS_MUTATION, {
        actionIDs: actionIds,
      });
      return res.cancelActions ?? [];
    },

    async getIndexingRules(): Promise<IndexingRule[]> {
      // `merged: true` returns deployment rules with their group/global
      // defaults applied — usually what an operator wants to inspect.
      const res = await gql.request<IndexingRulesResponse>(INDEXING_RULES_QUERY, {
        merged: true,
      });
      return res.indexingRules ?? [];
    },

    async setIndexingRule(
      rule: Partial<IndexingRule> & { identifier: string },
    ): Promise<IndexingRule> {
      // TODO: verify against live agent schema — `identifierType` defaults to
      // `'deployment'` in the agent if omitted; we send what the caller gives
      // us. `safety` / `custom` are forwarded as-is.
      const res = await gql.request<SetIndexingRuleResponse>(
        SET_INDEXING_RULE_MUTATION,
        { rule },
      );
      return res.setIndexingRule;
    },

    async setCostModel(model: {
      deployment: string;
      model: string;
      variables?: string;
    }): Promise<CostModel> {
      const res = await gql.request<SetCostModelResponse>(SET_COST_MODEL_MUTATION, {
        costModel: model,
      });
      return res.setCostModel;
    },
  };
}
