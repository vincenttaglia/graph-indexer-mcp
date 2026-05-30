# Configuration reference

All configuration comes from environment variables. They are parsed and validated by `loadConfig()` in `src/config.ts` using a Zod schema; invalid or missing required values cause the process to exit with a list of issues before any I/O.

Comma-separated lists trim whitespace and drop empty entries (`csv()` helper in `src/config.ts`).

---

## Identity

### `INDEXER_ADDRESS` (required)

- **Type:** `string` (0x-prefixed 40-char hex)
- **Validates:** `/^0x[a-fA-F0-9]{40}$/`
- **Example:** `0x1234567890abcdef1234567890abcdef12345678`
- **Purpose:** The indexer's on-chain address. Used as the default `indexer_address` for all tools/services that accept it.

### `PROTOCOL_NETWORK`

- **Type:** `string`, non-empty
- **Default:** `arbitrum-one`
- **Example:** `arbitrum-one`
- **Purpose:** Protocol-network identifier the indexer-agent submits actions against. Required by the agent's `ActionInput!` GraphQL type post-Horizon migration — without it, every `queueActions` mutation is rejected at the schema layer. Defined alongside `INDEXER_ADDRESS` since both identify the indexer's on-chain identity.

---

## Data source endpoints

### `NETWORK_SUBGRAPH_URL` (required)

- **Type:** URL
- **Example:** `https://gateway.thegraph.com/api/KEY/subgraphs/id/DEPLOYMENT_ID`
- **Purpose:** GraphQL endpoint for the indexer-allocation network subgraph (allocations, deployment signal, network parameters).

### `EBO_SUBGRAPH_URL` (required)

- **Type:** URL
- **Example:** `https://gateway.thegraph.com/api/KEY/subgraphs/id/EBO_DEPLOYMENT_ID`
- **Purpose:** GraphQL endpoint for the Epoch Block Oracle subgraph (per-chain epoch start blocks).

### `QOS_SUBGRAPH_URL` (required)

- **Type:** URL
- **Example:** `https://gateway.thegraph.com/api/KEY/subgraphs/id/QOS_DEPLOYMENT_ID`
- **Purpose:** GraphQL endpoint for the gateway QoS / query-stats subgraph (query volume, latency, blocks-behind).

### `GRAPH_NODE_STATUS_URL` (required)

- **Type:** URL
- **Example:** `http://localhost:8030/graphql`
- **Purpose:** graph-node Status API GraphQL endpoint. Used for sync state, health, fatal/non-fatal errors, entity counts.

### `INDEXER_AGENT_URL` (required)

- **Type:** URL
- **Example:** `http://localhost:18000/graphql`
- **Purpose:** indexer-agent Management API GraphQL endpoint. Used for the action queue, indexing rules, cost models.

---

## Graphman

### `GRAPHMAN_API_URL` (required)

- **Type:** URL
- **Example:** `http://localhost:8050`
- **Purpose:** graphman GraphQL endpoint. Used for pause/resume/restart/info/exec-status — the "safe" half of the graphman tool surface.

### `GRAPHMAN_AUTH_TOKEN` (required)

- **Type:** `string`, min length 1
- **Validates:** non-empty
- **Purpose:** Bearer token for the graphman GraphQL API. Never logged; excluded from `indexer://config`.

### `GRAPHMAN_KUBECTL_NAMESPACE`

- **Type:** `string`
- **Default:** `default`
- **Example:** `graph-protocol`
- **Purpose:** Kubernetes namespace used by the graphman CLI fallback (`kubectl exec ...`).

### `GRAPHMAN_POD_LABEL`

- **Type:** `string`
- **Default:** `app=graph-node`
- **Example:** `app.kubernetes.io/name=graph-node`
- **Purpose:** Label selector used by the CLI fallback to find the graph-node pod to exec into. Must be narrow enough that the selector matches exactly one pod (or one canonical pod) — see [troubleshooting.md](troubleshooting.md).

### `GRAPHMAN_CONFIG_PATH`

- **Type:** `string`
- **Default:** `/etc/graph-node/config.toml`
- **Purpose:** Path to the graph-node config file inside the graph-node container; passed to graphman CLI invocations.

---

## Postgres

### `GRAPH_NODE_POSTGRES_URL`

