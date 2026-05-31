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

/**
 * Boolean-from-env parser. Zod's `z.coerce.boolean()` is wrong for env flags:
 * it does `Boolean(value)`, so ANY non-empty string (including "false") becomes
 * `true`. For an operator kill-switch we want the opposite default of "on" but
 * a real off-switch. This schema accepts a string|boolean|undefined and maps
 * the common falsey spellings (case-insensitive) `'false' | '0' | 'no' | 'off'`
 * → `false`; everything else — including unset — falls through to the field's
 * `.default(...)`.
 */
function envBoolean(defaultValue: boolean): z.ZodType<boolean> {
  return z.preprocess((v) => {
    if (v === undefined || v === null) return defaultValue;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const normalized = v.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      return true;
    }
    return Boolean(v);
  }, z.boolean());
}

export const configSchema = z.object({
  indexerAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-character hex address'),

  /**
   * Protocol-network identifier the indexer-agent submits actions against
   * (`arbitrum-one` post-Horizon migration). The agent's ActionInput
   * GraphQL type requires this field on every queued action — without it,
   * the mutation is rejected at the schema level. Defined alongside
   * INDEXER_ADDRESS because both identify the indexer's on-chain identity.
   */
  protocolNetwork: z.string().min(1).default('arbitrum-one'),

  networkSubgraphUrl: z.url(),
  eboSubgraphUrl: z.url(),
  qosSubgraphUrl: z.url(),
  graphNodeStatusUrl: z.url(),
  indexerAgentUrl: z.url(),
  graphmanApiUrl: z.url(),
  graphmanAuthToken: z.string().min(1),

  // ===== graphman CLI operations — DISABLED: kubectl path removed (MCP runs remote from graph-node).
  // These three env vars served the removed kubectl/CLI-exec path and will
  // return if/when the graphman CLI ops are reimplemented against the GraphQL API. =====
  // graphmanKubectlNamespace: z.string().default('default'),
  // graphmanPodLabel: z.string().default('app=graph-node'),
  // graphmanConfigPath: z.string().default('/etc/graph-node/config.toml'),
  // ===== end disabled kubectl/CLI config =====

  graphNodePostgresUrl: z.url().optional(),

  /**
   * IPFS gateway used by `get_subgraph_manifest` to fetch a deployment's
   * manifest (the deployment ID is its CID). Operators with a local IPFS node
   * should point this at it for guaranteed-pinned, low-latency reads.
   */
  ipfsGatewayUrl: z.url().default('https://ipfs.network.thegraph.com'),
  /** Hard cap on a fetched manifest's size (bytes); over-cap reads fail closed. */
  ipfsMaxBytes: z.coerce.number().int().positive().default(5_000_000),

  /**
   * Operator-supplied `chain alias → { local?, remote? }` map for the read-only
   * `rpc_call` passthrough. The agent selects an alias (never a raw URL); the
   * URL comes from this config. `local` is the indexer's own node (trusted,
   * private); `remote` is third-party/public (may rate-limit, log, or need a
   * key). `rpc_call` is omitted entirely when this map is empty.
   */
  rpcEndpoints: z
    .record(
      z.string(),
      z
        .object({ local: z.url().optional(), remote: z.url().optional() })
        .refine((v) => v.local || v.remote, 'each chain needs a local or remote URL'),
    )
    .default({}),
  /** Kill-switch for third-party (`remote`) RPC egress. Unset → enabled. */
  rpcAllowRemote: envBoolean(true),
  /** Per-request RPC timeout (ms). */
  rpcTimeoutMs: z.coerce.number().int().positive().default(10_000),
  /** Hard cap on an RPC response body's size (bytes); over-cap fails closed. */
  rpcMaxBytes: z.coerce.number().int().positive().default(2_000_000),

  accessLevel: accessLevelSchema.default('read_write'),
  accessOverrides: accessOverridesSchema.default({ allow: [], deny: [] }),

  /**
   * Transport substrate. `stdio` (default) is the existing single-client path;
   * `http` hosts the StreamableHTTP transport for network-reachable, per-request
   * authenticated deployments. Orthogonal to `authz`.
   */
  transport: z.enum(['stdio', 'http']).default('stdio'),

  /**
   * Authorization strategy. `static` (default) is the level-based model;
   * `k8s-rbac` delegates per-tool grants to Kubernetes RBAC and requires
   * `transport === 'http'` (identity only exists on http).
   */
  authz: z.enum(['static', 'k8s-rbac']).default('static'),

  httpPort: z.coerce.number().int().positive().default(8080),
  httpHost: z.string().default('0.0.0.0'),

  /** TokenReview audience for projected service-account tokens (k8s-rbac). */
  k8sApiAudience: z.string().optional(),

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

  /**
   * Minimum projected indexing reward, in GRT over a 28-day window, for a
   * NEW allocation to be opened. Applies only to candidates that don't
   * already have an existing allocation — current allocations are exempt
   * (their close decisions follow the gas floor and a separate overall-APR
   * check).
   *
   * Default 10 GRT / 28 days (~130 GRT/year) filters out marginal-revenue
   * deployments that aren't worth the operational attention of opening a
   * new position, even on Arbitrum where gas is cheap. Set to 0 to disable
   * this floor and admit any candidate that clears the gas floor.
   */
  minRewards28dGrt: z.coerce.number().nonnegative().default(10),

  whitelist: z.array(z.string()).default([]),
  blacklist: z.array(z.string()).default([]),
  frozenlist: z.array(z.string()).default([]),
  riskyDeployments: z.array(z.string()).default([]),
}).refine((c) => !(c.authz === 'k8s-rbac' && c.transport !== 'http'), {
  message:
    "authz='k8s-rbac' requires transport='http' (identity is only available on the http transport). Set MCP_TRANSPORT=http or use MCP_AUTHZ=static.",
  path: ['authz'],
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

/**
 * Parse the `RPC_ENDPOINTS` JSON-object string. A malformed value would
 * otherwise surface as a raw `SyntaxError` deep in Zod's parse; instead we
 * throw a clear, prefixed error the operator can act on. Returns `undefined`
 * when unset so the schema's `.default({})` applies.
 */
function parseRpcEndpoints(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`RPC_ENDPOINTS must be valid JSON: ${detail}`);
  }
}

function envToConfigInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    indexerAddress: env.INDEXER_ADDRESS,
    protocolNetwork: env.PROTOCOL_NETWORK,
    networkSubgraphUrl: env.NETWORK_SUBGRAPH_URL,
    eboSubgraphUrl: env.EBO_SUBGRAPH_URL,
    qosSubgraphUrl: env.QOS_SUBGRAPH_URL,
    graphNodeStatusUrl: env.GRAPH_NODE_STATUS_URL,
    indexerAgentUrl: env.INDEXER_AGENT_URL,
    graphmanApiUrl: env.GRAPHMAN_API_URL,
    graphmanAuthToken: env.GRAPHMAN_AUTH_TOKEN,
    // ===== graphman CLI operations — DISABLED: kubectl path removed (MCP runs remote from graph-node).
    // These served the removed kubectl/CLI-exec path; restore alongside the
    // schema fields above when graphman CLI ops are reimplemented via GraphQL. =====
    // graphmanKubectlNamespace: env.GRAPHMAN_KUBECTL_NAMESPACE,
    // graphmanPodLabel: env.GRAPHMAN_POD_LABEL,
    // graphmanConfigPath: env.GRAPHMAN_CONFIG_PATH,
    // ===== end disabled kubectl/CLI env =====
    graphNodePostgresUrl: env.GRAPH_NODE_POSTGRES_URL || undefined,
    ipfsGatewayUrl: env.IPFS_GATEWAY_URL,
    ipfsMaxBytes: env.IPFS_MAX_BYTES,
    rpcEndpoints: parseRpcEndpoints(env.RPC_ENDPOINTS),
    rpcAllowRemote: env.RPC_ALLOW_REMOTE,
    rpcTimeoutMs: env.RPC_TIMEOUT_MS,
    rpcMaxBytes: env.RPC_MAX_BYTES,
    accessLevel: env.ACCESS_LEVEL,
    accessOverrides: {
      allow: csv(env.ACCESS_OVERRIDES_ALLOW),
      deny: csv(env.ACCESS_OVERRIDES_DENY),
    },
    transport: env.MCP_TRANSPORT,
    authz: env.MCP_AUTHZ,
    httpPort: env.MCP_HTTP_PORT,
    httpHost: env.MCP_HTTP_HOST,
    k8sApiAudience: env.K8S_API_AUDIENCE,
    maxAllocations: env.MAX_ALLOCATIONS,
    maxAllocationPct: env.MAX_ALLOCATION_PCT,
    riskyDeploymentCapPct: env.RISKY_DEPLOYMENT_CAP_PCT,
    minSignal: env.MIN_SIGNAL,
    gasEstimateGrt: env.GAS_ESTIMATE_GRT,
    minRewards28dGrt: env.MIN_REWARDS_GRT_28D,
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
