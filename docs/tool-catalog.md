# Tool catalog

Every MCP tool, resource, and prompt registered by `graph-indexer-mcp`, grouped by data source. Each tool entry lists its permission class (see [access-control.md](access-control.md)) and the exact arg shape registered in `src/tools/*.ts`.

Returns marked "JSON" are emitted as a single MCP text content block containing pretty-printed JSON (2-space indent).

---

## Network subgraph (6 tools)

Source: `src/tools/network-tools.ts`. Backed by the indexer-allocation network subgraph.

### `get_indexer_allocations`

- **Permission:** `read`
- **Description:** Fetch allocations for an indexer from the network subgraph. Filter by status (active/closed/all).
- **Args:**
  - `indexer_address` (string, required) — 0x-prefixed 40-char hex address.
  - `status_filter` (`'active' | 'closed' | 'all'`, optional, default `active`).
- **Returns:** JSON `{ indexer, status_filter, count, truncated, allocations[] }`.

### `get_deployment_signal`

- **Permission:** `read`
- **Description:** Get signal, total stake, and reward info for a single subgraph deployment.
- **Args:**
  - `deployment_id` (string, required, min length 1).
- **Returns:** JSON `{ deployment_id, found, deployment? }`.

### `get_all_signalled_deployments`

- **Permission:** `read`
- **Description:** List all subgraph deployments with curation signal at least `min_signal` (wei, BigInt-as-string).
- **Args:**
  - `min_signal` (string, required) — non-negative integer wei.
- **Returns:** JSON `{ min_signal, count, truncated, deployments[] }`.

### `get_network_parameters`

- **Permission:** `read`
- **Description:** Fetch global network parameters: total supply, total signalled, total allocated, current epoch, epoch length, per-block GRT issuance, delegation ratio (PPM).
- **Args:** none.
- **Returns:** JSON object with the network parameters.

### `get_deployment_allocations`

- **Permission:** `read`
- **Description:** List all indexers currently allocated to a specific deployment (active allocations only).
- **Args:**
  - `deployment_id` (string, required).
- **Returns:** JSON `{ deployment_id, count, truncated, allocations[] }`.

### `calculate_deployment_apr`

- **Permission:** `read`
- **Description:** Estimate the indexing-reward APR for opening (or growing) an allocation. Inputs are wei BigInt strings. Returns APR as a decimal fraction (1.0 = 100%). Reward-denied deployments return `apr=0` with `denied=true`.
- **Args:**
  - `deployment_id` (string, required).
  - `allocation_amount` (string, required) — non-negative integer wei.
- **Returns:** JSON `{ deployment_id, allocation_amount, apr, denied, reward_share?, indexer_share?, formula_inputs }`. The `formula_inputs.blocks_per_year` field echoes the hardcoded `BLOCKS_PER_YEAR` constant (2,102,400) used to annualize `networkGRTIssuancePerBlock`.

---

## EBO subgraph (3 tools)

Source: `src/tools/ebo-tools.ts`. Backed by the Epoch Block Oracle subgraph.

### `get_current_epoch`

- **Permission:** `read`
- **Description:** Get the current protocol epoch number and the per-chain start blocks within it (POI reference blocks).
- **Args:** none.
- **Returns:** JSON `{ epochNumber, networkBlocks: [{ network, blockNumber }] }`.

### `get_epoch_blocks`

- **Permission:** `read`
- **Description:** Get the start block on a specific chain for a specific epoch. Returns null if the EBO has no value for that pair.
- **Args:**
  - `epoch_number` (number, required, non-negative integer).
  - `chain_name` (string, required) — chain alias (e.g. `mainnet`, `arbitrum-one`).
- **Returns:** JSON `{ epoch_number, chain_name, result }`.

### `get_epoch_time_remaining`

- **Permission:** `read`
- **Description:** Estimate hours until next epoch on `chain_name`. The EBO does not supply the chain head or epoch length, so the caller passes them in.
- **Args:**
  - `current_block_number` (number, required, non-negative safe integer).
  - `epoch_length_blocks` (number, required, positive safe integer).
  - `avg_block_time_seconds` (number, optional, default `12`).
  - `chain_name` (string, optional, default `mainnet`).