- **Type:** URL (optional)
- **Example:** `postgresql://readonly:password@localhost:5432/graph-node`
- **Purpose:** Read-only DSN for the graph-node Postgres database. Enables `get_subgraph_size` and `get_all_subgraph_sizes`. When omitted, those tools still register but return `isError: true` with a "Postgres not configured" message at call time. A read-only role is strongly recommended.

---

## Access control

See [access-control.md](access-control.md) for semantics.

### `ACCESS_LEVEL`

- **Type:** enum (`read_only` | `read_write` | `read_write_destructive` | `full`)
- **Default:** `read_write`
- **Purpose:** Sets which permission classes are granted by default. See [access-control.md](access-control.md).

### `ACCESS_OVERRIDES_ALLOW`

- **Type:** comma-separated tool names
- **Default:** empty
- **Example:** `graphman_drop_deployment,graphman_unused_remove`
- **Purpose:** Tools that are granted even when the active `ACCESS_LEVEL` would not grant their permission class. Unknown names produce a stderr warning at startup but do not fail boot.

### `ACCESS_OVERRIDES_DENY`

- **Type:** comma-separated tool names
- **Default:** empty
- **Example:** `graphman_drop_deployment,graphman_truncate_chain_cache`
- **Purpose:** Tools that are always denied regardless of `ACCESS_LEVEL` or `ACCESS_OVERRIDES_ALLOW`. Deny wins.

---

## Transport and authorizer

