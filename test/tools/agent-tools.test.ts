/**
 * Tests for the agent control-plane MCP tools (src/tools/agent-tools.ts).
 *
 * Initial coverage targets the POI handling on `queue_unallocate` and
 * `queue_reallocate`. The original bug was that those tools' Zod input
 * schemas marked `poi: string` as REQUIRED, so any call without a POI was
 * rejected at the MCP layer with `poi: expected string, received undefined`
 * — even though the wire-layer `ActionInput.poi` is optional and the
 * indexer-agent supports computing the POI itself at close time.
 *
 * The fix removes the `poi` string parameter entirely (POI generation is a
 * graph-node concern; Claude has no business hand-crafting one) and replaces
 * it with a boolean `force_zero_poi` flag:
 *   - false (default): omit POI from the queued ActionInput → agent computes
 *     a real POI at close time and the allocation claims rewards.
 *   - true: send the all-zero POI sentinel → agent closes the allocation
 *     without claiming rewards.
 *
 * These tests assert both branches for both tools, including the
 * load-bearing property that the `ActionInput` posted to the indexer-agent
 * client has NO `poi` field at all in the default branch (so the agent's
 * compute-POI path is reached), and that the all-zero POI sentinel goes on
 * the wire in the forfeit branch.
 *
 * Test strategy: rather than spin up the full McpServer + transport, we use a
 * fake server that captures each `registerTool(name, {inputSchema}, cb)` call.
 * We then validate the test's raw args through the captured Zod inputSchema
 * (mirroring what the real SDK does before invoking the callback) and
 * dispatch the parsed args to the captured callback. The fake
 * `IndexerAgentClient` records the `ActionInput[]` posted to `queueActions`
 * so we can assert on exactly what would have gone on the wire.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z, type ZodRawShape } from 'zod';

import { registerAgentTools } from '../../src/tools/agent-tools.js';
import {
  initAccessControl,
  resetForTests as resetAccessControl,
} from '../../src/access-control.js';
import type { Config } from '../../src/config.js';
import type { IndexerAgentClient } from '../../src/clients/indexer-agent.js';
import type { NetworkSubgraphClient } from '../../src/clients/network-subgraph.js';
import type { Allocation } from '../../src/types/network.js';
import type { Action, ActionInput } from '../../src/types/agent.js';

const ZERO_POI = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// Fake McpServer that records registerTool() calls.
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description?: string;
  inputSchema?: ZodRawShape;
  cb: (...args: unknown[]) => unknown;
}

interface FakeServer {
  tools: Map<string, CapturedTool>;
  registerTool: (
    name: string,
    config: { description?: string; inputSchema?: ZodRawShape },
    cb: (...args: unknown[]) => unknown,
  ) => void;
}

function makeFakeServer(): FakeServer {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    registerTool(name, config, cb) {
      tools.set(name, {
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        cb,
      });
    },
  };
}

/**
 * Mimic the MCP SDK's input-validation step: parse `rawArgs` through the
 * tool's Zod input schema (built from the registered raw shape) and pass the
 * parsed args to the registered callback. Returns the callback's resolved
 * value. Throws (just like the SDK would) if Zod validation fails.
 */
