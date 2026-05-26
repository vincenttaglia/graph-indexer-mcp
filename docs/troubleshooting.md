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

### "graphman tools fail with `pod not found`" / "no matching pod"

The CLI fallback uses `kubectl exec` against a pod selected by `GRAPHMAN_POD_LABEL` in `GRAPHMAN_KUBECTL_NAMESPACE`. Checks:

1. `kubectl --context $CTX -n $GRAPHMAN_KUBECTL_NAMESPACE get pods -l $GRAPHMAN_POD_LABEL` — does this return exactly one running pod?
2. If running in-cluster, does the ServiceAccount have `pods`/`pods/exec` in that namespace?
3. If running locally, is the active kubectl context the one pointing at the right cluster?

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

The optimizer drops deployments whose projected annual reward doesn't clear `2 × gasEstimateGrt`. The default (`0.5` GRT — Arbitrum One single-action worst case) means deployments earning < 1 GRT/year get filtered.

If you're seeing too many deployments dropped:

- Lower `GAS_ESTIMATE_GRT`. Operators using batched action queues (the default indexer-agent flow) typically see ~0.004 GRT per lifecycle on Arbitrum — set `0.1` or lower if you batch.
- Confirm you're not on mainnet (where higher values are warranted) — the Graph network now runs on Arbitrum One.

If you're seeing unprofitable allocations slip through:

- Raise it. Compute your observed median lifecycle cost (open + close + POI submission), then add ~50% safety headroom.
- The 2× multiplier in the filter is intentional and already gives some headroom — set the env to your true median cost, not your tail-risk worst case.

---

## Cancellation / aborts

### "`AbortError` appearing in logs"

Expected behavior when a client cancels a long-running tool call. Every handler calls `extra.signal.throwIfAborted()` on entry, and the client's signal is combined with the per-request HTTP timeout via `AbortSignal.any` so the in-flight fetch is aborted too. A trailing `AbortError` on stderr after a Claude turn ends or a tool was cancelled by the user is not a fault.

Note: `pg` does not natively observe `AbortSignal` for in-flight queries (see TODO in `src/tools/postgres-tools.ts`); a single long-running Postgres query may complete after cancellation, but the signal IS checked between queries.

---

## graphman edge cases

### "`graphman_clear_call_cache` rejected my call"

`graphman_clear_call_cache` requires `confirm: true` AND exactly one of:

- `remove_all: true` (alone, no `from`/`to`).
- A complete `from`/`to` range with `to >= from`.

A bare invocation (no `remove_all`, no range) is intentionally rejected to prevent accidental full-cache wipes. See [tool-catalog.md](tool-catalog.md).

### "`graphman_check_blocks` rejected my call"

Same XOR shape: provide EITHER `block_number` (single block) OR both `from` and `to` (range, `to >= from`). Not both, not neither.

### "CLI tool output was truncated"

stdout/stderr from CLI graphman invocations are capped at 32 KiB per stream. When over the cap, the TAIL is preserved (the most useful diagnostics — graphman errors and exit summaries — print at the end of output) and `stdout_truncated`/`stderr_truncated` is set to `true`. Re-run the underlying graphman command directly via `kubectl exec` if you need the full output.

### "CLI fallback picked the wrong pod"

`GRAPHMAN_POD_LABEL` matched multiple pods. Tighten the selector to a label set that uniquely identifies the graph-node hosting graphman — e.g. add `component=index-node` or a `statefulset.kubernetes.io/pod-name=...` selector.

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
