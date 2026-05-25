# Graph Indexer MCP — Implementation Plan

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     MCP Client (Claude)                       │
│  Uses tools, reads resources, invokes prompts                │
└──────────────┬───────────────────────────────────────────────┘
               │ stdio or Streamable HTTP
┌──────────────▼───────────────────────────────────────────────┐
│                    MCP Server (TypeScript)                    │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │   Tools    │  │ Resources  │  │  Prompts   │             │
│  └─────┬──────┘  └─────┬──────┘  └────────────┘             │
│        │               │                                     │
│  ┌─────▼───────────────▼──────────────────────────────────┐  │
│  │              Service Layer                              │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │  │
│  │  │ Allocation   │ │   Health     │ │   Discovery    │  │  │
│  │  │  Optimizer   │ │   Monitor    │ │   Engine       │  │  │
│  │  └──────┬───────┘ └──────┬───────┘ └───────┬────────┘  │  │
│  └─────────┼────────────────┼─────────────────┼───────────┘  │
│            │                │                 │               │
│  ┌─────────▼────────────────▼─────────────────▼───────────┐  │
│  │              Data Access Layer (GraphQL Clients)        │  │
│  │  ┌──────────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌───────┐  │  │
│  │  │ Network  │ │ EBO  │ │ QoS  │ │ Graph  │ │ Agent │  │  │
│  │  │ Subgraph │ │  SG  │ │  SG  │ │ Node   │ │  API  │  │  │
│  │  └──────────┘ └──────┘ └──────┘ └────────┘ └───────┘  │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │ Graphman (GraphQL API on :8050 + CLI fallback)   │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Config / Cache / Types                     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