- **Returns:** JSON with `current_epoch`, `blocks_into_epoch`, `blocks_remaining`, `hours_remaining`, `next_epoch_block`, and a `current_block_behind_epoch_start` flag.

---

## QoS subgraph (3 tools)

Source: `src/tools/qos-tools.ts`. Backed by the gateway QoS / query-stats subgraph.

The shared `time_range` shape accepts exactly one of: `{ hours: N }`, `{ days: N }`, or `{ epochs: N, seconds_per_epoch?: N }`.

### `get_query_volume`

- **Permission:** `read`
- **Description:** Query counts per deployment over a time window. Omit `deployment_id` to get all deployments.
- **Args:**
  - `deployment_id` (string, optional).
  - `time_range` (object, required) — see shared shape above.
- **Returns:** JSON `{ rows }`.

### `get_indexer_qos`

- **Permission:** `read`
- **Description:** QoS metrics (latency, success rate, blocks-behind) for the configured indexer. Omit `deployment_id` to get all allocated deployments.
- **Args:**
  - `deployment_id` (string, optional).
  - `time_range` (object, required).
- **Returns:** JSON `{ indexer_address, rows }`.

### `get_top_queried_deployments`

- **Permission:** `read`
- **Description:** Rank deployments by total query volume over a time window. Useful for discovery.
- **Args:**
  - `limit` (number, optional, positive integer ≤1000, default `20`).
  - `time_range` (object, required).
- **Returns:** JSON `{ rows }`.

---

## Graph-node status (3 tools)

Source: `src/tools/graphnode-tools.ts`. Backed by the graph-node Status GraphQL API.

### `get_indexing_statuses`

- **Permission:** `read`
- **Description:** Indexing health and sync progress for deployments tracked by graph-node. Omit `deployment_ids` to fetch every tracked deployment. Each entry includes health, sync state, per-chain progress, errors, entity count.
- **Args:**
  - `deployment_ids` (string[], optional) — deployment IDs in either IPFS CIDv0 form (`Qm...`, 46 chars) or bytes32 hex form (`0x...`, 66 chars). Both encodings are accepted; the client normalizes to CIDv0 internally before querying graph-node.
- **Returns:** JSON `{ count, statuses[] }`.

### `get_deployment_health`

- **Permission:** `read`
- **Description:** Detailed indexing health for a single deployment, including fatal/non-fatal errors, per-chain sync, entity count. Returns null when not tracked.
- **Args:**
  - `deployment_id` (string, required) — either `Qm...` IPFS CIDv0 or `0x...` bytes32 hex. Normalized internally to CIDv0 before querying graph-node.
- **Returns:** JSON status object, or `{ deployment_id, status: null, message }` if not tracked.

### `get_entity_count`

- **Permission:** `read`
- **Description:** Total entity count for a deployment as a decimal string (BigInt-safe). Returns null when not tracked.
- **Args:**
  - `deployment_id` (string, required) — either `Qm...` or `0x...` form; both accepted (normalized to CIDv0 internally).
- **Returns:** JSON `{ deployment_id, entity_count }`.

---

## Postgres (2 tools)

Source: `src/tools/postgres-tools.ts`. Reads directly from the graph-node Postgres database. Tools register even when `GRAPH_NODE_POSTGRES_URL` is unset, but return `isError: true` with a "Postgres not configured" message at call time.

### `get_subgraph_size`

- **Permission:** `read`
- **Description:** On-disk size of a deployment, summing `pg_total_relation_size` over every table in its `sgdN` schema.
- **Args:**
  - `deployment_id` (string, required).
- **Returns:** JSON `{ deployment_id, namespace, size_bytes, size_human }`.

### `get_all_subgraph_sizes`

- **Permission:** `read`
- **Description:** Disk size for every deployment known to graph-node, ranked descending. Useful for capacity planning.
- **Args:** none.
- **Returns:** JSON array of `{ deployment_id, namespace, size_bytes, size_human }`.

---

## Indexer agent (9 tools)

Source: `src/tools/agent-tools.ts`. Backed by the indexer-agent Management API. Every action queued by the MCP is stamped with `source = "graph-indexer-mcp"` and `priority = 0`.

### `queue_allocate`

