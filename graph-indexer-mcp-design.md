# Graph Protocol Indexer Infrastructure MCP — Design Document

## 1. Overview

This MCP server provides Claude (or any MCP client) with the ability to manage a Graph Protocol Indexer's day-to-day operations. It wraps six data sources and exposes tools organized around three scheduled workflows that together automate the core indexer lifecycle: **optimizing allocations**, **monitoring health before epoch boundaries**, and **cleaning up / discovering subgraphs**.

---

## 2. Data Sources

### 2.1 Network Subgraph

**What it is:** A subgraph deployed on Arbitrum (the protocol chain) that indexes all Graph Network smart contract state. It is the canonical source of truth for the protocol's on-chain state.

**Endpoint:** A Graph Node query endpoint (typically `https://gateway.thegraph.com/api/<api-key>/subgraphs/id/<deployment-id>`).

**Key entities and fields:**

| Entity | Key Fields | Used By |
|--------|-----------|---------|
| `Indexer` | `id`, `stakedTokens`, `allocatedTokens`, `delegatedTokens`, `delegationRatio`, `indexingRewardCut`, `queryFeeCut`, `tokenCapacity` | All workflows — establishes how much GRT is available to allocate |
| `Allocation` | `id`, `subgraphDeployment.id`, `allocatedTokens`, `createdAtEpoch`, `closedAtEpoch`, `status` (Active/Closed), `poi` | Allocation Optimization, Managing Allocations |
| `SubgraphDeployment` | `id` (deployment IPFS hash), `signalledTokens` (curation signal), `stakedTokens` (total allocated by all indexers), `indexingRewardAmount`, `queryFeesAmount`, `deniedAt` | All workflows — signal and existing stake drive APR math |
| `Subgraph` | `id`, `currentVersion`, `versions`, `metadata` (displayName, description) | Cleanup & Discovery — maps human-readable names to deployment IDs |
| `GraphNetwork` | `totalSupply`, `totalTokensAllocated`, `totalTokensSignalled`, `currentEpoch`, `epochLength`, `issuancePerYear` | APR calculations |

**Relevant queries the MCP needs to make:**
- Fetch indexer's own allocations (active and recent closed).
- Fetch all subgraph deployments with signal above a threshold.
- Fetch global network parameters for APR calculations.
- Fetch all indexers' allocations on a specific deployment (for competitive analysis).

### 2.2 Epoch Block Oracle (EBO) Subgraph

**What it is:** A subgraph that tracks the block number at the start of each epoch for every chain The Graph supports. This is critical because Proof of Indexing (POI) must be computed as of the **first block of the current epoch** — submitting a POI from a different block results in a bad POI that can be disputed.

**Endpoint:** A Graph Node query endpoint for the EBO subgraph deployment.

**Key entities:**

| Entity | Key Fields | Purpose |
|--------|-----------|---------|
| `Epoch` | `id` (epoch number), `startBlock`, `endBlock` | Identifies epoch boundaries |
| `NetworkEpochBlockNumber` | `id`, `network` (chain alias), `epochNumber`, `blockNumber` | Maps each chain to its block number at epoch start |

**Relevant queries:**
- Get the current epoch number and its start block for each chain.
- Determine how far into the current epoch we are (hours remaining before flip).
- Look up the epoch-start block for a specific chain (needed for POI submission).

### 2.3 QoS (Quality of Service) Subgraph

**What it is:** A subgraph that aggregates quality-of-service metrics reported by gateways. Gateways emit Kafka messages with per-query performance data, which are aggregated into 5-minute intervals and posted on-chain. The QoS subgraph then indexes this data.

**Endpoint:** A Graph Node query endpoint for the QoS subgraph deployment.

**Key data points:**

| Metric | Description | Used By |
|--------|------------|---------|
| Query counts per subgraph deployment | Total queries served in a time window, broken down by deployment | Cleanup & Discovery — identifies high-demand subgraphs worth syncing |
| Indexer-specific QoS scores | Latency, success rate, blocks-behind for a specific indexer on each deployment | Managing Allocations — an indexer with degrading QoS on a deployment may want to close |
| Gateway-level metrics | Aggregate query volume and performance across gateways | Discovery — high query volume deployments are revenue opportunities |

**Relevant queries:**
- Get query counts per subgraph deployment over a configurable time window (last N hours, days, or epochs).
- Get your own indexer's QoS scores across all allocated deployments for a given time range.
- Rank deployments by query volume to find high-demand opportunities.

**Time scale:** All QoS queries should accept a flexible time range — either epoch-based (`last_n_epochs`) or calendar-based (`last_n_hours`, `last_n_days`). Calendar-based ranges are more intuitive for operators; epoch-based align with how the data is actually bucketed. The MCP should support both and convert between them using epoch length from the Network Subgraph.

### 2.4 Indexer Agent Management API (GraphQL)

**What it is:** A GraphQL API served by the indexer-agent process (default port 18000). This is the **control plane** for the indexer's on-chain actions. It exposes the action queue, indexing rules, cost models, and deployment status.

**Key operations:**

#### Queries
| Query | Purpose |
|-------|---------|
| `actions(filter, orderBy)` | List queued/approved/executed actions |
| `indexingRules` | Get current rules (auto/manual decisions) |
| `costModels` | Get current query pricing per deployment |
| `indexerDeployments` | List all deployments the indexer is currently syncing |

