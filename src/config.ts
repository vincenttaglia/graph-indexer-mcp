import { z } from 'zod';

export const accessLevelSchema = z.enum([
  'read_only',
  'read_write',
  'read_write_destructive',
  'full',
]);

export type AccessLevel = z.infer<typeof accessLevelSchema>;

const accessOverridesSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

export const configSchema = z.object({
  indexerAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-character hex address'),

  networkSubgraphUrl: z.url(),
  eboSubgraphUrl: z.url(),
  qosSubgraphUrl: z.url(),
  graphNodeStatusUrl: z.url(),
  indexerAgentUrl: z.url(),
  graphmanApiUrl: z.url(),
  graphmanAuthToken: z.string().min(1),

  graphmanKubectlNamespace: z.string().default('default'),
  graphmanPodLabel: z.string().default('app=graph-node'),
  graphmanConfigPath: z.string().default('/etc/graph-node/config.toml'),

  graphNodePostgresUrl: z.url().optional(),

  accessLevel: accessLevelSchema.default('read_write'),
  accessOverrides: accessOverridesSchema.default({ allow: [], deny: [] }),

  maxAllocations: z.coerce.number().int().positive().default(15),
  maxAllocationPct: z.coerce.number().min(0).max(1).default(0.25),
  riskyDeploymentCapPct: z.coerce.number().min(0).max(1).default(0.05),
  minSignal: z.coerce.number().nonnegative().default(100),
  /**
   * Gas budget per allocation lifecycle (open + close), denominated in GRT.
   *
   * Default 0.3 GRT covers Arbitrum One single-mode (non-batched) lifecycle
   * cost with modest headroom. Real-world observed by an operator running
   * on Arbitrum One:
   *
   *   - Single action (one allocate OR one close): ~$0.01 = ~0.1 GRT
   *     at GRT ≈ $0.10
   *   - Single lifecycle (open + close, 2 actions): ~$0.02 = ~0.2 GRT
   *   - Batched (~100 actions in one tx): ~$0.02 / 100 = ~$0.0002/action
   *     = ~0.004 GRT per lifecycle when batched
   *
   * The default of 0.3 GRT covers the single-mode lifecycle (0.2 GRT)
   * with 50% headroom for gas-price spikes and GRT/ETH price swings.
   * Operators using batched action queues (typical via indexer-agent)
   * can override to 0.01 or lower.
   *
   * The optimizer's gas-floor filter is `projectedReward < 2 × gasEstimateGrt`,
   * so at the 0.3 GRT default it admits any deployment expected to
   * earn at least 0.6 GRT/year. This filters dust signal without
   * excluding real opportunities on Arbitrum.
   */
  gasEstimateGrt: z.coerce.number().nonnegative().default(0.3),

  whitelist: z.array(z.string()).default([]),
  blacklist: z.array(z.string()).default([]),
  frozenlist: z.array(z.string()).default([]),
  riskyDeployments: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof configSchema>;

function csv(s: string | undefined): string[] {
  return s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

function envToConfigInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    indexerAddress: env.INDEXER_ADDRESS,
    networkSubgraphUrl: env.NETWORK_SUBGRAPH_URL,
    eboSubgraphUrl: env.EBO_SUBGRAPH_URL,
    qosSubgraphUrl: env.QOS_SUBGRAPH_URL,
    graphNodeStatusUrl: env.GRAPH_NODE_STATUS_URL,
    indexerAgentUrl: env.INDEXER_AGENT_URL,
    graphmanApiUrl: env.GRAPHMAN_API_URL,
    graphmanAuthToken: env.GRAPHMAN_AUTH_TOKEN,
    graphmanKubectlNamespace: env.GRAPHMAN_KUBECTL_NAMESPACE,
    graphmanPodLabel: env.GRAPHMAN_POD_LABEL,
    graphmanConfigPath: env.GRAPHMAN_CONFIG_PATH,
    graphNodePostgresUrl: env.GRAPH_NODE_POSTGRES_URL || undefined,
    accessLevel: env.ACCESS_LEVEL,
    accessOverrides: {
      allow: csv(env.ACCESS_OVERRIDES_ALLOW),
      deny: csv(env.ACCESS_OVERRIDES_DENY),
    },
    maxAllocations: env.MAX_ALLOCATIONS,
    maxAllocationPct: env.MAX_ALLOCATION_PCT,
    riskyDeploymentCapPct: env.RISKY_DEPLOYMENT_CAP_PCT,
    minSignal: env.MIN_SIGNAL,
    gasEstimateGrt: env.GAS_ESTIMATE_GRT,
    whitelist: csv(env.WHITELIST),
    blacklist: csv(env.BLACKLIST),
    frozenlist: csv(env.FROZENLIST),
    riskyDeployments: csv(env.RISKY_DEPLOYMENTS),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input = envToConfigInput(env);
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
