import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from '../config.js';
import { registerIndexerTool } from '../server/register.js';

import type { EboSubgraphClient } from '../clients/ebo-subgraph.js';
import type { GraphmanClient } from '../clients/graphman.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { IndexerAgentClient } from '../clients/indexer-agent.js';
import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { PostgresClient } from '../clients/postgres.js';
import type { QosSubgraphClient } from '../clients/qos-subgraph.js';

import {
  AllocationOptimizer,
  type OptimizerConfig,
} from '../services/allocation-optimizer.js';
import { HealthMonitor } from '../services/health-monitor.js';
import {
  DiscoveryEngine,
  type DiscoveryConfig,
} from '../services/discovery-engine.js';

import { buildOverview } from '../resources/overview.js';

export interface CompositeToolDeps {
  config: Config;
  networkClient: NetworkSubgraphClient;
  eboClient: EboSubgraphClient;
  qosClient: QosSubgraphClient;
  graphNodeClient: GraphNodeClient;
  postgresClient: PostgresClient | null;
  agentClient: IndexerAgentClient;
  graphmanClient: GraphmanClient;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function asText(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, bigIntReplacer, 2) },
    ],
  };
}

/**
 * Convert a GRT human-units decimal string (e.g. "100", "0.5") into wei
 * (1 GRT = 1e18 wei) as a decimal-integer string. Throws on garbage input.
 * Used because config.minSignal / config.gasEstimateGrt are GRT integers
 * (parsed from env via z.coerce.number) and the services expect wei.
 */
function grtToWei(grt: string | number): string {
  const s = typeof grt === 'number' ? grt.toString() : grt;
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(
      `Expected non-negative GRT decimal (got: ${JSON.stringify(grt)}).`,
    );
  }
  // Avoid float math: split on decimal, pad fractional part to 18 places.
  const [intPart, fracPart = ''] = s.split('.');
  const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18);
  return (BigInt(intPart ?? '0') * 10n ** 18n + BigInt(paddedFrac)).toString();
}

const GRT_DECIMAL = /^\d+(\.\d+)?$/;