- **Permission:** `agent_queue`
- **Description:** Queue an `allocate` action: opens a new allocation for `amount` GRT (decimal string of whole GRT, e.g. `"100"` or `"0.5"`). Lands in the agent queue as `queued`; must be approved before execution. **Unit gotcha:** the agent's `ActionInput.amount` is GRT decimal, NOT wei — passing the wei representation over-allocates by 10^18×. Distinct from `IndexingRule.allocationAmount` (wei) and `calculate_deployment_apr.allocation_amount` (wei).
- **Args:**
  - `deployment_id` (string, required).
  - `amount` (string, required) — GRT decimal (e.g. `"100"`, `"0.5"`). NOT wei.
- **Returns:** JSON agent response.

### `queue_unallocate`

- **Permission:** `agent_queue`
- **Description:** Queue an `unallocate` (close) action. POI is NOT a tool input — POI generation is a graph-node concern. The default path (`force_zero_poi=false`) lets the indexer-agent compute POI + publicPOI at close time and claim indexing rewards; setting `force_zero_poi=true` submits the **four-field all-zero POI bundle** (`poi=0x00…`, `publicPOI=0x00…`, `poiBlockNumber=0`, `force=true`) so the agent accepts the operator-supplied zero POI and closes the allocation without claiming rewards. The tool also looks up the allocation's `isLegacy` flag from the network subgraph and threads it onto the queued action so the agent dispatches to the correct (Horizon vs. pre-Horizon) staking contract. `status='queued'` and `protocolNetwork` are sourced from server config. `amount` is always set to `'0'` (the agent rejects unallocate without an `amount` field).
- **Args:**
  - `deployment_id` (string, required).
  - `allocation_id` (string, required) — 0x-prefixed 40-char hex.
  - `force_zero_poi` (boolean, optional, default `false`) — `true` to submit the four-field zero-POI bundle and forfeit rewards (use only when graph-node cannot produce a valid POI for the closing block).
- **Returns:** JSON agent response. Errors with `allocation … not found` if the allocation cannot be retrieved from the network subgraph (the `isLegacy` lookup is required to construct a valid `ActionInput`).

### `queue_reallocate`

- **Permission:** `agent_queue`
- **Description:** Atomic close + reopen on the same deployment; executed as a multicall on-chain. Same POI semantics as `queue_unallocate` — `force_zero_poi=true` sends the four-field zero-POI bundle for the closing leg. `isLegacy` is auto-fetched from the network subgraph for the closing leg; `protocolNetwork` and `status='queued'` come from server config.
- **Args:**
  - `deployment_id` (string, required).
  - `allocation_id` (string, required) — hex.
  - `new_amount` (string, required) — GRT decimal (e.g. `"100"`, `"0.5"`) for the new allocation. NOT wei.
  - `force_zero_poi` (boolean, optional, default `false`) — `true` to submit the four-field zero-POI bundle for the closing leg and forfeit rewards.
- **Returns:** JSON agent response. Same error semantics as `queue_unallocate` for missing allocations.

### `get_action_queue`

- **Permission:** `read`
- **Description:** List actions in the indexer-agent queue, optionally filtered by status.
- **Args:**
  - `status_filter` (`'queued' | 'approved' | 'pending' | 'success' | 'failed' | 'canceled' | 'all'`, optional, default `all`).
- **Returns:** JSON action list.

### `approve_actions`

- **Permission:** `agent_approve`
- **Description:** Approve queued actions so the agent will execute them on the next worker cycle. Commits real GRT on-chain.
- **Args:**
  - `action_ids` (string[], required, min 1).
- **Returns:** JSON agent response.

### `cancel_actions`

- **Permission:** `agent_approve`
- **Description:** Cancel one or more actions in the queue. No effect on already-executed actions.
- **Args:**
  - `action_ids` (string[], required, min 1).
- **Returns:** JSON agent response.

### `set_indexing_rule`

- **Permission:** `agent_queue`
- **Description:** Create or update a deployment-scoped indexing rule. `rule_params` is forwarded to the agent's `setIndexingRule` mutation. `identifier` and `identifierType` are reserved (derived from `deployment_id`) and rejected if supplied via `rule_params`.
- **Args:**
  - `deployment_id` (string, required).
  - `rule_params` (object<string, unknown>, required) — common fields: `allocationAmount`, `allocationLifetime`, `decisionBasis` (`rules|never|always|offchain`), `requireSupported`.