async function invokeTool(
  server: FakeServer,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  const tool = server.tools.get(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  if (!tool.inputSchema) {
    return await tool.cb({ signal: new AbortController().signal });
  }
  const parsed = z.object(tool.inputSchema).parse(rawArgs);
  return await tool.cb(parsed, { signal: new AbortController().signal });
}

// ---------------------------------------------------------------------------
// Fake IndexerAgentClient that records queueActions calls.
// ---------------------------------------------------------------------------

interface CapturingAgentClient extends IndexerAgentClient {
  queuedActions: ActionInput[][];
  /**
   * Each `setIndexingRule` call records the rule arg verbatim (structural
   * copy) so tests can assert on which fields the tool injected vs. forwarded.
   */
  setRuleCalls: Array<Partial<import('../../src/types/agent.js').IndexingRule> & { identifier: string }>;
  /**
   * Every `setCostModel` call's input payload, captured verbatim. We
   * record the raw object the tool handler hands the client so tests can
   * assert on EXACTLY which fields appear (in particular: that no
   * `variables` field leaks through, since `CostModelInput` doesn't
   * declare one).
   */
  costModelInputs: Array<Record<string, unknown>>;
}

function makeCapturingAgentClient(): CapturingAgentClient {
  const queuedActions: ActionInput[][] = [];
  const setRuleCalls: CapturingAgentClient['setRuleCalls'] = [];
  const costModelInputs: Array<Record<string, unknown>> = [];
  const client: CapturingAgentClient = {
    queuedActions,
    setRuleCalls,
    costModelInputs,
    async queueActions(actions: ActionInput[]): Promise<Action[]> {
      // Push a structural copy so assertions see the exact shape the handler
      // emitted (in particular: which optional fields the handler set vs.
      // omitted). We must not introduce or strip fields here.
      queuedActions.push(actions.map((a) => ({ ...a })));
      return actions.map((a, i) => ({
        id: String(i),
        type: a.type,
        deploymentID: a.deploymentID,
        ...(a.allocationID !== undefined ? { allocationID: a.allocationID } : {}),
        ...(a.amount !== undefined ? { amount: a.amount } : {}),
        ...(a.poi !== undefined ? { poi: a.poi } : {}),
        status: 'queued',
        source: a.source,
        ...(a.reason !== undefined ? { reason: a.reason } : {}),
        ...(a.priority !== undefined ? { priority: a.priority } : {}),
      }));
    },
    async getActionQueue() {
      return [];
    },
    async approveActions() {
      return [];
    },
    async cancelActions() {
      return [];
    },
    async getIndexingRules() {
      return [];
    },
    async setIndexingRule(rule) {
      // Record a structural copy so tests can assert on exactly which
      // fields the tool layer constructed vs. forwarded — in particular
      // the protocolNetwork-injection contract.
      setRuleCalls.push({ ...rule });
      return {
        identifier: rule.identifier,
        identifierType: rule.identifierType ?? 'deployment',
        decisionBasis: rule.decisionBasis ?? 'rules',
        // Required by the IndexingRule schema shape; echo back what the
        // tool sent so the fake matches a real agent's response shape.
        protocolNetwork: rule.protocolNetwork ?? 'arbitrum-one',
      };
    },
    async setCostModel(model) {
      // Record the exact object the handler passed in (structural copy so
      // later mutations can't affect the captured shape).
      costModelInputs.push({ ...(model as Record<string, unknown>) });
      return { deployment: model.deployment, model: model.model };
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_DEPLOYMENT = 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh52';
const VALID_ALLOCATION = '0x1234567890123456789012345678901234567890';

/**
 * Minimal NetworkSubgraphClient fake. Only `getAllocationById` is exercised
 * by the agent-tools tests (the unallocate / reallocate handlers call it to
 * look up `isLegacy`). The default returns a Horizon-era allocation
 * (`isLegacy: false`); per-test overrides go through the `isLegacy` option.
 */
function makeFakeNetworkClient(opts: { isLegacy?: boolean } = {}): NetworkSubgraphClient {
  const isLegacy = opts.isLegacy ?? false;
  return {
    async getAllocationById(id): Promise<Allocation | null> {
      return {
        id,
        indexer: { id: '0x0000000000000000000000000000000000000000' },
        subgraphDeployment: {
          id: '0x' + '00'.repeat(32),
          signalledTokens: '0',
          stakedTokens: '0',
          deniedAt: 0,
        },
        allocatedTokens: '0',
        createdAtEpoch: 0,
        status: 'Active',
        isLegacy,
      };
    },
    // The other methods aren't exercised — return safe defaults that keep
    // the type contract honest if anyone reaches for them.
    async getIndexer() {
      return null;
    },
    async getActiveAllocations() {
      return { items: [], truncated: false };
    },
    async getAllocations() {
      return { items: [], truncated: false };
    },
    async getDeployment() {
      return null;
    },
    async getSignalledDeployments() {
      return { items: [], truncated: false };
    },
    async getNetworkParameters() {
      throw new Error('not implemented in agent-tools test fake');
    },
    async getDeploymentAllocations() {
      return { items: [], truncated: false };
    },
  };
}

function setupTools(
  netOpts: { isLegacy?: boolean } = {},
): { server: FakeServer; client: CapturingAgentClient } {
  resetAccessControl();
  initAccessControl({ level: 'full', allow: new Set(), deny: new Set() });
  const server = makeFakeServer();
  const client = makeCapturingAgentClient();
  const networkClient = makeFakeNetworkClient(netOpts);
  // Only `protocolNetwork` is read by the agent-tools handlers; cast the
  // rest as a minimal partial that satisfies the dep contract.
  const config = { protocolNetwork: 'arbitrum-one' } as unknown as Config;
  registerAgentTools(
    server as unknown as Parameters<typeof registerAgentTools>[0],
    { client, networkClient, config },
  );
  return { server, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-tools: queue_unallocate POI handling', () => {
  beforeEach(() => {
    resetAccessControl();
  });
  afterEach(() => {
    resetAccessControl();
  });

  it('does NOT accept a hand-crafted `poi` string — schema has no poi key', async () => {
    const { server, client } = setupTools();
    // The schema must not declare a `poi` input. Zod's default behaviour for
    // `z.object()` is to strip unknown keys, so passing a hand-crafted POI
    // either errors (strict mode) or is silently dropped. Either way the
    // resulting ActionInput must NOT carry the caller's POI to the agent —
    // POI generation is a graph-node concern and exposing it as a free-form
    // tool input is a footgun for the operator's revenue.
    let threw = false;
    try {
      await invokeTool(server, 'queue_unallocate', {
        deployment_id: VALID_DEPLOYMENT,
        allocation_id: VALID_ALLOCATION,
        // Hand-crafted POI a misbehaving caller might try to sneak in.
        poi: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      });
    } catch {
      threw = true;
    }
    if (threw) {
      // Schema rejected outright — nothing reached the agent client.
      assert.equal(client.queuedActions.length, 0);
      return;
    }
    // Schema accepted (strip mode): one action queued, with no `poi` field.
    assert.equal(client.queuedActions.length, 1);
    const action = client.queuedActions[0]![0]!;
    assert.equal(
      Object.prototype.hasOwnProperty.call(action, 'poi'),
      false,
      'hand-crafted poi must not be forwarded to the indexer-agent',
    );
  });

  it('default (force_zero_poi omitted): omits poi from the queued ActionInput', async () => {
    const { server, client } = setupTools();
    const result = await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      // force_zero_poi omitted → defaults to false
    });
    assert.ok(result, 'tool returned a result');
    assert.equal(
      (result as { isError?: boolean }).isError,
      undefined,
      'tool did not return isError',
    );
    assert.equal(client.queuedActions.length, 1);
    const batch = client.queuedActions[0]!;
    assert.equal(batch.length, 1);
    const action = batch[0]!;
    assert.equal(action.type, 'unallocate');
    assert.equal(action.deploymentID, VALID_DEPLOYMENT);
    assert.equal(action.allocationID, VALID_ALLOCATION);
    // Load-bearing: the full four-field POI bundle must be absent from the
    // ActionInput so the agent's compute-POI-at-close-time path runs and
    // the allocation claims rewards.
    for (const field of ['poi', 'publicPOI', 'poiBlockNumber', 'force'] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(action, field),
        false,
        `ActionInput must not include a '${field}' field when force_zero_poi is false`,
      );
    }
    // amount is required on every ActionInput even for unallocate; the
    // wizard's convention is the literal '0'.
    assert.equal(action.amount, '0');
  });

  it('force_zero_poi=false (explicit): omits the full POI bundle', async () => {
    const { server, client } = setupTools();
    await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      force_zero_poi: false,
    });
    const action = client.queuedActions[0]![0]!;
    for (const field of ['poi', 'publicPOI', 'poiBlockNumber', 'force'] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(action, field),
        false,
        `explicit force_zero_poi=false must still omit '${field}'`,
      );
    }
  });

  it('force_zero_poi=true: sends the full four-field zero-POI bundle (poi + publicPOI + poiBlockNumber + force)', async () => {
    // Per indexer-tools-v4's wizard `buildPoiFields('0x0')` branch, the
    // forfeit-rewards close is a four-field bundle, not just a zero poi:
    //   poi=0x00…, publicPOI=0x00…, poiBlockNumber=0, force=true
    // The agent re-verifies POIs by default; `force: true` is what tells
    // it to accept the operator-supplied zero POI as-is. Sending only one
    // or two of the four would either be rejected by the agent or claim
    // rewards against an invalid POI.
    const { server, client } = setupTools();
    await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      force_zero_poi: true,
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.poi, ZERO_POI);
    assert.equal(action.publicPOI, ZERO_POI);
    assert.equal(action.poiBlockNumber, 0);
    assert.equal(action.force, true);
    // amount is always set even on unallocate — the agent rejects the
    // mutation otherwise; the wizard's convention is the literal '0'.
    assert.equal(action.amount, '0');
    // The reason string surfaces the forfeit-rewards intent so it shows up
    // in the agent's action history for auditing.
    assert.match(action.reason ?? '', /force_zero_poi/);
  });
});