export function registerCompositeTools(
  server: McpServer,
  deps: CompositeToolDeps,
): void {
  const optimizer = new AllocationOptimizer({
    networkClient: deps.networkClient,
    graphNodeClient: deps.graphNodeClient,
    graphmanClient: deps.graphmanClient,
    qosClient: deps.qosClient,
    agentClient: deps.agentClient,
  });

  const healthMonitor = new HealthMonitor({
    networkClient: deps.networkClient,
    eboClient: deps.eboClient,
    graphNodeClient: deps.graphNodeClient,
    graphmanClient: deps.graphmanClient,
    agentClient: deps.agentClient,
  });

  const discoveryEngine = new DiscoveryEngine({
    networkClient: deps.networkClient,
    qosClient: deps.qosClient,
    graphNodeClient: deps.graphNodeClient,
    postgresClient: deps.postgresClient,
    graphmanClient: deps.graphmanClient,
    agentClient: deps.agentClient,
  });

  // ---------------------------------------------------------------------------
  // run_allocation_optimization
  // ---------------------------------------------------------------------------
  // Produces an OptimizationResult plan. Does NOT queue actions. Operators
  // execute via queue_allocate / queue_unallocate / queue_reallocate after
  // reviewing the plan. Permission stays at 'read' because no on-chain
  // mutation is performed here.
  registerIndexerTool(server, {
    name: 'run_allocation_optimization',
    permissionClass: 'read',
    description:
      'Run the full §4.1 allocation optimization workflow: gather state ' +
      '(stake, allocations, signal, indexing status, pause map, query volume), ' +
      'filter candidates, score by APR with caps, and return a structured plan ' +
      'with proposed allocations + diff actions (allocate / unallocate / ' +
      'reallocate). Does NOT queue actions — operator reviews the plan and ' +
      'executes via queue_* tools.',
    inputSchema: {
      blocks_per_year: z.coerce
        .number()
        .int()
        .positive()
        .describe(
          'Blocks per year on the chain hosting the network subgraph. ' +
            'Required, no default — chain-dependent (Ethereum mainnet ~2,628,000; ' +
            'Arbitrum One ~10,512,000 at 3s block time).',
        ),
      indexer_address: z
        .string()
        .regex(EVM_ADDRESS)
        .optional()
        .describe('Override INDEXER_ADDRESS for this run.'),
      max_allocations: z.coerce.number().int().positive().optional(),
      max_allocation_pct: z.coerce.number().min(0).max(1).optional(),
      risky_deployment_cap_pct: z.coerce.number().min(0).max(1).optional(),
      min_signal_grt: z
        .string()
        .regex(GRT_DECIMAL)
        .optional()
        .describe('Minimum curation signal in GRT (decimal). Overrides MIN_SIGNAL.'),
      gas_estimate_grt: z
        .string()
        .regex(GRT_DECIMAL)
        .optional()
        .describe('Gas budget per allocation lifecycle in GRT (decimal).'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const optConfig: OptimizerConfig = {
        indexerAddress: args.indexer_address ?? deps.config.indexerAddress,
        maxAllocations: args.max_allocations ?? deps.config.maxAllocations,
        maxAllocationPct: args.max_allocation_pct ?? deps.config.maxAllocationPct,
        riskyDeploymentCapPct:
          args.risky_deployment_cap_pct ?? deps.config.riskyDeploymentCapPct,
        minSignal: grtToWei(args.min_signal_grt ?? deps.config.minSignal),
        gasEstimateGrt: grtToWei(
          args.gas_estimate_grt ?? deps.config.gasEstimateGrt,
        ),
        blocksPerYear: args.blocks_per_year,
        whitelist: deps.config.whitelist,
        blacklist: deps.config.blacklist,
        frozenlist: deps.config.frozenlist,
        riskyDeployments: deps.config.riskyDeployments,
      };
      const result = await optimizer.run(optConfig, { signal: extra.signal });
      return asText(result);
    },
  });

  // ---------------------------------------------------------------------------
  // run_health_check
  // ---------------------------------------------------------------------------
  // Produces a HealthCheckResult: per-allocation classification, close plan,
  // recovery plan. Does NOT queue closes or execute graphman recovery —
  // operator reviews and executes via queue_unallocate + graphman_* tools.
  registerIndexerTool(server, {
    name: 'run_health_check',
    permissionClass: 'read',
    description:
      'Run the full §4.2 pre-epoch health check: classify every active ' +
      'allocation against the closability matrix (Path A / Path B / none), ' +
      'assess risk by epoch urgency + allocation size + degradation, and ' +
      'generate a close plan + graphman recovery plan for failed deployments. ' +
      'Does NOT queue closes or execute graphman recovery — operator reviews ' +
      'and executes individually.',
    inputSchema: {
      indexer_address: z
        .string()
        .regex(EVM_ADDRESS)
        .optional()
        .describe('Override INDEXER_ADDRESS for this run.'),
      urgency_threshold_hours: z.coerce
        .number()
        .positive()
        .default(6)
        .describe(
          'Hours-until-epoch-flip threshold for the "urgent" risk component.',
        ),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const result = await healthMonitor.run({
        indexerAddress: args.indexer_address ?? deps.config.indexerAddress,
        urgencyThresholdHours: args.urgency_threshold_hours,
        signal: extra.signal,
      });
      return asText(result);
    },
  });

  // ---------------------------------------------------------------------------
  // run_discovery
  // ---------------------------------------------------------------------------
  // Produces a DiscoveryResult: stale deployments + cleanup steps, new
  // opportunities ranked by §4.3 score, and recommended offchain indexing
  // rules. Does NOT execute cleanup steps or set indexing rules — operator
  // reviews and executes via graphman_* / set_indexing_rule.
  registerIndexerTool(server, {
    name: 'run_discovery',
    permissionClass: 'read',
    description:
      'Run the full §4.3 cleanup + discovery workflow: identify stale ' +
      'deployments and produce ordered cleanup steps (close → pause → ' +
      'unassign → unused_record → unused_remove); find new high-value ' +
      'deployments to sync and rank by score = apr*0.4 + volume*0.3 + ' +
      'signal*0.2 - cost*0.1. Does NOT execute cleanup or set indexing ' +
      'rules — operator reviews and executes individually.',
    inputSchema: {
      blocks_per_year: z.coerce
        .number()
        .int()
        .positive()
        .describe(
          'Blocks per year on the chain hosting the network subgraph. ' +
            'Required, no default — chain-dependent.',
        ),
      typical_allocation_grt: z
        .string()
        .regex(GRT_DECIMAL)
        .describe(
          'Typical allocation size in GRT (decimal) — used to project APR ' +
            'for discovered opportunities. A reasonable default is ' +
            'total_stake_grt / max_allocations.',
        ),
      indexer_address: z
        .string()
        .regex(EVM_ADDRESS)
        .optional()
        .describe('Override INDEXER_ADDRESS for this run.'),
      max_candidates: z.coerce.number().int().positive().max(500).default(10),
      min_signal_grt: z
        .string()
        .regex(GRT_DECIMAL)
        .optional()
        .describe('Minimum curation signal in GRT (decimal). Overrides MIN_SIGNAL.'),
    },
    handler: async (args, extra) => {
      extra.signal.throwIfAborted();
      const discoveryConfig: DiscoveryConfig = {
        indexerAddress: args.indexer_address ?? deps.config.indexerAddress,
        minSignal: BigInt(
          grtToWei(args.min_signal_grt ?? deps.config.minSignal),
        ),
        typicalAllocationGrt: BigInt(grtToWei(args.typical_allocation_grt)),
        blocksPerYear: args.blocks_per_year,
        whitelist: deps.config.whitelist,
        blacklist: deps.config.blacklist,
        frozenlist: deps.config.frozenlist,
        maxCandidates: args.max_candidates,
      };
      const result = await discoveryEngine.run(discoveryConfig, {
        signal: extra.signal,
      });
      return asText(result);
    },
  });

  // ---------------------------------------------------------------------------
  // get_infrastructure_overview
  // ---------------------------------------------------------------------------
  // Tool wrapper around the indexer://overview resource so MCP clients that
  // don't surface resources (or that prefer tool-shaped output) can still get
  // the aggregated infrastructure summary.
  registerIndexerTool(server, {
    name: 'get_infrastructure_overview',
    permissionClass: 'read',
    description:
      'Aggregate key metrics across all data sources: indexer stake, ' +
      'active allocations, deployment counts by health, disk usage, paused ' +
      'count. Best-effort: per-source failures are recorded in partialErrors ' +
      'rather than failing the whole call. Same payload as the ' +
      'indexer://overview resource.',
    handler: async (_args, extra) => {
      extra.signal.throwIfAborted();
      const payload = await buildOverview(
        {
          config: deps.config,
          networkClient: deps.networkClient,
          graphNodeClient: deps.graphNodeClient,
          postgresClient: deps.postgresClient,
          graphmanClient: deps.graphmanClient,
        },
        extra.signal,
      );
      return asText(payload);
    },
  });
}