- **Returns:** JSON agent response.

### `get_indexing_rules`

- **Permission:** `read`
- **Description:** All indexing rules currently configured on the agent, with group/global defaults merged in.
- **Args:** none.
- **Returns:** JSON rule list.

### `set_cost_model`

- **Permission:** `agent_queue`
- **Description:** Set or update the Agora cost model for a deployment. Use deployment id `global` for the fallback model.
- **Args:**
  - `deployment_id` (string, required, or `global`).
  - `model` (string, required) — Agora source.
  - `variables` (string, optional) — JSON-encoded variables.
- **Returns:** JSON agent response.

---

## Graphman (5 active, 9 pending)

Source: `src/tools/graphman-tools.ts`. Backed by the graphman GraphQL API on `:8050`. The legacy `kubectl exec` CLI-fallback path has been **removed** (the MCP runs remote from graph-node), so the 9 CLI-only operations are currently **disabled** and do not register — see "Disabled — pending graphman GraphQL API" below. Their handler/schema boilerplate is preserved (commented) in the source for the eventual GraphQL reimplementation.

### `graphman_deployment_info`

- **Permission:** `read`
- **Description:** Deployment details (pause state, shard, chain, node assignment, latest block, health) via the GraphQL API.
- **Args:**
  - `deployment_id` (string, required) — IPFS CID v0 (`Qm...`, 46 chars).
- **Returns:** JSON deployment record.

### `graphman_pause_deployment`

- **Permission:** `graphman_safe`
- **Description:** Pause indexing for a deployment. No data lost.
- **Args:** `deployment_id` (string, required).
- **Returns:** JSON ack.

### `graphman_resume_deployment`

- **Permission:** `graphman_safe`
- **Description:** Resume a previously paused deployment.
- **Args:** `deployment_id` (string, required).
- **Returns:** JSON ack.

### `graphman_restart_deployment`

- **Permission:** `graphman_safe`
- **Description:** Pause + resume with delay. Async — returns an `execution_id`; poll via `graphman_get_execution_status`.
- **Args:** `deployment_id` (string, required).
- **Returns:** JSON `{ execution_id }`.

### `graphman_get_execution_status`

- **Permission:** `read`
- **Description:** Poll status of a long-running async graphman command. State: `RUNNING | SUCCEEDED | FAILED`.
- **Args:** `execution_id` (string, required, non-empty, must not start with `-`).
- **Returns:** JSON status.

### Disabled — pending graphman GraphQL API (kubectl exec path removed)

The following 9 tools are **not registered** in the current build. They were backed only by the `graphman` CLI invoked over `kubectl exec`, which has been removed because the MCP runs remote from graph-node. Each awaits a graphman GraphQL reimplementation; until then, operators run the corresponding `graphman` subcommand directly on the graph-node host. The intended permission class for each is shown so it can be re-applied on reimplementation.

| Tool | Intended permission | Operation |
| --- | --- | --- |
| `graphman_rewind_deployment` | `graphman_destructive` | Rewind a deployment to a specific block (clears indexed data after the target). |
| `graphman_reassign_deployment` | `graphman_safe` | Move a deployment to a different graph-node instance (no data loss). |
| `graphman_unassign_deployment` | `graphman_destructive` | Stop indexing permanently; data preserved, deployment detached. |
| `graphman_drop_deployment` | `graphman_destructive` | IRREVERSIBLE — unassign + name unbind + delete indexed data. |
| `graphman_unused_record` | `graphman_destructive` | Scan shards and mark unused deployments (first reclamation step). |
| `graphman_unused_remove` | `graphman_destructive` | IRREVERSIBLE — delete data for deployments marked unused. |
| `graphman_check_blocks` | `read` | Compare cached blocks against the RPC provider (read-only diagnostic). |
| `graphman_truncate_chain_cache` | `graphman_destructive` | IRREVERSIBLE — clear the entire block cache for a chain. |
| `graphman_clear_call_cache` | `graphman_destructive` | IRREVERSIBLE — remove call cache entries for a chain. |

---

## Composite (4 tools)

Source: `src/tools/composite-tools.ts`. Wrap the Stage 3 workflow services (`AllocationOptimizer`, `HealthMonitor`, `DiscoveryEngine`) plus the overview resource. All four are `read` — they produce plans and do not mutate state.