describe('agent-tools: queue_reallocate POI handling', () => {
  beforeEach(() => {
    resetAccessControl();
  });
  afterEach(() => {
    resetAccessControl();
  });

  it('default (force_zero_poi omitted): omits poi from the queued ActionInput', async () => {
    const { server, client } = setupTools();
    const result = await invokeTool(server, 'queue_reallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      // GRT decimal, NOT wei — see ActionInput.amount docstring.
      new_amount: '100',
    });
    assert.ok(result);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(client.queuedActions.length, 1);
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.type, 'reallocate');
    assert.equal(action.deploymentID, VALID_DEPLOYMENT);
    assert.equal(action.allocationID, VALID_ALLOCATION);
    assert.equal(action.amount, '100');
    for (const field of ['poi', 'publicPOI', 'poiBlockNumber', 'force'] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(action, field),
        false,
        `ActionInput must not include '${field}' when force_zero_poi is false`,
      );
    }
  });

  it('force_zero_poi=true: sends the full four-field zero-POI bundle and keeps new_amount', async () => {
    const { server, client } = setupTools();
    await invokeTool(server, 'queue_reallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      force_zero_poi: true,
      new_amount: '100',
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.poi, ZERO_POI);
    assert.equal(action.publicPOI, ZERO_POI);
    assert.equal(action.poiBlockNumber, 0);
    assert.equal(action.force, true);
    assert.equal(action.amount, '100');
    assert.match(action.reason ?? '', /force_zero_poi/);
  });
});

