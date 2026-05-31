# Troubleshooting

Common failure modes with diagnostic steps. Server logs go to stderr — capture them when filing a bug or running through this guide.

---

## Startup failures

### "Invalid configuration: ..."

`loadConfig()` parsed env vars through Zod and rejected them. The error message includes a path-prefixed list of issues:

```
Invalid configuration:
  indexerAddress: must be a 0x-prefixed 40-character hex address
  networkSubgraphUrl: Invalid URL
```

Fix the named env vars. See [config-reference.md](config-reference.md) for the exact expected shape of each.

### `[mcp] warn: access_overrides.allow references unknown tool "..."`

A name in `ACCESS_OVERRIDES_ALLOW` or `ACCESS_OVERRIDES_DENY` does not match any registered tool. Common causes:

- Typo (compare against [tool-catalog.md](tool-catalog.md)).
- A tool was renamed in a recent version and the env was not updated.
- The override was meant for a different MCP server.

The server keeps running — only the named override is ignored.

---

## Tool calls fail

### "Server boots but every tool fails with `fetch failed`"

The MCP can't reach an upstream endpoint. Test connectivity from the MCP's runtime context, not from your workstation:

- Local stdio: from the same host running `node dist/index.js`.
- In-cluster: `kubectl exec` into the MCP pod and `curl` the endpoint.

Likely causes:

- Wrong URL in env (missing port, wrong protocol, stale subgraph deployment id).
- NetworkPolicy denying egress (in-cluster).
- The gateway URL requires an API key that wasn't substituted.

Each tool returns a JSON error wrapper preserving the underlying message — read it for the specific endpoint.

### "graphman tool isn't listed / `Unknown tool`"

12 graphman tools register today, all over the graphman GraphQL API (`graphman_deployment_info`, `graphman_pause_deployment`, `graphman_resume_deployment`, `graphman_restart_deployment`, `graphman_get_execution_status`, `graphman_rewind_deployment`, `graphman_reassign_deployment`, `graphman_unassign_deployment`, `graphman_drop_deployment`, `graphman_check_blocks`, `graphman_truncate_chain_cache`, `graphman_clear_call_cache`). If a destructive one (rewind, drop, unassign, truncate-chain-cache, clear-call-cache) appears absent, it is gated by access control, not unregistered — see "Tool denied by access control" below and raise `ACCESS_LEVEL` (or add an `ACCESS_OVERRIDES_ALLOW` entry). `graphman_unused_record` / `graphman_unused_remove` are **intentionally not exposed**: deployment deletion goes solely through `graphman_drop_deployment` (GraphQL `deleteDeployment`), which auto-unassigns and force-deletes the data, making the unused record/remove flow redundant. The old `kubectl exec` CLI fallback stays removed; these tools need no kubectl access — only a graph-node build whose graphman GraphQL server exposes these mutations (see [tool-catalog.md](tool-catalog.md)). Older graph-node builds return a GraphQL error surfaced as `isError`.

### "Postgres tools return 'Postgres not configured — set GRAPH_NODE_POSTGRES_URL'"

`GRAPH_NODE_POSTGRES_URL` was unset at startup. Postgres tools always register (so they appear in the catalog) but return `isError: true` until a DSN is provided. Set the env var to a read-only DSN and restart.

### "Tool denied by access control"

Tool returned a message like:

```
Tool "graphman_drop_deployment" requires permission class "graphman_destructive".
Current access_level "read_write" does not grant it.
Raise access_level or add this tool to access_overrides.allow.
```

Inspect:

- The tool's permission class in [tool-catalog.md](tool-catalog.md).
- The current `ACCESS_LEVEL` (visible in `indexer://config`).
- `ACCESS_OVERRIDES_DENY` (deny always wins).

Either raise the level, add the tool to `ACCESS_OVERRIDES_ALLOW`, or accept the denial. See [access-control.md](access-control.md).

---

## Data-quality / staleness

### "Stale data showing in optimizer/health-check results"

When per-source caching lands (planned cache TTLs from the implementation plan: network parameters 1h, deployment signal 15m, indexing statuses 5m, epoch info 5m, graphman info 5m), mutation tools auto-invalidate the relevant entries. If upstream state changed externally (an operator approved an action via `indexer-cli`, or `graphman` was invoked outside the MCP), the cache may serve stale reads until its TTL elapses.

Workarounds:

- Wait for the TTL to expire and re-run.
- Restart the server to drop all in-process caches.

### "`get_infrastructure_overview` returns `partialErrors` for one source"

`buildOverview` is best-effort — a failed data source is captured under `partialErrors` so the rest of the snapshot still returns. Read the entry to see which source failed and why; the underlying tool for that source (e.g. `get_indexer_allocations`) will surface the same error with full detail.

### "EBO returns `null` for a chain"

`get_epoch_blocks` returns `null` when the EBO has no recorded value for that (epoch, chain) pair. Either the epoch is too old (pruned), too new (not yet recorded), or the chain alias is wrong. `get_current_epoch.networkBlocks[].network` lists chains the EBO currently tracks.

---

## Optimizer / allocation planning

### "Optimizer skips deployments with `projected annual reward < 2× gas`"

The optimizer drops deployments whose projected annual reward doesn't clear `2 × gasEstimateGrt`. The default (`0.3` GRT — single-mode lifecycle on Arbitrum One with 50% headroom) means deployments earning < 0.6 GRT/year get filtered.