### `run_allocation_optimization`

- **Permission:** `read`
- **Description:** Run the full §4.1 allocation optimization workflow: gather state, filter candidates, score by APR with caps, return a structured plan with proposed allocations + diff actions. Does NOT queue actions.
- **Args:**
  - `indexer_address` (string, optional) — override `INDEXER_ADDRESS`.
  - `max_allocations` (number, optional, positive integer).
  - `max_allocation_pct` (number, optional, 0–1).
  - `risky_deployment_cap_pct` (number, optional, 0–1).
  - `min_signal_grt` (string, optional) — GRT decimal (e.g. `"100"`, `"0.5"`).
  - `gas_estimate_grt` (string, optional) — GRT decimal.
- **Returns:** JSON `OptimizationResult` (state, proposedAllocations, actions, warnings, errors).

### `run_health_check`

- **Permission:** `read`
- **Description:** Run the §4.2 pre-epoch health check: classify each active allocation (Path A / Path B / none), assess risk, generate close plan + graphman recovery plan. Does NOT queue closes.
- **Args:**
  - `indexer_address` (string, optional) — override.
  - `urgency_threshold_hours` (number, optional, positive, default `6`).
- **Returns:** JSON `HealthCheckResult` (timing, allocations, risk, closePlan, blockedFromClose, recoveryPlan, warnings, errors).

### `run_discovery`

- **Permission:** `read`
- **Description:** Run the §4.3 cleanup + discovery workflow: stale deployments + ordered cleanup steps; new high-value deployments scored by `apr*0.4 + volume*0.3 + signal*0.2 - cost*0.1`. Does NOT execute cleanup or set rules.
- **Args:**
  - `typical_allocation_grt` (string, required) — GRT decimal. Reasonable default `total_stake_grt / max_allocations`.
  - `indexer_address` (string, optional).
  - `max_candidates` (number, optional, positive integer ≤500, default `10`).
  - `min_signal_grt` (string, optional) — GRT decimal.
- **Returns:** JSON `DiscoveryResult` (stale, cleanup, opportunities, recommendedRules, warnings, errors).

### `get_infrastructure_overview`

- **Permission:** `read`
- **Description:** Aggregate stake, active allocations, deployment health counts, disk usage, paused count across all data sources. Best-effort — per-source failures recorded in `partialErrors`. Same payload as `indexer://overview`.
- **Args:** none.
- **Returns:** JSON overview.

---

## Subgraph manifest (1 tool)