The transport and the authorizer are two independent axes. See
[deployment.md](deployment.md#http-profile--in-cluster-rbac) for the full
profile matrix and [access-control.md](access-control.md) for the authorizer
model. The default (`stdio` + `static`) reproduces the legacy behavior exactly.

### `MCP_TRANSPORT`

- **Type:** enum (`stdio` | `http`)
- **Default:** `stdio`
- **Purpose:** How clients connect. `stdio` blocks on stdin (the `kubectl exec`
  pattern); `http` starts a Streamable HTTP listener on `MCP_HTTP_HOST:MCP_HTTP_PORT`
  with `/healthz` and `/readyz` probe endpoints.

### `MCP_AUTHZ`

- **Type:** enum (`static` | `k8s-rbac`)
- **Default:** `static`
- **Constraint:** `k8s-rbac` requires `MCP_TRANSPORT=http`; the combination
  `k8s-rbac` + `stdio` is rejected at `loadConfig()` (stdio carries no per-caller
  identity).
- **Purpose:** Selects the grant authorizer. `static` uses `ACCESS_LEVEL` +
  `ACCESS_OVERRIDES_ALLOW` for every caller. `k8s-rbac` resolves each caller's
  identity (TokenReview) and asks Kubernetes RBAC whether that identity is granted
  the tool's permission class (SubjectAccessReview). In both modes the deny-list
  (`ACCESS_OVERRIDES_DENY`) and the unknown-tool floor are enforced in-app as
  invariants.

### `MCP_HTTP_PORT`

- **Type:** integer (coerced from string), positive
- **Default:** `8080`
- **Purpose:** Listen port for the HTTP transport. Ignored when
  `MCP_TRANSPORT=stdio`. Matches the `containerPort` and Service port in
  `k8s/deployment-http.yaml` / `k8s/service.yaml`.

### `MCP_HTTP_HOST`

- **Type:** `string`
- **Default:** `0.0.0.0`
- **Purpose:** Bind address for the HTTP transport. Ignored when
  `MCP_TRANSPORT=stdio`. `0.0.0.0` is appropriate inside a pod that sits behind a
  Service + TLS ingress.

### `K8S_API_AUDIENCE`

- **Type:** `string` (optional)
- **Default:** unset (accept the apiserver's default audience)
- **Purpose:** Expected audience for caller projected ServiceAccount tokens,
  passed to TokenReview. Projected SA tokens are audience-scoped; if your clients
  present tokens minted for a specific audience, set this to match or validation
  fails (`authenticated: false`). Only consulted under `MCP_AUTHZ=k8s-rbac`.

---

## Optimization parameters

These supply defaults for `run_allocation_optimization` / `run_discovery` / `run_health_check`. Per-invocation overrides on the composite tools take precedence.

### `MAX_ALLOCATIONS`

- **Type:** integer (coerced from string), positive
- **Default:** `15`
- **Purpose:** Cap on the number of simultaneous active allocations the optimizer will produce.

### `MAX_ALLOCATION_PCT`

- **Type:** number (coerced), in `[0, 1]`
- **Default:** `0.25`
- **Purpose:** Cap on any single allocation's share of total stake.

### `RISKY_DEPLOYMENT_CAP_PCT`

- **Type:** number (coerced), in `[0, 1]`
- **Default:** `0.05`
- **Purpose:** Cap on stake exposure to any deployment in `RISKY_DEPLOYMENTS`.

### `MIN_SIGNAL`

- **Type:** number (coerced), non-negative
- **Default:** `100`
- **Unit:** GRT (decimal — the value is in human GRT, not wei; composite tools convert to wei via `grtToWei`).
- **Purpose:** Curation-signal floor for a deployment to be considered.

### `GAS_ESTIMATE_GRT`

- **Type:** number (coerced), non-negative
- **Default:** `0.3`
- **Unit:** GRT (decimal; converted to wei internally).
- **Purpose:** Gas budget per allocation lifecycle (open + close), used by the optimizer to suppress churn whose APR uplift can't cover gas.
- **Rationale:** The Graph network runs on Arbitrum One. Observed real-world per operator: ~$0.01 per single action (one allocate OR one close), so ~$0.02 = ~0.2 GRT per lifecycle at GRT ≈ $0.10. The default of 0.3 GRT covers this with 50% headroom for gas-price spikes and GRT/ETH price swings.
- **Optimizer behavior:** The gas-floor filter applies a 2× safety multiplier — deployments are skipped when `projectedAnnualReward < 2 × GAS_ESTIMATE_GRT`. At the default this drops deployments earning less than 0.6 GRT/year — filters dust signal without excluding real opportunities.
- **Tuning:**
  - Default (`0.3`) suits **single-mode submission** on Arbitrum One.
  - **Batched action queues** via indexer-agent see ~$0.02 / 100 = ~$0.0002/action ≈ ~0.004 GRT per lifecycle — override to `0.01` or lower if you batch.

### `MIN_REWARDS_GRT_28D`

- **Type:** number (coerced), non-negative
- **Default:** `10`
- **Unit:** GRT (decimal; converted to wei internally).
- **Purpose:** Minimum projected indexing reward, over a rolling 28-day window, for a NEW allocation to be opened. Operator-attention floor — even if a deployment clears the gas break-even check, it's filtered if the projected monthly reward is below this threshold.
- **Scope:** Applies to **new allocations only**. Pre-seated existing allocations are exempt; their close decisions follow the gas floor and a separate overall-APR check (not yet implemented).
- **Optimizer behavior:** The floor is projected to an annual equivalent (`× 365 / 28`) and composed with the gas floor: a NEW candidate must clear `max(2 × GAS_ESTIMATE_GRT, MIN_REWARDS_GRT_28D × 365 / 28)`. At the defaults (`10` GRT/28d, `0.3` GRT gas), new candidates need ~130 GRT/year projected reward. Stake reclaimed from dropped candidates reflows to surviving picks via the same iterative-greedy loop.
- **Tuning:**
  - Default (`10`) suits operators who want to focus on revenue-meaningful deployments.
  - **Set to `0`** to disable and fall back to the gas-floor-only behavior — every candidate that clears `2 × GAS_ESTIMATE_GRT` becomes eligible.
  - Raise for indexers with more selective opening policies (e.g., `50` for a ~650 GRT/year minimum).

---

## Lists

All four are comma-separated deployment IPFS hashes (`Qm...`). Empty values, surrounding whitespace, and trailing commas are tolerated.

### `WHITELIST`

- **Type:** `string[]` (CSV)
- **Default:** `[]`
- **Purpose:** Deployments to always consider, even if other filters would reject them.

### `BLACKLIST`

- **Type:** `string[]` (CSV)
- **Default:** `[]`
- **Purpose:** Deployments to never allocate to.

### `FROZENLIST`

- **Type:** `string[]` (CSV)
- **Default:** `[]`
- **Purpose:** Deployments whose current allocations must not be touched (no resize, no close, no reallocation).

### `RISKY_DEPLOYMENTS`

- **Type:** `string[]` (CSV)
- **Default:** `[]`
- **Purpose:** Deployments subject to `RISKY_DEPLOYMENT_CAP_PCT`.
