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
  - `deployment_ids` (string[], optional) — deployment IPFS hashes.
- **Returns:** JSON `{ count, statuses[] }`.

### `get_deployment_health`

- **Permission:** `read`
- **Description:** Detailed indexing health for a single deployment, including fatal/non-fatal errors, per-chain sync, entity count. Returns null when not tracked.
- **Args:**
  - `deployment_id` (string, required) — Qm... IPFS hash.
- **Returns:** JSON status object, or `{ deployment_id, status: null, message }` if not tracked.

### `get_entity_count`

- **Permission:** `read`
- **Description:** Total entity count for a deployment as a decimal string (BigInt-safe). Returns null when not tracked.
- **Args:**
  - `deployment_id` (string, required).
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
- **Description:** Queue an `allocate` action: opens a new allocation for `amount` GRT (wei). Lands in the agent queue as `queued`; must be approved before execution.
- **Args:**
  - `deployment_id` (string, required).
  - `amount` (string, required) — wei, decimal digits only.
- **Returns:** JSON agent response.

### `queue_unallocate`

- **Permission:** `agent_queue`
- **Description:** Queue an `unallocate` (close) action with the provided POI. POI must be valid at the closing block.
- **Args:**
  - `deployment_id` (string, required).
  - `allocation_id` (string, required) — 0x-prefixed 40-char hex.
  - `poi` (string, required) — 32-byte hex POI (0x + 64 hex).
- **Returns:** JSON agent response.

### `queue_reallocate`

- **Permission:** `agent_queue`
- **Description:** Atomic close + reopen on the same deployment; executed as a multicall on-chain.
- **Args:**
  - `deployment_id` (string, required).
  - `allocation_id` (string, required) — hex.
  - `poi` (string, required) — hex.
  - `new_amount` (string, required) — wei.
- **Returns:** JSON agent response.

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

## Graphman (14 tools)

Source: `src/tools/graphman-tools.ts`. Dual-mode: GraphQL on `:8050`, with CLI fallback via `kubectl exec`. CLI-tool stdout/stderr are capped at 32 KiB and the tail is preserved; truncation is flagged via `*_truncated`. Non-zero CLI exit codes are surfaced as `isError: true` with the full diagnostics.

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

### `graphman_rewind_deployment`

- **Permission:** `graphman_destructive`
- **Description:** Rewind a deployment to a specific block via CLI. Clears indexed data after the target — destructive to indexed state.
- **Args:**
  - `deployment_id` (string, required) — Qm...
  - `block_number` (number, required, non-negative integer).
  - `block_hash` (string, required) — 32-byte hex (0x + 64 hex).
- **Returns:** JSON `{ command, exitCode, stdout, stderr, stdout_truncated, stderr_truncated }`.

### `graphman_reassign_deployment`

- **Permission:** `graphman_safe`
- **Description:** Move a deployment to a different graph-node instance via CLI. No data lost.
- **Args:**
  - `deployment_id` (string, required).
  - `target_node` (string, required) — alnum/`_`/`-`, must not start with `-`.
- **Returns:** JSON CLI result.

### `graphman_unassign_deployment`

- **Permission:** `graphman_destructive`
- **Description:** Stop indexing permanently via CLI. Data preserved; deployment detached from its graph-node.
- **Args:** `deployment_id` (string, required).
- **Returns:** JSON CLI result.

### `graphman_drop_deployment`

- **DESTRUCTIVE / IRREVERSIBLE.** Permission: `graphman_destructive`
- **Description:** Full removal — unassign + name unbind + delete indexed data. Requires `confirm: true`.
- **Args:**
  - `deployment_id` (string, required).
  - `confirm` (literal `true`, required).
- **Returns:** JSON CLI result.

### `graphman_unused_record`

- **Permission:** `graphman_destructive`
- **Description:** Scan shards and mark unused deployments. First step in disk reclamation.
- **Args:** none.
- **Returns:** JSON CLI result.

### `graphman_unused_remove`

- **DESTRUCTIVE / IRREVERSIBLE.** Permission: `graphman_destructive`
- **Description:** Delete data for deployments previously marked unused. Requires `confirm: true`.
- **Args:**
  - `older_than_minutes` (number, optional, non-negative integer).
  - `count` (number, optional, positive integer).
  - `confirm` (literal `true`, required).
- **Returns:** JSON CLI result.

### `graphman_check_blocks`

- **Permission:** `read`
- **Description:** Compare cached blocks against the RPC provider. Read-only diagnostic. Provide EITHER `block_number` (single block) OR both `from` and `to` (range, `to >= from`) — not both, not neither.
- **Args:**
  - `chain` (string, required) — alnum/`_`/`-`, must not start with `-`.
  - `block_number` (number, optional, non-negative integer).
  - `from` (number, optional, non-negative integer).
  - `to` (number, optional, non-negative integer).
- **Returns:** JSON CLI result.

### `graphman_truncate_chain_cache`

- **DESTRUCTIVE / IRREVERSIBLE.** Permission: `graphman_destructive`
- **Description:** Clear the entire block cache for a chain. Use only after confirmed corruption. Requires `confirm: true`.
- **Args:**
  - `chain` (string, required).
  - `confirm` (literal `true`, required).
- **Returns:** JSON CLI result.

### `graphman_clear_call_cache`

- **DESTRUCTIVE / IRREVERSIBLE.** Permission: `graphman_destructive`
- **Description:** Remove call cache entries for a chain. Requires `confirm: true` AND exactly one of: `remove_all: true` (alone) OR a complete `from`/`to` range (`to >= from`). A bare invocation is rejected.
- **Args:**
  - `chain` (string, required).
  - `from` (number, optional, non-negative integer).
  - `to` (number, optional, non-negative integer).
  - `remove_all` (boolean, optional).
  - `confirm` (literal `true`, required).
- **Returns:** JSON CLI result.

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