// ---------------------------------------------------------------------------
// Post-Horizon required ActionInput fields:
//   - status (always 'queued')
//   - protocolNetwork (from config)
//   - isLegacy (looked up from network subgraph for closes; false for opens)
// The indexer-agent's GraphQL `ActionInput!` type rejects the mutation when
// any of the three is missing. These tests assert that every MCP-queued
// action carries them with the right values.
// ---------------------------------------------------------------------------

describe('agent-tools: required wire fields (status / protocolNetwork / isLegacy)', () => {
  beforeEach(() => {
    resetAccessControl();
  });
  afterEach(() => {
    resetAccessControl();
  });

  it('queue_allocate stamps status=queued, protocolNetwork from config, isLegacy=false', async () => {
    // New allocations are always Horizon-era — legacy positions can only
    // exist on the deprecated staking contract that no longer accepts opens.
    const { server, client } = setupTools();
    await invokeTool(server, 'queue_allocate', {
      deployment_id: VALID_DEPLOYMENT,
      // GRT decimal, NOT wei — see ActionInput.amount docstring.
      amount: '100',
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.status, 'queued');
    assert.equal(action.protocolNetwork, 'arbitrum-one');
    assert.equal(action.isLegacy, false);
  });

  it('queue_unallocate looks up isLegacy from the network subgraph (Horizon allocation → false)', async () => {
    const { server, client } = setupTools({ isLegacy: false });
    await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.status, 'queued');
    assert.equal(action.protocolNetwork, 'arbitrum-one');
    assert.equal(action.isLegacy, false);
  });

  it('queue_unallocate looks up isLegacy from the network subgraph (legacy allocation → true)', async () => {
    // Pre-Horizon allocations still need to be closeable via the same MCP
    // tool surface — `isLegacy: true` must be threaded through verbatim so
    // the indexer-agent dispatches the close to the legacy contract.
    const { server, client } = setupTools({ isLegacy: true });
    await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.isLegacy, true);
  });

  it('queue_reallocate looks up isLegacy and propagates it to the queued action', async () => {
    const { server, client } = setupTools({ isLegacy: true });
    await invokeTool(server, 'queue_reallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
      // GRT decimal, NOT wei — see ActionInput.amount docstring.
      new_amount: '100',
    });
    const action = client.queuedActions[0]![0]!;
    assert.equal(action.status, 'queued');
    assert.equal(action.protocolNetwork, 'arbitrum-one');
    assert.equal(action.isLegacy, true);
  });

  it('queue_unallocate throws when the allocation cannot be found in the network subgraph', async () => {
    // Without isLegacy we cannot construct a valid ActionInput. Failing
    // fast here is better than letting the agent reject the mutation
    // (the operator sees a clearer error pointing at the lookup).
    resetAccessControl();
    initAccessControl({ level: 'full', allow: new Set(), deny: new Set() });
    const server = makeFakeServer();
    const client = makeCapturingAgentClient();
    const networkClient: NetworkSubgraphClient = {
      async getAllocationById() {
        return null;
      },
      async getIndexer() {
        return null;
      },
      async getActiveAllocations() {
        return { items: [], truncated: false };
      },
      async getAllocations() {
        return { items: [], truncated: false };
      },
      async getDeployment() {
        return null;
      },
      async getSignalledDeployments() {
        return { items: [], truncated: false };
      },
      async getNetworkParameters() {
        throw new Error('not implemented');
      },
      async getDeploymentAllocations() {
        return { items: [], truncated: false };
      },
    };
    const config = { protocolNetwork: 'arbitrum-one' } as unknown as Config;
    registerAgentTools(
      server as unknown as Parameters<typeof registerAgentTools>[0],
      { client, networkClient, config },
    );
    // registerIndexerTool catches thrown errors and returns an isError
    // result rather than rejecting the promise — assert on that shape.
    const result = (await invokeTool(server, 'queue_unallocate', {
      deployment_id: VALID_DEPLOYMENT,
      allocation_id: VALID_ALLOCATION,
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true, 'must surface as an error result');
    assert.match(
      result.content?.[0]?.text ?? '',
      /allocation .* not found/,
      `error message must point at the missing-allocation lookup; got: ${JSON.stringify(result)}`,
    );
    // Nothing was queued — the tool errored before reaching the agent.
    assert.equal(client.queuedActions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// set_indexing_rule: schema-required `protocolNetwork` injection.
//
// The agent's `IndexingRuleInput!` requires `protocolNetwork` (same class of
// post-Horizon schema bug as the ActionInput protocolNetwork case). The tool
// must inject it from `config.protocolNetwork` and refuse to let a caller
// override it via `rule_params`.
// ---------------------------------------------------------------------------

describe('agent-tools: set_indexing_rule protocolNetwork injection', () => {
  beforeEach(() => {
    resetAccessControl();
  });
  afterEach(() => {
    resetAccessControl();
  });

  it('injects protocolNetwork from config on every rule write', async () => {
    const { server, client } = setupTools();
    await invokeTool(server, 'set_indexing_rule', {
      deployment_id: VALID_DEPLOYMENT,
      rule_params: {
        allocationAmount: '1000000000000000000',
        decisionBasis: 'rules',
      },
    });
    assert.equal(client.setRuleCalls.length, 1);
    const rule = client.setRuleCalls[0]!;
    assert.equal(rule.identifier, VALID_DEPLOYMENT);
    assert.equal(rule.identifierType, 'deployment');
    // Load-bearing: the agent's IndexingRuleInput! rejects writes that omit
    // `protocolNetwork`, so the tool MUST inject it from config.
    assert.equal(rule.protocolNetwork, 'arbitrum-one');
    // Caller-supplied params still flow through.
    assert.equal(rule.allocationAmount, '1000000000000000000');
    assert.equal(rule.decisionBasis, 'rules');
  });

  it('rejects `protocolNetwork` supplied via rule_params (reserved key)', async () => {
    // Same belt-and-suspenders contract as `identifier` / `identifierType`:
    // overriding protocolNetwork through rule_params would let the caller
    // write a rule scoped to a different chain than the MCP is configured
    // against. The Zod refine must reject the call outright.
    const { server, client } = setupTools();
    let threw = false;
    try {
      await invokeTool(server, 'set_indexing_rule', {
        deployment_id: VALID_DEPLOYMENT,
        rule_params: {
          protocolNetwork: 'mainnet',
          decisionBasis: 'rules',
        },
      });
    } catch (err) {
      threw = true;
      // The Zod refine message names the three reserved keys; assert that
      // the error mentions protocolNetwork so the operator gets a clear hint.
      assert.match(
        String(err),
        /protocolNetwork/,
        `validation error must name the reserved key; got: ${String(err)}`,
      );
    }
    assert.equal(threw, true, 'schema must reject protocolNetwork in rule_params');
    // Nothing reached the client — validation failed up-front.
    assert.equal(client.setRuleCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// set_cost_model input-shape regression.
//
// The canonical agent schema defines:
//
//   type  CostModel       { deployment: String! model: String variables: String }
//   input CostModelInput  { deployment: String! model: String }
//
// `variables` is OUTPUT-only — sending it on the input causes the agent to
// reject the mutation. These tests assert that the MCP tool surface and the
// `setCostModel` client method together never put a `variables` field on the
// wire, regardless of what extra keys a misbehaving caller tries to pass.
// ---------------------------------------------------------------------------

describe('agent-tools: set_cost_model input shape', () => {
  beforeEach(() => {
    resetAccessControl();
  });
  afterEach(() => {
    resetAccessControl();
  });

  it('passes a { deployment, model } payload to the agent client (happy path)', async () => {
    const { server, client } = setupTools();
    const result = await invokeTool(server, 'set_cost_model', {
      deployment_id: VALID_DEPLOYMENT,
      model: 'default => 0.0001;',
    });
    assert.ok(result);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(client.costModelInputs.length, 1);
    const input = client.costModelInputs[0]!;
    assert.equal(input.deployment, VALID_DEPLOYMENT);
    assert.equal(input.model, 'default => 0.0001;');
    // Load-bearing: `variables` must never appear on the input — it's an
    // output-only field on CostModel; CostModelInput doesn't declare it.
    assert.equal(
      Object.prototype.hasOwnProperty.call(input, 'variables'),
      false,
      'CostModelInput must not carry a `variables` field',
    );
  });

  it('does NOT accept a `variables` tool input — schema has no variables key', async () => {
    // The tool's Zod inputSchema must not declare `variables`. Zod strips
    // unknown keys by default, so a caller that tries to sneak one in
    // either errors (strict) or has it silently dropped (strip). Either
    // way, what reaches the agent client must NOT contain `variables`.
    const { server, client } = setupTools();
    let threw = false;
    try {
      await invokeTool(server, 'set_cost_model', {
        deployment_id: VALID_DEPLOYMENT,
        model: 'default => 0.0001;',
        // Hand-crafted variables payload a misbehaving caller might try.
        variables: '{"foo":"bar"}',
      });
    } catch {
      threw = true;
    }
    if (threw) {
      // Schema rejected outright — nothing reached the agent client.
      assert.equal(client.costModelInputs.length, 0);
      return;
    }
    // Schema accepted (strip mode): one call recorded, with no `variables`.
    assert.equal(client.costModelInputs.length, 1);
    const input = client.costModelInputs[0]!;
    assert.equal(
      Object.prototype.hasOwnProperty.call(input, 'variables'),
      false,
      'caller-supplied `variables` must not be forwarded to the indexer-agent',
    );
    // The deployment + model fields still made it through verbatim.
    assert.equal(input.deployment, VALID_DEPLOYMENT);
    assert.equal(input.model, 'default => 0.0001;');
  });

  it('forwards the `global` sentinel deployment id unmodified', async () => {
    // The agent treats deployment='global' as the fallback model; the MCP
    // must not transform that special value.
    const { server, client } = setupTools();
    await invokeTool(server, 'set_cost_model', {
      deployment_id: 'global',
      model: 'default => 0.00005;',
    });
    assert.equal(client.costModelInputs.length, 1);
    assert.equal(client.costModelInputs[0]!.deployment, 'global');
  });
});