- **Runtime:** Node.js 22+
- **Language:** TypeScript (strict mode, ESM)
- **MCP SDK:** `@modelcontextprotocol/sdk` (v2)
- **Schema validation:** Zod v4
- **GraphQL client:** `graphql-request` (lightweight, typed)
- **Postgres client:** `pg` (for direct subgraph size queries against graph-node's database)
- **Shell execution:** `execa` (for graphman CLI fallback via `kubectl exec`)
- **Transport:** stdio for local use, Streamable HTTP for remote
- **Build:** `tsc` or Vite
- **External dependency:** `kubectl` must be available on PATH with appropriate k8s context/RBAC for graphman CLI fallback

---

## Phase 1 — Foundation (Week 1)

**Goal:** Project scaffold, configuration, data access layer, and basic tools.

### 1.1 Project Setup

```
graph-indexer-mcp/
├── src/
│   ├── index.ts                    # Entry point, MCP server init
│   ├── config.ts                   # Env/config parsing with Zod
│   ├── access-control.ts           # Permission levels, tool classification, middleware
│   ├── types/
│   │   ├── network.ts              # Network subgraph types
│   │   ├── ebo.ts                  # EBO subgraph types
│   │   ├── qos.ts                  # QoS subgraph types
│   │   ├── graphnode.ts            # Graph Node status types
│   │   ├── agent.ts               # Indexer agent types
│   │   └── graphman.ts            # Graphman API types
│   ├── clients/
│   │   ├── network-subgraph.ts     # Network subgraph queries
│   │   ├── ebo-subgraph.ts         # EBO subgraph queries
│   │   ├── qos-subgraph.ts        # QoS subgraph queries
│   │   ├── graph-node.ts          # Graph Node status queries
│   │   ├── postgres.ts            # Direct Postgres queries (subgraph sizes)
│   │   ├── indexer-agent.ts       # Agent mutations and queries
│   │   └── graphman.ts            # Graphman GraphQL API + CLI fallback
│   ├── services/
│   │   ├── allocation-optimizer.ts # APR calc + optimization logic
│   │   ├── health-monitor.ts      # Health check logic
│   │   └── discovery-engine.ts    # Cleanup + discovery logic
│   ├── utils/
│   │   └── kubectl.ts             # kubectl exec wrapper for graphman CLI fallback
│   ├── tools/
│   │   ├── network-tools.ts       # Network subgraph tools
│   │   ├── ebo-tools.ts           # EBO tools
│   │   ├── qos-tools.ts           # QoS tools
│   │   ├── graphnode-tools.ts     # Graph Node + Postgres tools
│   │   ├── graphman-tools.ts     # Graphman admin tools
│   │   ├── agent-tools.ts        # Indexer agent tools
│   │   └── workflow-tools.ts     # Composite workflow tools
│   ├── resources/
│   │   └── index.ts              # MCP resources
│   └── prompts/
│       └── index.ts              # MCP prompts
├── package.json
├── tsconfig.json
└── .env.example
```

### 1.2 Tasks

1. **Initialize project** with TypeScript, ESM, MCP SDK, Zod, graphql-request, pg, execa.
2. **Config module** — parse and validate all required env vars / config file with Zod. Fail fast on missing required values. Include `access_level` and `access_overrides` validation.
3. **Access control module** — implement the permission system:
   - Define permission classes: `read`, `agent_queue`, `agent_approve`, `graphman_safe`, `graphman_destructive`
   - Define access levels: `read_only`, `read_write`, `read_write_destructive`, `full` — each maps to a set of permitted classes
   - Parse `access_overrides.allow[]` and `access_overrides.deny[]` from config
   - Export a `checkAccess(toolName): { allowed: boolean, reason?: string }` function
   - Wrap MCP tool registration so denied tools still appear in the catalog but return informative errors when called
4. **Type definitions** — define TypeScript interfaces for each data source's key entities based on their GraphQL schemas.
5. **GraphQL client wrappers** — one thin client per data source, each encapsulating:
   - Endpoint URL from config
   - Common headers (API keys, bearer tokens for graphman)
   - Typed query functions
   - Error handling and retry logic
   - Note: the graphman client is dual-mode — GraphQL API for supported operations, falling back to `kubectl exec` via a shared shell execution utility for CLI-only commands
6. **Network Subgraph client** — implement core queries:
   - `getIndexer(address)` → Indexer entity
   - `getActiveAllocations(indexerAddress)` → Allocation[]
   - `getSignalledDeployments(minSignal)` → SubgraphDeployment[]
   - `getNetworkParameters()` → GraphNetwork
   - `getDeploymentAllocations(deploymentId)` → Allocation[]
7. **Register basic tools** — wire up the Network Subgraph tools with the MCP server, respecting access control.

### 1.3 Deliverable

A working MCP server with access control enforcement, connected to the Network Subgraph, exposing read-only tools for querying allocations, deployments, and network parameters. The access control system is in place so all subsequent tool registrations automatically respect the configured permission level.

---

## Phase 2 — Remaining Data Sources (Week 2)

**Goal:** Complete all data source clients and their corresponding tools.

### 2.1 Tasks

1. **EBO Subgraph client:**
   - `getCurrentEpoch()` → epoch number, start blocks per chain
   - `getEpochBlocks(epochNumber, chain)` → block number
   - `getEpochTimeRemaining()` → estimated hours/blocks (compute from epoch length and current block)

2. **QoS Subgraph client:**
   - `getQueryVolume(deploymentId?, timeRange)` → query count data
   - `getIndexerQoS(indexerAddress, deploymentId?, timeRange)` → latency, success rate, blocks-behind
   - `getTopQueriedDeployments(limit, timeRange)` → ranked list
   - `TimeRange` type accepts `{ hours: number }`, `{ days: number }`, or `{ epochs: number }` — the client converts to the appropriate subgraph query parameters using epoch length from the Network Subgraph

3. **Graph Node Status client:**
   - `getIndexingStatuses(deploymentIds?)` → SubgraphIndexingStatus[]
   - `getDeploymentHealth(deploymentId)` → detailed health + errors
   - `getEntityCount(deploymentId)` → BigInt

   **Postgres client** (separate client, read-only connection to graph-node's database):
   - `getSubgraphSize(deploymentId)` → actual disk usage in bytes (queries `pg_total_relation_size` against the deployment's `sgdN` schema)
   - `getDeploymentNamespace(deploymentId)` → maps IPFS hash to `sgdN` namespace via `deployment_schemas` table
   - `getAllSubgraphSizes()` → ranked list of all deployments by disk usage

4. **Indexer Agent client:**
   - `getActionQueue(statusFilter?)` → Action[]
   - `queueActions(actions)` → Action[] (queued)
   - `approveActions(actionIds)` → Action[] (approved)
   - `cancelActions(actionIds)` → Action[] (cancelled)
   - `getIndexingRules()` → IndexingRule[]
   - `setIndexingRule(deploymentId, params)` → IndexingRule
   - `setCostModel(deploymentId, model)` → CostModel

5. **Graphman client (dual-mode: GraphQL API + CLI fallback):**

   GraphQL API operations (port 8050, authenticated via bearer token):
   - `getDeploymentInfo(deploymentId)` → deployment details, pause state
   - `pauseDeployment(deploymentId)` → success/failure
   - `resumeDeployment(deploymentId)` → success/failure
   - `restartDeployment(deploymentId)` → execution ID (async)
   - `getExecutionStatus(executionId)` → RUNNING/SUCCEEDED/FAILED

   CLI fallback operations (via `kubectl exec` for commands not yet in GraphQL API):
   - `rewindDeployment(deploymentId, blockNumber, blockHash)` → stdout
   - `reassignDeployment(deploymentId, targetNode)` → stdout
   - `unassignDeployment(deploymentId)` → stdout
   - `dropDeployment(deploymentId)` → stdout
   - `unusedRecord()` → stdout
   - `unusedRemove(olderThanMinutes?, count?)` → stdout
   - `checkBlocks(chain, blockNumber | fromTo)` → stdout
   - `truncateChainCache(chain)` → stdout
   - `clearCallCache(chain, from?, to?, removeAll?)` → stdout

   The CLI wrapper should:
   - Discover the graph-node pod via `kubectl get pods -l <label> -n <namespace>`
   - Execute via `kubectl exec <pod> -- graphman --config <path> <command>`
   - Parse stdout for structured results where possible
   - Capture stderr for error reporting
   - Migrate to GraphQL API calls as graph-node exposes more operations

6. **Register all tools** for each data source.

7. **Register resources:**
   - `indexer://config` — returns current configuration
   - `indexer://overview` — calls all data sources for a summary
   - `indexer://glossary` — static reference text

### 2.2 Deliverable

Full data access layer with all tools registered, including graphman administration via both GraphQL API and CLI fallback, and direct Postgres queries for subgraph disk sizes. All tools respect the configured access level — mutations return clear "permission denied" messages when the operator has restricted access.

---

## Phase 3 — Service Layer & Workflows (Week 3)

**Goal:** Implement the three core workflow services and their composite tools.

### 3.1 Allocation Optimizer Service

```typescript
class AllocationOptimizer {
  // Gather all required state from data sources
  async gatherState(): Promise<OptimizationState>
  
  // Filter to deployments the indexer can allocate to
  filterCandidates(state: OptimizationState): Candidate[]
  
  // Calculate APR for each candidate at various allocation amounts
  calculateAPR(candidate: Candidate, amount: bigint, networkParams: NetworkParams): number
  
  // Core optimization: distribute stake to maximize total APR
  optimize(candidates: Candidate[], config: OptConfig): AllocationPlan
  
  // Generate the diff between current and desired allocations
  generateActions(current: Allocation[], desired: AllocationPlan): AgentAction[]
  
  // Full workflow: gather → filter → optimize → generate → queue
  async run(config: OptConfig): Promise<OptimizationResult>
}
```

**APR Calculation (simplified):**
```
For a deployment with:
  S = curation signal on deployment
  T = total signal across all deployments  
  R = total issuance per year
  A_i = indexer's allocation on deployment
  A_total = total allocation on deployment by all indexers

Indexer's share of deployment rewards:
  reward_share = (S / T) × R × (A_i / A_total)

APR:
  apr = reward_share / A_i
```

### 3.2 Health Monitor Service

```typescript
class HealthMonitor {
  // Check health of all allocated deployments
  async checkAllocatedHealth(): Promise<HealthReport>
  
  // Determine epoch timing urgency
  async getEpochUrgency(): Promise<EpochTiming>
  
  // Assess risk for each unhealthy allocation
  assessRisk(allocation: Allocation, health: HealthStatus, timing: EpochTiming): RiskLevel
  
  // Generate recommended close actions for at-risk allocations
  generateCloseActions(atRisk: RiskAssessment[]): AgentAction[]
  
  // Attempt recovery of failed deployments via graphman
  // (restart for transient failures, rewind for block-specific failures,
  //  check-blocks + cache clear for RPC corruption)
  async generateRecoveryPlan(failed: FailedDeployment[]): RecoveryAction[]
  
  // Full workflow
  async run(urgencyThresholdHours: number): Promise<HealthCheckResult>
}
```

### 3.3 Discovery Engine Service

```typescript
class DiscoveryEngine {
  // Find deployments that are synced but no longer useful
  async findStaleDeployments(): Promise<StaleDeployment[]>
  
  // Find deployments with high signal/volume not currently synced
  async findOpportunities(): Promise<Opportunity[]>
  
  // Score opportunities based on APR, query volume, entity count
  scoreOpportunity(opp: Opportunity): ScoredOpportunity
  
  // Generate cleanup actions via graphman (pause → unassign → unused record/remove)
  // and sync recommendations via indexer agent (set indexing rules for new deployments)
  generateRecommendations(stale: StaleDeployment[], opps: ScoredOpportunity[]): DiscoveryPlan
  
  // Full workflow
  async run(config: DiscoveryConfig): Promise<DiscoveryResult>
}
```

### 3.4 Register Composite Tools

- `run_allocation_optimization` — calls `AllocationOptimizer.run()`
- `run_health_check` — calls `HealthMonitor.run()` (includes graphman recovery recommendations)
- `run_discovery` — calls `DiscoveryEngine.run()` (includes graphman cleanup actions)
- `get_infrastructure_overview` — aggregates key metrics from all sources including graphman deployment info

### 3.5 Register Prompts

Each prompt template guides Claude through a specific workflow with appropriate context-gathering and decision points.

### 3.6 Deliverable

Complete MCP server with all three workflows operational. Claude can run full end-to-end workflows and the operator reviews/approves actions via the action queue.

---

## Phase 4 — Polish & Deployment (Week 4)

### 4.1 Tasks

1. **Error handling** — graceful degradation if a data source is unavailable. Tools should return partial results with clear error messages rather than failing entirely.

2. **Caching** — add a simple TTL cache for data that doesn't change frequently:
   - Network parameters: 1 hour
   - Deployment signal: 15 minutes
   - Indexing statuses: 5 minutes
   - Epoch info: 5 minutes
   - Graphman deployment info: 5 minutes (or no cache — it's cheap and state changes matter)

3. **Rate limiting** — respect The Graph gateway rate limits. Queue requests and batch where possible.

4. **Logging** — structured logging (stderr) for debugging. Include request/response timing for GraphQL calls and graphman CLI executions. Log all graphman mutations with full command and output.

5. **Testing:**
   - Unit tests for APR calculations and optimization logic.
   - Integration tests with mocked GraphQL responses (including graphman API mocks).
   - Mock `kubectl exec` calls for graphman CLI fallback testing.
   - End-to-end test against a local Graph Node setup (optional).

6. **Documentation:**
   - README with setup instructions.
   - Tool catalog with examples.
   - Configuration reference.

7. **Deployment options:**
   - **Local (stdio):** Run alongside indexer infrastructure, connect via Claude Desktop config. Requires local `kubectl` with appropriate context for graphman CLI fallback.
   - **Remote (Streamable HTTP):** Run as a service, authenticate via API key or OAuth. Needs network access to graphman API (port 8050) and kubectl access for CLI fallback.
   - **In-cluster (k8s):** Deploy as a pod in the same namespace as graph-node. Uses in-cluster k8s service account with RBAC for `pods/exec` on graph-node pods. This is the recommended deployment for graphman CLI fallback — avoids external kubectl config.
   - **Docker:** Containerized with kubectl baked in, mounting kubeconfig for out-of-cluster access.

### 4.2 Deliverable

Production-ready MCP server packaged for deployment.

---

## Key Implementation Decisions

### Why an MCP and not a standalone bot?

An MCP gives the indexer operator **interactive oversight**. Rather than a fully autonomous bot that silently makes allocation decisions, Claude acts as an intelligent assistant that:
- Gathers and synthesizes data across multiple sources.
- Explains its reasoning for allocation changes.
- Asks for confirmation before queuing actions.
- Can handle ad-hoc questions ("why is deployment X unhealthy?", "what if I allocated 50k to Y?").

The operator stays in control while offloading the cognitive load of cross-referencing multiple data sources and doing APR math.

### Agent mode recommendation

The indexer agent should run in **`oversight`** or **`manual`** mode. In oversight mode, the agent still runs its own reconciliation loop, but actions require approval — the MCP server can be the entity that reviews and approves (or the operator reviews via Claude). In manual mode, the MCP is the sole decision-maker, and the agent only executes approved actions.

### Handling the "allocation lifecycle"

Under Graph Horizon, allocations can remain open indefinitely as long as a valid POI is submitted within the 28-day `maxPOIStaleness` window. This changes the optimization calculus — instead of forced 28-day recycling, the MCP should:
1. Monitor POI staleness and queue POI submissions before the window closes.
2. Only reallocate when the APR math justifies the gas cost of closing and reopening.
3. Track allocation age and POI submission history.

### Security considerations

The Indexer Agent API and the Graphman API both have the power to affect real infrastructure and funds. The MCP server should:
- Never expose the Agent API or Graphman API endpoints externally.
- **Enforce access control** — the configured `access_level` determines which tools Claude can invoke. Default to `read_write` (propose but not approve). See section 9 of the design doc.
- Use the action queue with approval workflow rather than auto-executing allocation changes.
- Require explicit `confirm: true` parameters on destructive graphman operations (`drop`, `unused remove`, `truncate`, `clear call cache`).
- Log all mutations with full context — both agent queue actions and graphman operations.
- Store the graphman auth token and Postgres credentials securely (not in logs or tool responses).
- Use a **read-only** Postgres connection for subgraph size queries — never grant write access.
- For CLI fallback operations, ensure the MCP server's k8s service account has appropriate RBAC for `kubectl exec` into graph-node pods but not broader cluster access.

---

## Estimated Timeline

| Phase | Duration | Key Milestone |
|-------|----------|---------------|
| Phase 1 — Foundation | 1 week | Config, access control, Network Subgraph tools working |
| Phase 2 — Data Sources | 1 week | All 6 data sources operational (including graphman dual-mode) |
| Phase 3 — Workflows | 1 week | All three workflows end-to-end with graphman recovery/cleanup |
| Phase 4 — Polish | 1 week | Production-ready, documented, deployed |
| **Total** | **4 weeks** | |

Phases can overlap — e.g., Phase 2 clients can start while Phase 1 tools are being refined.

---

## Future Work

### Auto-Heal System (Post-Launch)

**Priority:** Lower — build after the core four phases are stable and the MCP is in daily use.

**Prerequisite:** Operational experience. The error knowledge base needs real error patterns collected from production use. The first months of MCP operation will surface the most common failure modes and their fixes.

**Implementation approach:**

1. **Error catalog format** — define a YAML/JSON schema for recovery entries:
   ```yaml
   # recovery-catalog.yaml
   entries:
     - id: "writer-poisoned"
       pattern:
         match_type: "fatalError.message"
         regex: "subgraph writer poisoned"
       recovery:
         action: "graphman_restart"
         params: {}
       confidence: "high"
       permission_class: "graphman_safe"
       description: "Transient writer lock — restart clears the poisoned state"
       
     - id: "deployment-head-missing"
       pattern:
         match_type: "fatalError.message"
         regex: "deployment head for sgd\\d+ not found"
       recovery:
         action: "graphman_rewind"
         params:
           blocks_back: 5
       confidence: "high"
       permission_class: "graphman_destructive"
       description: "Database state inconsistency — rewind past the corruption"
   ```

2. **Matcher service** — a new service class that takes a `SubgraphError` and returns the best matching catalog entry (if any), with the recovery action and confidence level.

3. **Integration with health monitor** — after the health monitor classifies allocations as closable/not-closable, it passes failed deployments through the matcher. Recovery recommendations appear in the health check output alongside closure recommendations.

4. **Feedback loop** — log every auto-heal attempt with before/after health status. Over time, entries with consistently successful outcomes get confidence bumped up; entries that don't resolve the issue get flagged for review or downgraded.

5. **Operator contribution** — expose an MCP tool (`add_recovery_entry`) at `full` access level so operators can add new patterns from conversation: "I just fixed deployment X by rewinding 10 blocks after seeing error Y — remember that."

**New files:**
- `src/services/auto-heal.ts` — matcher logic and recovery execution
- `src/types/recovery-catalog.ts` — types for catalog entries
- `recovery-catalog.yaml` — shipped default catalog, operator-extensible

**New tools:**
- `diagnose_deployment_error` — match a failed deployment's error against the catalog, return recommended fix
- `add_recovery_entry` — add a new pattern to the catalog (full access only)
- `list_recovery_catalog` — show all known error patterns and their recovery actions

### Query Performance Optimization (Post-Launch, Blocked on Graphman API)

**Priority:** Lower — analysis/recommendation is buildable now, but automated index creation is blocked on a graphman API upgrade.

**Dependency:** A graphman API mutation for index management (e.g., `deployment.createIndex`). Without it, Claude can recommend indexes but the operator has to create them manually via `psql` or the graphman CLI.

**Implementation approach:**

1. **Query log ingestion** — parse Graph Node's SQL query logs (`GRAPH_LOG_QUERY_TIMING=sql,gql`) to extract slow queries per deployment. This could be done by tailing log files, or if logs flow to a structured logging system (ELK, Loki), by querying that system.

2. **Postgres stats client** — extend the existing `clients/postgres.ts` to query:
   - `pg_stat_user_tables` — sequential scan counts per table (high seq_scans on large tables = missing index)
   - `pg_stat_user_indexes` — index usage stats (unused indexes wasting space)
   - `pg_stat_statements` — aggregated query timing (if the extension is enabled)
   - `EXPLAIN ANALYZE` on identified slow queries — to confirm the execution plan and pinpoint missing indexes

3. **Index recommendation engine** — a new service class:
   ```typescript
   class IndexAdvisor {
     // Identify deployments with degrading query performance
     async findSlowDeployments(timeRange: TimeRange): Promise<SlowDeployment[]>
     
     // Analyze a specific deployment's query patterns
     async analyzeQueries(deploymentId: string): Promise<QueryAnalysis>
     
     // Recommend indexes based on query patterns and table stats
     recommendIndexes(analysis: QueryAnalysis): IndexRecommendation[]
     
     // Validate a recommendation (check it doesn't conflict with ongoing operations)
     validateRecommendation(rec: IndexRecommendation): ValidationResult
     
     // Create index (blocked until graphman API supports it)
     async createIndex(rec: IndexRecommendation): Promise<IndexResult>
   }
   ```

4. **QoS correlation** — cross-reference QoS subgraph latency trends with Postgres stats to confirm that slow deployments from the gateway's perspective actually have database-level bottlenecks (vs. network or compute issues).

**Interim tools (buildable now):**
- `analyze_query_performance` — identify slow deployments and their bottleneck queries
- `recommend_indexes` — generate `CREATE INDEX` statements for operator to run manually
- `check_index_usage` — find unused or duplicate indexes that could be dropped to save disk

**Future tools (blocked on graphman API):**
- `create_index` — execute index creation via graphman (with `CONCURRENTLY` to avoid locks)
- `drop_unused_index` — remove indexes that aren't being hit

**New files:**
- `src/services/index-advisor.ts` — query analysis and recommendation logic
- `src/tools/performance-tools.ts` — MCP tools for query performance
