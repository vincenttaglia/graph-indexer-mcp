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
   * Default 0.0004 GRT reflects Arbitrum One reality for the typical
   * batched-multicall path that indexer-agent uses: an allocate +
   * close roundtrip is ~900k gas, Arbitrum's L2 base fee sits at ~0.01
   * gwei, and the L1 calldata cost amortizes to near zero when several
   * actions share a multicall. That works out to ~9e6 gwei (~9e-6 ETH);
   * at ~$3000 ETH and ~$0.10 GRT that's ~0.0003 GRT per lifecycle. The
   * default rounds up modestly for headroom against gas-price spikes
   * and GRT/ETH price swings.
   *
   * Operators who submit each action individually (no multicall) on a
   * congested day should bump to ~0.003 GRT. Mainnet operators (rare
   * now) should override several orders of magnitude higher — Ethereum
   * L1 gas at 30 gwei × 900k gas is ~$70 = ~0.7 GRT.
   *
   * The optimizer's gas-floor filter is `projectedReward < 2 × gasEstimateGrt`,
   * so at the 0.0004 GRT default it admits any deployment expected to
   * earn at least 0.0008 GRT/year. This is well below any deployment
   * worth allocating to, so the floor mostly filters dust signal rather
   * than real opportunities — which matches the operator expectation
   * on Arbitrum.
   */
  gasEstimateGrt: z.coerce.number().nonnegative().default(0.0004),

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