If you're seeing too many deployments dropped:

- If you batch actions via indexer-agent's queue (the typical setup), real per-lifecycle cost is ~0.004 GRT — override `GAS_ESTIMATE_GRT=0.01` (or even lower) so the floor matches your reality.

If you're seeing unprofitable allocations slip through:

- Raise it. Compute your observed median lifecycle cost (open + close + POI submission), then add ~50% safety headroom.
- The 2× multiplier in the filter is intentional and already gives some headroom — set the env to your true median cost, not your tail-risk worst case.
- Single-mode submission (no batching): ~0.2 GRT per lifecycle is typical; the 0.3 default suits this.

### "Optimizer dropped a candidate citing `new-allocation 28d reward floor`"

This is the `MIN_REWARDS_GRT_28D` filter (default `10` GRT / 28 days). It applies to **new** allocations only — pre-seated existing allocations are exempt. The warning surfaces in `reward-floor reflow pass N` lines like:

```
reward-floor reflow pass 1: dropped 3 deployment(s) [...] — 3 for new-allocation 28d reward floor (< 10 GRT / 28d), the rest for gas floor (< 2× 0 GRT); ...
```

If the floor is filtering revenue-meaningful deployments you wanted:

- Lower the threshold (`MIN_REWARDS_GRT_28D=1`) or disable entirely (`MIN_REWARDS_GRT_28D=0`).
- Confirm the dropped candidate really is below ~`min_rewards_grt_28d × 365/28 ≈ 130` GRT/year at default. If it should be earning more, double-check `min_signal`, total network signal, and the deployment's signalled tokens — the projection math is in `calculateApr` / glossary.

If existing allocations look stuck on low-revenue deployments:

- The 28-day floor doesn't close them. A separate overall-APR check (planned) is needed to gate closes; for now, close them manually via `queue_unallocate` or by adjusting indexing rules.

---

## Cancellation / aborts

### "`AbortError` appearing in logs"

Expected behavior when a client cancels a long-running tool call. Every handler calls `extra.signal.throwIfAborted()` on entry, and the client's signal is combined with the per-request HTTP timeout via `AbortSignal.any` so the in-flight fetch is aborted too. A trailing `AbortError` on stderr after a Claude turn ends or a tool was cancelled by the user is not a fault.

Note: `pg` does not natively observe `AbortSignal` for in-flight queries (see TODO in `src/tools/postgres-tools.ts`); a single long-running Postgres query may complete after cancellation, but the signal IS checked between queries.

---

## graphman edge cases

### "A graphman tool (`clear_call_cache`, `check_blocks`, `rewind`, `drop`, …) is missing"

These operations are now live as GraphQL-backed tools (`graphman_clear_call_cache`, `graphman_check_blocks`, `graphman_rewind_deployment`, `graphman_drop_deployment`, `graphman_reassign_deployment`, `graphman_unassign_deployment`, `graphman_truncate_chain_cache`) — no kubectl, no host-side `graphman` invocation. The `kubectl exec` CLI fallback stays removed; the MCP reaches them over the graphman GraphQL API on `GRAPHMAN_API_URL`. If one looks absent: (1) the destructive ones are access-gated — check `ACCESS_LEVEL` / `ACCESS_OVERRIDES_DENY` (see "Tool denied by access control"); (2) calls fail with an `isError` GraphQL error if graph-node is too old to expose these mutations. `graphman_unused_record` / `graphman_unused_remove` are deliberately not exposed — delete via `graphman_drop_deployment` (`deleteDeployment`) instead, which auto-unassigns and force-deletes. See the Graphman section in [tool-catalog.md](tool-catalog.md).

---

## graph-node version requirements

The MCP queries `paused`, `node`, and `historyBlocks` on `subgraph_indexing_status`. These fields exist on graph-node >= 0.30.0 (released 2022). If you're running an older graph-node, the GraphQL query will fail with a schema-validation error before the MCP can normalize — the client's safe defaults only cover the case where a *successful* response omits the field, not the case where the server rejects the selection set up front.

Recommended: graph-node >= 0.35.0 for full compatibility with current MCP semantics. If you're stuck on an older version, the simplest workaround is to upgrade — these fields are foundational to cleanup / discovery classification and there's no MCP setting to selectively disable querying them.

Symptom on too-old graph-node: every call into `get_indexing_statuses` (and any composite tool that uses it — discovery, health checks, optimizer) fails with a GraphQL error message containing `Cannot query field "paused"` (or `"node"` / `"historyBlocks"`). The MCP surfaces the error verbatim in the tool result wrapper.

Note: even on a supported graph-node version, the discovery cleanup classifier intentionally does NOT auto-emit `orphaned` based on `status.node === null` alone. Older servers may default the field to null on successful responses, and transient unassignment is common during node restarts. The conjunctive rule (`paused` AND no allocation AND no curation signal) is the only trigger for an `orphaned` cleanup step.

---

## Reporting bugs

Include:

- Server version (currently `0.1.0`).
- Sanitized `indexer://config` snapshot (secrets are already stripped).
- The tool call that failed (name + args).
- The full error wrapper returned to the client.
- Relevant stderr lines from the MCP process around the failure (timestamps if possible).