#### Mutations
| Mutation | Purpose |
|----------|---------|
| `queueActions(actions)` | Add allocate/unallocate/reallocate actions to queue |
| `updateActions(filter, action)` | Bulk update action status (e.g., approve queued actions) |
| `cancelActions(actionIDs)` | Cancel pending actions |
| `deleteActions(actionIDs)` | Remove actions from queue |
| `setIndexingRule` | Set rules for a deployment (allocationAmount, decisionBasis, etc.) |
| `setCostModel` | Update pricing for a deployment |

#### Action Types
| Action | Input | Effect |
|--------|-------|--------|
| `allocate` | deploymentID, amount | Opens new allocation |
| `unallocate` | allocationID, poi | Closes allocation, submits POI, collects rewards |
| `reallocate` | allocationID, poi, amount | Atomically closes and reopens (multicall) |

**Important operational note:** The agent can run in three modes:
- **`auto`** — agent makes all allocation decisions autonomously via rules.
- **`manual`** — agent takes no autonomous actions; all actions must be queued and approved externally.
- **`oversight`** — agent queues actions based on rules, but requires external approval before execution.

For an MCP-driven workflow, **`manual` or `oversight` mode** is recommended so that Claude can propose actions and an operator can approve them.

### 2.5 Graph Node Status API (Supplementary)

**What it is:** A GraphQL endpoint exposed by Graph Node on port 8030 that reports the indexing status of every deployment the node is syncing.

**Key queries:**

| Query | Fields | Purpose |
|-------|--------|---------|
| `indexingStatuses` | `subgraph`, `synced`, `health` (healthy/unhealthy/failed), `fatalError`, `nonFatalErrors`, `chains[].chainHeadBlock`, `chains[].latestBlock`, `entityCount` | Core health check for all syncing deployments |

**Supplementary: Postgres direct queries**

Graph Node stores all subgraph data in PostgreSQL. The MCP can query Postgres directly for operational metadata not available via GraphQL:

| Query | Purpose |
|-------|---------|
| Table size per deployment schema (`pg_total_relation_size` on `sgdN` schemas) | Actual disk usage of a deployment — critical for cleanup decisions and capacity planning |
| `deployment_schemas` table | Maps deployment IPFS hashes to their database namespace (`sgdN`) |

This requires a read-only Postgres connection string in the MCP config.

**Health semantics:**
- **`healthy`** — no errors, syncing normally.
- **`unhealthy`** — non-fatal errors encountered but still indexing (deterministic errors, handler issues).
- **`failed`** — fatal error halted indexing entirely.

**Sync gap:** `chainHeadBlock.number - latestBlock.number` tells you how far behind the node is. A subgraph is "caught up" when this gap is small (typically < 100 blocks depending on chain speed).

### 2.6 Graphman GraphQL API (Graph Node Administration)

**What it is:** A GraphQL administration API served by graph-node for managing deployments, chain data, and node operations. This is the programmatic interface to the `graphman` toolset — the same operations available via the graphman CLI, but exposed over GraphQL for integration with external tools like this MCP.

**Endpoint:** `http://<graph-node-host>:8050` (configurable via `GRAPHMAN_PORT` env var). A GraphQL playground is available at the same URL for schema exploration.

**Authentication:** Requires a bearer token set via the `GRAPHMAN_SERVER_AUTH_TOKEN` environment variable on graph-node. All requests must include an `Authorization: Bearer <token>` header.

**Security:** Like the Indexer Agent API, the graphman API must never be exposed externally — it provides operations that could severely impede indexer operations if misused.

**Currently documented operations:**

#### Queries

| Query | Description | Use Case |
|-------|------------|----------|
| `deployment.info(deployment)` | Get deployment details including status, pause state, shard, chain, node assignment | Diagnostics — get full picture of a deployment's state |
| `execution.info(id)` | Check status of a long-running async command (RUNNING/SUCCEEDED/FAILED) | Monitoring — poll for completion of restart or other async operations |

#### Mutations

| Mutation | Description | Use Case |
|----------|------------|----------|
| `deployment.pause(deployment)` | Pause indexing for a deployment | Maintenance — temporarily stop a subgraph without losing data |
| `deployment.resume(deployment)` | Resume a previously paused deployment | Maintenance — restart indexing after pause |
| `deployment.restart(deployment)` | Pause then resume with a delay (async, returns execution ID) | Recovery — restart a stuck or erroring subgraph runner |

**Deployment identification:** Deployments can be referenced by IPFS hash (`{ hash: "Qm..." }`).

**Async command pattern:** Some operations (like `restart`) are long-running and execute in the background. The API returns a unique execution ID that can be polled via `execution.info(id)` to check status (`RUNNING`, `SUCCEEDED`, `FAILED`) and retrieve any error messages.

**Additional CLI commands (not yet in GraphQL API):** The graphman CLI (bundled with graph-node, accessible via `kubectl exec` on k8s) exposes additional operations that may not yet be available via the GraphQL API. These can be wrapped as MCP tools using shell execution as a fallback:

