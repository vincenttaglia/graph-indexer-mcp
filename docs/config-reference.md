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
- **Default:** `0.5`
- **Unit:** GRT (decimal; converted to wei internally).
- **Purpose:** Gas budget per allocation lifecycle (open + close), used by the optimizer to suppress churn whose APR uplift can't cover gas.
- **Rationale:** The Graph network runs on Arbitrum One; observed real-world gas costs are ~1 cent USD per single allocate/close action (~0.1 GRT at GRT≈$0.10), or ~2 cents for a batch of 100 (~0.004 GRT per lifecycle). The 0.5 GRT default covers the single-action worst case with safety headroom.
- **Optimizer behavior:** The gas-floor filter applies a 2× safety multiplier — deployments are skipped when `projectedAnnualReward < 2 × GAS_ESTIMATE_GRT`. At the default, this means deployments earning less than 1 GRT/year are dropped.
- **Tuning:**
  - Operators using **batched action queues** (the default indexer-agent flow) see ~0.004 GRT per lifecycle on Arbitrum — set `0.1` or lower.
  - Operators allocating one-at-a-time on Arbitrum: leave at default `0.5`, or lower to `0.1` if gas prices are consistently calm.
  - **Mainnet** operators (rare now) should override significantly higher — typical mainnet allocate/close ran ~10–50 GRT.

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