Source: `src/tools/manifest-tools.ts`. Fetches the subgraph manifest from IPFS (the network subgraph does not store manifest content; the deployment ID *is* the manifest's IPFS CID).

### `get_subgraph_manifest`

- **Permission:** `read`
- **Description:** Fetch a subgraph deployment's manifest from IPFS by deployment ID (accepts `Qm…` or `0x…bytes32` form), returning the parsed manifest plus the raw text.
- **Args:**
  - `deployment_id` (string, required, min length 1) — `Qm…` CIDv0 or `0x`-prefixed 32-byte hex; normalized to the IPFS CID via `src/utils/ipfs.ts`.
- **Returns:** JSON `{ deployment_id, manifest, manifest_raw, parse_error? }`. `manifest` is the YAML parsed to JSON; on a parse failure it is `null`, `parse_error` is set, and `manifest_raw` still carries the bytes.
- **Config:** `IPFS_GATEWAY_URL` (gateway to fetch from), `IPFS_MAX_BYTES` (response cap). See [config-reference.md](config-reference.md).

---

## RPC passthrough (2 tools)

Source: `src/tools/rpc-tools.ts`. A **read-only** JSON-RPC passthrough to operator-configured endpoints. Registered only when `RPC_ENDPOINTS` is non-empty; otherwise both tools are absent.

### `rpc_call`

- **Permission:** `read`
- **Description:** Make a read-only JSON-RPC call to a configured chain. The method must be in a fixed read-only allowlist; state-changing methods (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_*`, `eth_sign*`, …) are refused. The agent selects a chain **alias** (never a URL) and a source (local / remote / auto).
- **Args:**
  - `chain` (string, required) — a configured chain alias (e.g. `arbitrum-one`); must match `^[a-z0-9][a-z0-9-]*$` and exist in `RPC_ENDPOINTS`.
  - `method` (string, required) — must be in the allowlist: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getLogs`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_estimateGas`, `net_version`, `web3_clientVersion`.
  - `params` (array, optional, default `[]`) — JSON-RPC params, passed through.
  - `source` (`'local' | 'remote' | 'auto'`, optional, default `auto`) — `local` = the indexer's own node (trusted/private); `remote` = third-party/public (requires `RPC_ALLOW_REMOTE`); `auto` = prefer local, else remote.
- **Returns:** JSON `{ chain, endpoint_kind, result }` or `{ chain, endpoint_kind, error }` (the JSON-RPC error relayed verbatim). The endpoint **URL is never returned** (it may embed API keys).
- **Config:** `RPC_ENDPOINTS` (alias→{local,remote} map), `RPC_ALLOW_REMOTE`, `RPC_TIMEOUT_MS`, `RPC_MAX_BYTES`. See [config-reference.md](config-reference.md).

### `list_rpc_chains`

- **Permission:** `read`
- **Description:** Discover the chain aliases configured for `rpc_call`, the endpoint kinds available for each, which source `auto` resolves to, and the permitted read-only methods. Endpoint URLs are never returned. Call this before `rpc_call` to learn valid `chain` values.
- **Args:** none.
- **Returns:** JSON `{ allow_remote, count, chains[], allowed_methods[] }` where each `chains[]` entry is `{ chain, has_local, has_remote, remote_enabled, auto_source, usable }`. `remote_enabled` is `false` for a remote endpoint disabled by `RPC_ALLOW_REMOTE`; `auto_source` is what `source: 'auto'` would pick (`null` if no usable endpoint); `usable` is whether `auto` resolves to an endpoint.

---

## Resources (3)

Source: `src/resources/*.ts`. Registered via `registerIndexerResource`.

### `indexer://config`

- **Mime:** `application/json`
- **Description:** Sanitized snapshot of the MCP server configuration: indexer address, endpoints (credentials stripped), access level, optimization thresholds, list overrides. Secrets (`graphmanAuthToken`, Postgres credentials) are never included.

### `indexer://overview`

- **Mime:** `application/json`
- **Description:** Live aggregated infrastructure summary — stake, active allocation count and total GRT allocated, deployment health counts (healthy / syncing / failed / paused), total Postgres disk usage. Best-effort; per-source failures are reported under `partialErrors`.

### `indexer://glossary`

- **Mime:** `text/markdown`
- **Description:** Graph Protocol terminology reference. Covers staking, subgraphs, allocations, epochs, rewards economics, health states, and infrastructure components (graph-node, indexer-agent, graphman).

---

## Prompts (6)

Source: `src/prompts/*.ts`. Registered via `registerIndexerPrompt`. Prompts are pure text — they describe the workflow and the tools to invoke; they do no I/O themselves.

### `optimize_allocations`

- **Description:** Guide through the full §4.1 allocation optimization workflow.
- **Args:** `dry_run` (boolean, optional, default `true`).

### `pre_epoch_health_check`

- **Description:** Guide through the §4.2 pre-epoch health check; classify each active allocation and queue closes for closables.
- **Args:** none.

### `discover_new_subgraphs`

- **Description:** Guide through the §4.3 discovery half — find and evaluate new subgraph sync opportunities, ranked and capped at `max_candidates`.
- **Args:** `max_candidates` (number, optional, positive integer, default `10`).

### `investigate_unhealthy`

- **Description:** Diagnose a specific unhealthy deployment: gather health, sync, signal, allocation, and graphman state; recommend remediation.
- **Args:** `deployment_id` (string, required) — `Qm...` or `0x...` deployment ID.

### `recover_failed_deployment`

- **Description:** Diagnose and recover a failed deployment via graphman (restart, rewind, cache clear). Always produces a plan first; destructive ops require operator confirmation.
- **Args:** `deployment_id` (string, required) — `Qm...` or `0x...`.

### `cleanup_stale_deployments`

- **Description:** Guide through identifying and removing stale deployments (§4.3 cleanup half) via graphman. `dry_run=true` produces a plan only.
- **Args:** `dry_run` (boolean, optional, default `true`).