| CLI Command | Description | Use Case |
|-------------|------------|----------|
| `graphman info <deployment> --status` | Detailed deployment info with sync/health status | Diagnostics |
| `graphman reassign <deployment> <node>` | Move deployment to a different graph-node instance | Load balancing |
| `graphman unassign <deployment>` | Permanently stop indexing (data preserved) | Cleanup |
| `graphman remove <name>` | Remove subgraph name → deployment association | Cleanup |
| `graphman drop <deployment>` | Full removal: unassign + remove + delete data (irreversible) | Cleanup — complete removal |
| `graphman rewind <block_hash> <block_number> <deployment>` | Rewind deployment to a specific block | Recovery — retry after failure or bad RPC data |
| `graphman unused record` | Scan shards, mark unused deployments | Cleanup — first step in garbage collection |
| `graphman unused remove [--older <min>]` | Delete data for unused deployments (irreversible) | Cleanup — reclaim disk space |
| `graphman chain check-blocks <chain> by-number <n>` | Compare cached block against RPC provider | Diagnostics — detect poisoned block cache |
| `graphman chain check-blocks <chain> by-range --from <n> --to <n>` | Check block range for inconsistencies | Diagnostics |
| `graphman chain truncate <chain>` | Clear entire block cache for a chain | Recovery — after confirmed cache corruption |
| `graphman chain call-cache <chain> remove [--from/--to/--remove-entire-cache]` | Remove call cache entries | Recovery — clear stale eth_call results |

**Implementation strategy:** The MCP should prefer the GraphQL API (port 8050) for any operation it supports, falling back to CLI execution via `kubectl exec` for operations not yet exposed over GraphQL. As graph-node adds more operations to the GraphQL API over time, the MCP can migrate CLI-based tools to GraphQL calls.

**Important safety notes:**
- `drop` and `unused remove` are **irreversible** — they permanently delete indexed data.
- `rewind` clears indexed data after the target block but preserves the deployment.
- `pause`, `resume`, `reassign`, and `unassign` are safe — no data is lost.
- All destructive commands should go through the operator approval flow, never auto-executed.

---

## 3. Key Concepts

### 3.1 Closable Allocation

An allocation is **closable** when it can be safely closed on-chain with a valid POI, earning rewards without risk of dispute. There are two distinct closure paths:

#### Path A: Healthy Close

All three conditions must be true:

1. **The allocation is active on-chain.** Status is `Active` in the Network Subgraph.
2. **The subgraph head is above the first block of the current epoch.** The deployment has indexed past the epoch-start block, meaning it has the data needed to generate a POI for that block. Checked via Graph Node Status API: `latestBlock.number >= epochStartBlock` (where `epochStartBlock` comes from the EBO Subgraph for the deployment's chain).
3. **The subgraph was healthy as of the first block of the current epoch.** The deployment was indexing correctly at that block — no fatal error before or at that block number. This means a valid POI can be generated for the epoch-start block.

This is the normal close path. It applies to healthy subgraphs being reallocated, and to subgraphs that crashed *after* the epoch-start block but were healthy *at* that block.

#### Path B: Deterministic Failure Close

All three conditions must be true:

1. **The allocation is active on-chain.** Status is `Active` in the Network Subgraph.
2. **The subgraph has failed with a deterministic error.** The deployment's health is `failed` with a `fatalError` that is deterministic — meaning every correct indexer will hit the same error at the same block. Non-deterministic errors (RPC timeouts, OOM, transient failures) do not qualify.
3. **The failure block is verified with other indexers.** The block at which the subgraph failed should be cross-referenced with POI data from other indexers on the same deployment to confirm they also failed at the same point. This prevents closing with a POI that could be disputed.

This path handles the case where a subgraph is broken in a way that's provably not the indexer's fault. The POI submitted is for the block just before the deterministic failure.

#### Why this matters

Closing an allocation with an invalid or mismatched POI can result in a dispute and slashing of staked GRT. The health check workflow's primary job is classifying each active allocation into one of these closable paths or flagging it as "not safely closable — operator review required."

**Not closable (requires manual review):**
- Active allocation where the subgraph failed before the epoch-start block with a non-deterministic error (can't generate valid POI, can't prove it was universal).
- Active allocation where the subgraph is behind the epoch-start block and still syncing (not yet at the block needed for POI).
- Any situation where the closure path is ambiguous — escalate to the operator rather than risk a bad POI.

### 3.2 Auto-Heal (Future)

**Status:** Lower priority — concept defined here for future implementation.

**What it is:** A pattern-matching recovery system where known error types are mapped to proven recovery actions. When the health monitor detects a failed or unhealthy deployment, it checks the error against a knowledge base of known fixes and either executes the fix automatically (if access control permits) or recommends it to the operator.

**Error → Recovery Knowledge Base:**

The knowledge base is a structured catalog of error patterns, each mapped to a recovery action and confidence level. Example entries:

| Error Pattern | Match On | Recovery Action | Confidence |
|--------------|----------|----------------|------------|
| `subgraph writer poisoned by previous error` | fatalError message | `graphman restart` (pause + resume with delay) | High — well-known transient failure |
| `store error: deployment head for sgdN not found` | fatalError message | `graphman rewind` 5 blocks from failure point | High |
| `block not found` / `header not found` | fatalError message + chain | `graphman chain check-blocks` at failure block, then `graphman rewind` if cache was bad | Medium — could be RPC issue |
| `eth_call failed: execution reverted` (deterministic) | fatalError message + handler name | No auto-fix — subgraph code issue. Flag for Path B closure. | N/A |
| `SIGKILL` / OOM patterns | nonFatalErrors or external monitoring | Restart deployment, consider pausing low-priority subgraphs on same node to free memory | Low — environment issue |
| Subgraph stuck (no block progress for >1hr, healthy status) | Detected by sync gap monitoring over time | `graphman restart` | Medium |
| Call cache poisoning (correct POI from other indexers doesn't match) | POI mismatch with peers | `graphman chain call-cache remove` for affected range, then `graphman rewind` | High |

**How it works:**

```
┌───────────────────────────────────────────────────────────────┐
│  1. Health monitor detects failure / unhealthy deployment     │
│  2. Extract error signature (message, handler, block, chain)  │
│  3. Match against knowledge base entries (pattern matching)   │
│  4. If match found:                                           │
│     ├─ High confidence + access_level permits → auto-execute  │
│     ├─ Medium confidence → recommend to operator with         │
│     │   explanation and ask for approval                      │
│     └─ Low confidence → flag for manual review                │
│  5. If no match → log the error for future cataloging,        │
│     escalate to operator                                      │
│  6. After recovery: verify deployment returns to healthy,     │
│     log outcome to improve future confidence scores           │
└───────────────────────────────────────────────────────────────┘
```

**Knowledge base storage:** The error catalog should be a structured config file (YAML or JSON) shipped with the MCP server, editable by the operator to add new patterns from their own experience. Over time, patterns that consistently succeed can have their confidence raised.

**Relationship to access control:** Auto-heal respects the same access levels as everything else. At `read_only`, it can only recommend. At `read_write`, it can execute `graphman_safe` recoveries (restart, pause/resume). At `read_write_destructive`, it can execute rewinds and cache clears. The confidence threshold for auto-execution is also configurable — an operator might set it to "high only" or "never auto-execute, always recommend."

### 3.3 Query Performance Optimization (Future)

**Status:** Lower priority — depends on graphman API expansion to support index management operations.

**What it is:** Claude analyzes query logs and QoS subgraph data to identify subgraph deployments where database query performance is degrading, diagnoses which tables and columns would benefit from additional PostgreSQL indexes, and implements those indexes.

**Why it matters:** Graph Node stores subgraph data in Postgres and generates GraphQL queries against it. The default indexes cover primary keys and basic lookups, but high-traffic subgraphs with complex queries (multi-field filters, sorting by non-indexed columns, range queries) can develop slow query patterns over time. Adding targeted indexes can dramatically reduce query latency — sometimes turning multi-second queries into millisecond ones. This directly impacts QoS scores, which affect query fee revenue and gateway selection.

**Data sources for analysis:**

| Source | What It Provides |
|--------|-----------------|
| QoS Subgraph | Per-deployment latency trends over time — identifies which deployments are getting slower |
| Graph Node query logs (`GRAPH_LOG_QUERY_TIMING=sql,gql`) | Actual SQL queries being executed, with timing — shows exactly which queries are slow and what tables/columns they hit |
| Postgres `pg_stat_user_tables` / `pg_stat_user_indexes` | Table scan counts, index usage stats — reveals tables doing sequential scans that should be using indexes |
| Postgres `pg_stat_statements` (if enabled) | Aggregated query stats — most time-consuming queries across all deployments |

**Analysis → recommendation flow:**

```
┌───────────────────────────────────────────────────────────────┐
│  1. IDENTIFY SLOW DEPLOYMENTS                                 │
│     ├─ QoS Subgraph: deployments with rising latency          │
│     └─ Postgres stats: tables with high seq_scan counts       │
│                                                               │
│  2. DIAGNOSE SLOW QUERIES                                     │
│     ├─ Parse query logs for the deployment's sgdN schema      │
│     ├─ Identify queries with high execution time              │
│     ├─ Run EXPLAIN ANALYZE on representative slow queries     │
│     └─ Identify missing indexes (seq scans on filtered/       │
│         sorted columns)                                       │
│                                                               │
│  3. RECOMMEND INDEXES                                         │
│     ├─ Propose CREATE INDEX statements                        │
│     ├─ Estimate impact (rows affected, current scan cost)     │
│     ├─ Flag any risks (index build time, disk usage, write    │
│     │   overhead for high-ingestion deployments)              │
│     └─ Present to operator for approval                       │
│                                                               │
│  4. IMPLEMENT (requires graphman API or direct Postgres)      │
│     ├─ Create index (preferably CONCURRENTLY to avoid locks)  │
│     ├─ Verify index is being used (re-run EXPLAIN)            │
│     └─ Monitor QoS improvement post-index                     │
└───────────────────────────────────────────────────────────────┘
```

**Blockers:** The implementation step (4) requires either a graphman API mutation for index management or direct write access to Postgres. Direct write access conflicts with the read-only Postgres principle. A graphman API endpoint like `deployment.createIndex(deployment, table, columns, concurrent)` would be the safe path — it keeps index creation within graph-node's control and can enforce safety checks (e.g., preventing indexes on tables mid-migration, validating column names against the schema).

**Interim capability:** Even before the graphman API supports index creation, steps 1–3 are valuable on their own. Claude can analyze query performance and recommend specific `CREATE INDEX` statements that the operator runs manually via `psql` or `graphman`.

---

## 4. Workflows

### 4.1 Allocation Optimization

**Schedule:** Runs periodically (e.g., every 12–24 hours, or on-demand).

**Goal:** Maximize indexing reward APR by distributing the indexer's available stake across subgraph deployments in proportion to their signal, while accounting for competitive allocation from other indexers.

**Process:**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. GATHER STATE                                                │
│     ├─ Network Subgraph: indexer stake, active allocations,     │
│     │   all deployments with signal, global network params      │
│     ├─ Graph Node Status: which deployments are synced/healthy  │
│     ├─ Graphman API: check for paused deployments (exclude      │
│     │   from candidates)                                        │
│     └─ QoS Subgraph: query volumes per deployment               │
├─────────────────────────────────────────────────────────────────┤
│  2. FILTER CANDIDATES                                           │
│     ├─ Only deployments the indexer has synced AND healthy       │
│     ├─ Exclude deployments with rewards denied (deniedAt != 0)  │
│     ├─ Apply minimum signal threshold (e.g., min 100 GRT)       │
│     └─ Exclude blacklisted deployments                          │
├─────────────────────────────────────────────────────────────────┤
│  3. CALCULATE APR FOR EACH CANDIDATE                            │
│     ├─ Indexing reward share = (signal_i / total_signal)        │
│     │     × issuance_per_year                                   │
│     ├─ Indexer's share = allocated_i / (total_allocated_i +     │
│     │     new_allocation)                                       │
│     ├─ APR = reward_share / new_allocation                      │
│     └─ Apply caps: max allocation overall, reduced max          │
│         for "risky" deployments (frequent upgrades, known       │
│         instability)                                            │
├─────────────────────────────────────────────────────────────────┤
│  4. OPTIMIZE                                                    │
│     ├─ Solve for allocation distribution that maximizes         │
│     │   total APR across all deployments                        │
│     ├─ Respect max_allocations count limit                      │
│     ├─ Respect per-deployment caps                              │
│     └─ Account for gas costs of open/close transactions         │
├─────────────────────────────────────────────────────────────────┤
│  5. GENERATE ACTIONS                                            │
│     ├─ Compare desired state to current allocations             │
│     ├─ Generate close actions for allocations to remove         │
│     ├─ Generate open actions for new allocations                │
│     ├─ Generate reallocate actions where size changes           │
│     └─ Queue all via Indexer Agent queueActions mutation        │
└─────────────────────────────────────────────────────────────────┘
```

**Key constraints and parameters:**
- `max_allocations` — hard cap on number of simultaneous allocations (e.g., 10–20).
- `max_allocation_pct` — maximum percentage of total stake in any single allocation (e.g., 25%).
- `risky_deployment_cap` — reduced cap for deployments known to upgrade frequently (e.g., 5%).
- `min_signal` — minimum curation signal required to consider a deployment.
- `gas_budget` — estimated gas cost per allocation lifecycle (open + close).
- `whitelist` / `blacklist` / `frozenlist` — manual overrides.

### 4.2 Managing Current Allocations (Pre-Epoch Health Check)

**Schedule:** Daily, several hours before the expected epoch boundary (epochs are ~24 hours / 6,646 blocks on Ethereum).

**Goal:** Classify every active allocation as closable (Path A or Path B — see section 3.1) or not-closable, then close the ones that need closing before the epoch flips.

**Why timing matters:** Path A closability depends on the subgraph being healthy at the epoch-start block. Once the epoch flips, the reference block changes. A subgraph that crashed mid-epoch is closable now (healthy at old epoch start) but won't be closable after the flip (unhealthy before new epoch start). The window to close cleanly shrinks as the epoch progresses.

**Process:**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. DETERMINE TIMING                                            │
│     ├─ EBO Subgraph: current epoch number + start blocks        │
│     ├─ Network Subgraph: epoch length, current block            │
│     └─ Calculate: hours remaining until next epoch flip          │
├─────────────────────────────────────────────────────────────────┤
│  2. CLASSIFY EACH ACTIVE ALLOCATION                             │
│     For each active allocation:                                 │
│     ├─ Graph Node Status API: get deployment health + sync      │
│     ├─ EBO Subgraph: get epoch-start block for this chain       │
│     │                                                           │
│     ├─ PATH A CHECK (Healthy Close):                            │
│     │   ├─ Is latestBlock >= epochStartBlock?                   │
│     │   ├─ Was subgraph healthy at epochStartBlock?             │
│     │   └─ If both yes → closable via Path A                   │
│     │                                                           │
│     ├─ PATH B CHECK (Deterministic Failure Close):              │
│     │   ├─ Is the fatalError deterministic?                     │
│     │   ├─ Can the failure block be verified with other          │
│     │   │   indexers on this deployment?                        │
│     │   └─ If both yes → closable via Path B                   │
│     │                                                           │
│     └─ NEITHER → not safely closable, flag for operator review  │
├─────────────────────────────────────────────────────────────────┤
│  3. ASSESS URGENCY                                              │
│     ├─ How many hours until epoch flip?                         │
│     ├─ How much GRT is at stake per allocation?                 │
│     ├─ Is the subgraph still degrading (sync gap growing)?     │
│     └─ Prioritize: large allocations on failing subgraphs      │
│         close to epoch boundary                                 │
├─────────────────────────────────────────────────────────────────┤
│  4. TAKE ACTION                                                 │
│     ├─ Closable (Path A or B): queue close via Indexer Agent    │
│     ├─ Not closable but degrading: alert operator with          │
│     │   explanation of why it can't be safely closed            │
│     ├─ Healthy but stale RPC: alert operator;                   │
│     │   consider graphman chain check-blocks to diagnose        │
│     └─ For failed deployments post-close: recommend graphman    │
│         recovery (restart, rewind, or cache clear)              │
└─────────────────────────────────────────────────────────────────┘
```

**Closability decision matrix:**

| Health | Subgraph Head vs Epoch Start | Error Type | Closable? | Action |
|--------|------------------------------|------------|-----------|--------|
| `healthy` | Above | N/A | Path A ✓ | Close only if rebalancing (handled by optimization workflow) |
| `healthy` | Below (still syncing) | N/A | No — not yet at epoch block | Wait; monitor sync progress |
| `unhealthy` | Above | Non-fatal | Path A ✓ | Queue close before epoch flip |
| `unhealthy` | Below | Non-fatal | No | Alert operator — can't generate valid POI |
| `failed` | Above (was above before failure) | Deterministic | Path B ✓ | Queue close — verify failure block with other indexers first |
| `failed` | Above (was above before failure) | Non-deterministic | Path A ✓ (if healthy at epoch start) | Queue close using epoch-start POI |
| `failed` | Below | Deterministic | Path B ✓ | Queue close — verify failure block with other indexers first |
| `failed` | Below | Non-deterministic | **No** | Operator review — cannot safely close |

### 4.3 Cleanup and Offchain Sync (Subgraph Discovery)

**Schedule:** Weekly or on-demand.

**Goal:** Two-pronged — remove deployments that are no longer useful, and discover new deployments worth syncing.

**Process:**

```
┌─────────────────────────────────────────────────────────────────┐
│  CLEANUP                                                        │
│  1. IDENTIFY STALE DEPLOYMENTS                                  │
│     ├─ Graph Node Status: all syncing deployments               │
│     ├─ Graphman API: check deployment info (pause state, node)  │
│     ├─ Network Subgraph: check if deployment still has signal   │
│     ├─ Check if subgraph was upgraded (new version deployed)    │
│     ├─ Check if deployment has active allocation (can't remove  │
│     │   if allocated)                                           │
│     └─ Check if deployment is on frozen/pinned list             │
│                                                                 │
│  2. REMOVE STALE                                                │
│     ├─ Close any remaining allocations on deprecated versions   │
│     ├─ Graphman: pause deployment to stop indexing              │
│     ├─ Graphman: unassign deployment from node                  │
│     ├─ Graphman: unused record → unused remove to reclaim disk  │
│     └─ Or for full removal: graphman drop (irreversible)        │
├─────────────────────────────────────────────────────────────────┤
│  DISCOVERY                                                      │
│  3. FIND NEW OPPORTUNITIES                                      │
│     ├─ Network Subgraph: deployments with high signal not       │
│     │   currently synced                                        │
│     ├─ QoS Subgraph: deployments with high query volume         │
│     ├─ Calculate potential APR if allocated                     │
│     └─ Cross-reference with existing allocation landscape       │
│                                                                 │
│  4. EVALUATE TRADE-OFFS                                         │
│     ├─ Entity count (proxy for storage size / sync time)        │
│     │   — queryable from Graph Node status API                  │
│     ├─ Actual disk usage (queryable from Postgres for already   │
│     │   synced deployments — use for cleanup prioritization)    │
│     ├─ Chain type (some chains sync faster than others)         │
│     ├─ History of upgrades (frequent upgrades = more churn)     │
│     ├─ Current number of indexers on deployment                 │
│     └─ Available disk space and compute resources               │
│                                                                 │
│  5. RECOMMEND                                                   │
│     ├─ Ranked list of deployments to start syncing              │
│     ├─ Estimated sync time (rough: entity_count correlation)    │
│     ├─ Expected APR once synced                                 │
│     └─ Queue "offchain" indexing rules for approved candidates  │
└─────────────────────────────────────────────────────────────────┘
```

**Scoring formula for new opportunities (example):**

```
score = (potential_apr × 0.4) 
      + (query_volume_normalized × 0.3) 
      + (signal_normalized × 0.2) 
      - (estimated_cost_normalized × 0.1)
```

`estimated_cost` can be derived from entity count (available pre-sync from the network subgraph or from other indexers) or from actual disk size of the deployment (available post-sync via Postgres). Entity count is a rough proxy before syncing; disk size is ground truth after.

---

## 5. MCP Tools Inventory

The following tools should be exposed by the MCP server. They are organized by the data source they interact with, then by workflow relevance.

### 5.1 Network Subgraph Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `get_indexer_allocations` | Fetch all active allocations for the configured indexer | `indexer_address`, `status_filter` (active/closed/all) |
| `get_deployment_signal` | Get signal, total stake, and reward info for a deployment | `deployment_id` |
| `get_all_signalled_deployments` | List all deployments with signal above threshold | `min_signal` |
| `get_network_parameters` | Fetch global parameters (issuance, epoch, total supply) | — |
| `get_deployment_allocations` | Get all indexers' allocations on a specific deployment | `deployment_id` |
| `calculate_deployment_apr` | Compute estimated APR for a given allocation amount | `deployment_id`, `allocation_amount` |

### 5.2 EBO Subgraph Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `get_current_epoch` | Get current epoch number and start blocks per chain | — |
| `get_epoch_blocks` | Get start block for a specific chain at a specific epoch | `epoch_number`, `chain_name` |
| `get_epoch_time_remaining` | Estimate hours/blocks until next epoch flip | — |

### 5.3 QoS Subgraph Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `get_query_volume` | Query counts per deployment over time window | `deployment_id` (optional), `time_range` (e.g., `{ hours: 24 }`, `{ days: 7 }`, or `{ epochs: 10 }`) |
| `get_indexer_qos` | QoS metrics for the configured indexer | `deployment_id` (optional), `time_range` |
| `get_top_queried_deployments` | Rank deployments by query volume | `limit`, `time_range` |

### 5.4 Graph Node Status Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `get_indexing_statuses` | Health and sync status for all syncing deployments | `deployment_ids` (optional filter) |
| `get_deployment_health` | Detailed health for a single deployment | `deployment_id` |
| `get_entity_count` | Entity count for a deployment (proxy for size) | `deployment_id` |
| `get_subgraph_size` | Actual disk usage of a deployment's database tables (queries Postgres directly) | `deployment_id` |

### 5.5 Graphman Tools

| Tool Name | Description | Parameters | Interface |
|-----------|-------------|------------|-----------|
| `graphman_deployment_info` | Get deployment details including pause state and status | `deployment_id` | GraphQL API |
| `graphman_pause_deployment` | Pause indexing for a deployment | `deployment_id` | GraphQL API |
| `graphman_resume_deployment` | Resume a paused deployment | `deployment_id` | GraphQL API |
| `graphman_restart_deployment` | Pause then auto-resume with delay (async) | `deployment_id` | GraphQL API |
| `graphman_get_execution_status` | Poll status of an async graphman operation | `execution_id` | GraphQL API |
| `graphman_rewind_deployment` | Rewind a deployment to a specific block | `deployment_id`, `block_number`, `block_hash` | CLI fallback |
| `graphman_reassign_deployment` | Move deployment to a different graph-node instance | `deployment_id`, `target_node` | CLI fallback |
| `graphman_unassign_deployment` | Stop indexing permanently (data preserved) | `deployment_id` | CLI fallback |
| `graphman_drop_deployment` | Full removal — unassign, remove, delete data (irreversible) | `deployment_id`, `confirm` | CLI fallback |
| `graphman_unused_record` | Scan shards and mark unused deployments | — | CLI fallback |
| `graphman_unused_remove` | Delete data for unused deployments (irreversible) | `older_than_minutes` (optional), `count` (optional) | CLI fallback |
| `graphman_check_blocks` | Compare cached blocks against RPC provider | `chain`, `block_number` or `from`/`to` range | CLI fallback |
| `graphman_truncate_chain_cache` | Clear entire block cache for a chain (irreversible) | `chain`, `confirm` | CLI fallback |
| `graphman_clear_call_cache` | Remove call cache entries | `chain`, `from` (optional), `to` (optional), `remove_all` (optional) | CLI fallback |

### 5.6 Indexer Agent Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `queue_allocate` | Queue an allocate action | `deployment_id`, `amount` |
| `queue_unallocate` | Queue a close-allocation action | `allocation_id`, `poi` |
| `queue_reallocate` | Queue an atomic close+open action | `allocation_id`, `poi`, `new_amount` |
| `get_action_queue` | List actions by status | `status_filter` |
| `approve_actions` | Approve queued actions for execution | `action_ids[]` |
| `cancel_actions` | Cancel pending actions | `action_ids[]` |
| `set_indexing_rule` | Set/update indexing rule for a deployment | `deployment_id`, `rule_params` |
| `get_indexing_rules` | Get all current indexing rules | — |
| `set_cost_model` | Update query pricing for a deployment | `deployment_id`, `model` |

### 5.7 Composite / Workflow Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `run_allocation_optimization` | Full optimization workflow: gather → filter → calculate → recommend | `max_allocations`, `max_allocation_pct`, `risk_overrides{}` |
| `run_health_check` | Full health check: status → flag → recommend closes | `urgency_threshold_hours` |
| `run_discovery` | Full discovery scan: find opportunities → score → rank | `min_signal`, `min_query_volume`, `max_entity_count` |
| `get_infrastructure_overview` | Dashboard summary: allocations, health, pending actions, epoch timing | — |

---

## 6. MCP Resources

Resources provide read-only context that Claude can reference without making tool calls.

| Resource URI | Description |
|-------------|-------------|
| `indexer://config` | Current MCP configuration (endpoints, indexer address, thresholds) |
| `indexer://overview` | Cached infrastructure summary (refreshed on access) |
| `indexer://glossary` | Graph Protocol terminology reference |

---

## 7. MCP Prompts

Pre-built prompt templates for common operator workflows.

| Prompt Name | Description |
|------------|-------------|
| `optimize_allocations` | Guides Claude through the full allocation optimization workflow |
| `pre_epoch_health_check` | Guides Claude through the pre-epoch-flip health check |
| `discover_new_subgraphs` | Guides Claude through finding and evaluating new sync opportunities |
| `investigate_unhealthy` | Guides Claude through diagnosing a specific unhealthy deployment |
| `recover_failed_deployment` | Guides Claude through diagnosing and recovering a failed deployment via graphman (rewind, restart, cache clearing). Will integrate with auto-heal knowledge base when available. |
| `cleanup_stale_deployments` | Guides Claude through identifying and removing unused deployments via graphman |

---

## 8. Configuration

The MCP server needs the following configuration (via environment variables or config file):

```yaml
# Indexer identity
indexer_address: "0x..."

# Data source endpoints  
network_subgraph_url: "https://gateway.thegraph.com/api/KEY/subgraphs/id/..."
ebo_subgraph_url: "https://..."
qos_subgraph_url: "https://..."
graph_node_status_url: "http://localhost:8030/graphql"
indexer_agent_url: "http://localhost:18000/graphql"
graphman_api_url: "http://localhost:8050"
graphman_auth_token: "your-graphman-auth-token"

# Graphman CLI fallback (for operations not yet in GraphQL API)
graphman_kubectl_namespace: "default"
graphman_pod_label: "app=graph-node"       # used to discover graph-node pod
graphman_config_path: "/etc/graph-node/config.toml"

# Graph Node Postgres (read-only, for subgraph size queries)
graph_node_postgres_url: "postgresql://readonly:password@localhost:5432/graph-node"

# Access control — restricts what the MCP is allowed to do
# Operators can limit Claude's capabilities based on trust level
access_level: "read_write"  # see Access Control section below

# Optimization parameters
max_allocations: 15
max_allocation_pct: 0.25          # 25% of stake in any single allocation
risky_deployment_cap_pct: 0.05    # 5% for known-risky deployments
min_signal: 100                   # minimum GRT signal to consider
gas_estimate_grt: 0.3             # Arbitrum One single-mode lifecycle (~0.2 GRT + 50% headroom)

# Lists
whitelist: []                     # always consider these deployments
blacklist: []                     # never allocate to these  
frozenlist: []                    # don't change existing allocations
risky_deployments: []             # apply reduced caps to these

# Scheduling hints (informational — actual scheduling is external)
optimization_schedule: "0 6 * * *"     # 6am daily
health_check_schedule: "0 18 * * *"    # 6pm daily (before ~midnight epoch flip)
discovery_schedule: "0 10 * * 1"       # Monday 10am

# Auto-heal (future — ignored until implemented)
auto_heal_enabled: false
auto_heal_catalog_path: "./recovery-catalog.yaml"
auto_heal_min_confidence: "high"       # "high" = only auto-execute high-confidence fixes
                                       # "medium" = auto-execute medium and high
                                       # "recommend_only" = never auto-execute, always ask
```

---

## 9. Access Control

Operators need to control how much authority the MCP (and by extension Claude) has over their infrastructure. A single `access_level` config controls which tools are enabled, with granular overrides available per tool category.

### Access Levels

| Level | Description | Use Case |
|-------|------------|----------|
| `read_only` | All query/read tools enabled. All mutations, graphman writes, and agent queue actions disabled. | Monitoring dashboards, reporting, new operator onboarding |
| `read_write` | Read tools + agent queue actions (queue, but not approve/execute). Graphman non-destructive mutations (pause, resume, restart). | Day-to-day operations — Claude proposes, operator approves via CLI or UI |
| `read_write_destructive` | Everything in `read_write` + graphman destructive operations (rewind, unassign, drop, unused remove, cache clear). Agent approve still requires operator. | Experienced operators who trust Claude with node-level operations |
| `full` | All tools enabled including agent action approval. | Fully automated operation (use with caution — real GRT at stake) |

### Tool Classification

Every tool is tagged with a permission class. The MCP server checks the configured access level before executing any tool call, returning a clear error if the operation is not permitted.

| Permission Class | Tools | Enabled At |
|-----------------|-------|------------|
| `read` | All query/get tools across every data source | All levels |
| `agent_queue` | `queue_allocate`, `queue_unallocate`, `queue_reallocate`, `set_indexing_rule`, `set_cost_model` | `read_write` and above |
| `agent_approve` | `approve_actions`, `cancel_actions` | `full` only |
| `graphman_safe` | `graphman_pause_deployment`, `graphman_resume_deployment`, `graphman_restart_deployment`, `graphman_reassign_deployment` | `read_write` and above |
| `graphman_destructive` | `graphman_rewind_deployment`, `graphman_unassign_deployment`, `graphman_drop_deployment`, `graphman_unused_record`, `graphman_unused_remove`, `graphman_check_blocks`, `graphman_truncate_chain_cache`, `graphman_clear_call_cache` | `read_write_destructive` and above |

### Granular Overrides

Operators can override individual tool permissions beyond what the access level grants or restricts:

```yaml
access_level: "read_write"
access_overrides:
  # Grant specific destructive operations even at read_write level
  allow:
    - graphman_rewind_deployment
    - graphman_unassign_deployment
  # Deny specific tools even if the access level would allow them
  deny:
    - set_cost_model
    - graphman_restart_deployment
```

### Implementation

The access control check is a middleware layer in the MCP tool registration. When a tool is called:

1. Look up the tool's permission class.
2. Check if the configured `access_level` includes that class.
3. Check `access_overrides.allow` (grants even if level would deny).
4. Check `access_overrides.deny` (blocks even if level would allow).
5. If denied, return an error message explaining what access level or override is needed.
6. Denied tools are still listed in the MCP tool catalog (so Claude knows they exist) but marked with a note that they require elevated access. This lets Claude tell the operator "I'd recommend a rewind here, but that requires `read_write_destructive` access."
