# Access control

Every MCP tool is gated by `checkAccess()` (`src/access-control.ts`). A tool call is allowed only if the resolution order below permits it; otherwise the call returns an `isError: true` `CallToolResult` with a message describing why it was denied.

## The 4 levels

Set via `ACCESS_LEVEL` (default `read_write`). Each level grants a fixed set of permission classes:

| Level | Permission classes granted |
| --- | --- |
| `read_only` | `read` |
| `read_write` (default) | `read`, `agent_queue`, `graphman_safe` |
| `read_write_destructive` | `read`, `agent_queue`, `graphman_safe`, `graphman_destructive` |
| `full` | `read`, `agent_queue`, `agent_approve`, `graphman_safe`, `graphman_destructive` |

Note: `agent_approve` is ONLY granted at `full`. This is intentional — approving queued indexer-agent actions commits real GRT on-chain, so the default `read_write` level still requires a human operator to approve, even though the LLM may queue actions.

## The 5 permission classes

A tool's class is declared at registration via `registerIndexerTool({ ..., permissionClass: ... })` and stored in the permission registry (`registerToolPermission`).

| Class | Gates |
| --- | --- |
| `read` | All read-only tools — every `get_*` / `*_info` / `run_*` composite, `get_action_queue`, `get_indexing_rules`, `graphman_deployment_info`, `graphman_get_execution_status`, `get_subgraph_manifest`, `rpc_call`, `list_rpc_chains`. (`graphman_check_blocks` was previously `read` but is now `graphman_safe` — it deletes diverging cache entries.) |
| `agent_queue` | Adds entries to the indexer-agent action queue: `queue_allocate`, `queue_unallocate`, `queue_reallocate`, `set_indexing_rule`, `set_cost_model`. Queued actions still require approval before execution. |
| `agent_approve` | Approves or cancels queued agent actions: `approve_actions`, `cancel_actions`. Granted only at `full` because approval triggers on-chain transactions. |
| `graphman_safe` | Non-destructive graphman writes: `graphman_pause_deployment`, `graphman_resume_deployment`, `graphman_restart_deployment`, `graphman_reassign_deployment`, and `graphman_check_blocks` (reclassified from `read` — it deletes diverging cache entries, which are re-fetchable). |
| `graphman_destructive` | Destructive graphman ops — all live as GraphQL tools, each gated by an explicit `confirm: true` arg in addition to the access level: `graphman_rewind_deployment` (async; discards entity state past the target), `graphman_unassign_deployment` (detach, data preserved), `graphman_drop_deployment` (IRREVERSIBLE `deleteDeployment` — the sole deletion path), `graphman_truncate_chain_cache` (wipe block cache), `graphman_clear_call_cache` (`remove_entire_cache` is heavy). Granted at `read_write_destructive` and `full`. |

> **graphman destructive tools have live tools again.** The 7 formerly CLI-only operations — `graphman_rewind_deployment`, `graphman_reassign_deployment`, `graphman_unassign_deployment`, `graphman_drop_deployment`, `graphman_check_blocks`, `graphman_truncate_chain_cache`, `graphman_clear_call_cache` — are now registered as pure-GraphQL tools (no kubectl). `graphman_check_blocks` moved `read → graphman_safe`. `graphman_unused_record` / `graphman_unused_remove` are **intentionally not exposed** (deletion goes through `graphman_drop_deployment` / `deleteDeployment`); any `ACCESS_OVERRIDES` that name them are harmless no-ops.

The exact class for any tool is in [tool-catalog.md](tool-catalog.md) under the **Permission** field. Tool descriptions are auto-annotated with `[Requires permission: <class>]` so clients can surface it.

> **Note on `rpc_call`.** The RPC passthrough is `read`-classed because it is read-only *by construction*: a fixed in-code method allowlist permits only read methods, and state-changing methods (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_*`, `eth_sign*`, …) are refused before the call is dispatched. The server holds no signer, so no transaction can be submitted regardless. The agent selects a chain **alias** (never a URL), and third-party (`remote`) endpoints can be disabled entirely with `RPC_ALLOW_REMOTE=false` — see [config-reference.md](config-reference.md).

## Overrides

Two comma-separated env vars layer on top of the level:

- `ACCESS_OVERRIDES_ALLOW` — grants the named tool even when the level wouldn't.
- `ACCESS_OVERRIDES_DENY` — blocks the named tool unconditionally.

Names are exact tool names (snake_case), comma-separated, whitespace-tolerant:

```bash
ACCESS_OVERRIDES_ALLOW=approve_actions,graphman_rewind_deployment
ACCESS_OVERRIDES_DENY=graphman_drop_deployment,graphman_truncate_chain_cache
```

Unknown override names produce a stderr warning at startup (`[mcp] warn: access_overrides.allow references unknown tool "..."`) but do not fail boot — useful if a deployment carries forward an override across a refactor.

## Resolution order

For every tool call, `checkAccess()` runs:

1. **Deny override** — if the tool is in `ACCESS_OVERRIDES_DENY`, deny.
2. **Registered class required** — if the tool has no registered permission class, deny. Unknown tools cannot be allowed by override (default deny).
3. **Allow override** — if the tool is in `ACCESS_OVERRIDES_ALLOW`, allow.
4. **Level grants the class** — if the tool's class is in the active level's set, allow.
5. Otherwise, deny.

Deny always wins. An override allow grants beyond the level. The active level is the default both directions: it grants any tool whose class it covers, and denies any tool whose class it doesn't.

## Worked example: full access minus one destructive

Goal: let Claude do everything — including approve actions and run destructive graphman ops — except `graphman_drop_deployment`, which we never want exposed.

```bash
ACCESS_LEVEL=full
ACCESS_OVERRIDES_DENY=graphman_drop_deployment
ACCESS_OVERRIDES_ALLOW=
```

Result:

- `graphman_drop_deployment` → denied (rule 1; deny wins over the level grant).
- `graphman_rewind_deployment`, `graphman_unassign_deployment`, `graphman_truncate_chain_cache`, etc. → allowed (level grants `graphman_destructive`).
- `approve_actions`, `cancel_actions` → allowed (level grants `agent_approve`).
- All reads → allowed.

## Worked example: read-only with one safe write

Goal: a discovery-only deployment that may pause a deployment if it's stuck.

```bash
ACCESS_LEVEL=read_only
ACCESS_OVERRIDES_ALLOW=graphman_pause_deployment
ACCESS_OVERRIDES_DENY=
```

Result:

- All reads → allowed.
- `graphman_pause_deployment` → allowed by override despite the level not granting `graphman_safe`.
- All other writes → denied.

## Pluggable authorizers (`MCP_AUTHZ`)

The resolver above is split into two parts so the grant decision can be swapped
without weakening the floor:

- **Invariants** (always enforced, in every mode, in the `checkAccess` wrapper
  itself): unknown tool → deny; deny-list (`ACCESS_OVERRIDES_DENY`) → deny. An
  authorizer can only grant *within* this floor — it can never re-enable a
  denied or unregistered tool.
- **Grants** (pluggable): "does this caller get this permission class?" — handled
  by the configured `Authorizer`. Selected with `MCP_AUTHZ`.

| `MCP_AUTHZ` | Transport | Grant decision |
| --- | --- | --- |
| `static` (default) | stdio or http | `ACCESS_OVERRIDES_ALLOW` lists the tool, OR the active `ACCESS_LEVEL` grants its class. Identical to the model documented above; identity is ignored. |
| `k8s-rbac` | http only | Per-caller. The caller's bearer token is resolved to a user + groups via a Kubernetes **TokenReview**, then a **SubjectAccessReview** asks the apiserver whether that subject is allowed the permission class. |

`k8s-rbac` requires `MCP_TRANSPORT=http` — stdio has no per-caller identity.
See [deployment.md](deployment.md#http-profile--in-cluster-rbac) for the manifests
and the `system:auth-delegator` requirement.

### Permission class → RBAC verb

Under `k8s-rbac` each permission class is checked as a SubjectAccessReview verb
on the synthetic resource `tools.mcp.thegraph.io`:

| Permission class | SAR verb | apiGroup / resource |
| --- | --- | --- |
| `read` | `read` | `mcp.thegraph.io` / `tools` |
| `agent_queue` | `agent_queue` | `mcp.thegraph.io` / `tools` |
| `agent_approve` | `agent_approve` | `mcp.thegraph.io` / `tools` |
| `graphman_safe` | `graphman_safe` | `mcp.thegraph.io` / `tools` |
| `graphman_destructive` | `graphman_destructive` | `mcp.thegraph.io` / `tools` |

The shipped tiers (`k8s/clusterrole-mcp-roles.yaml`) mirror the static levels:
`mcp-readonly` ≈ `read_only`, `mcp-operator` ≈ `read_write`, `mcp-admin` ≈
`full` (the only tier with `agent_approve` + `graphman_destructive`).

### The deny-list is an in-app invariant in both modes

Kubernetes RBAC is **allow-only** — there is no "deny" rule, so binding a subject
to a higher tier purely adds verbs. The deny-list (`ACCESS_OVERRIDES_DENY`)
therefore remains the **only** "deny" mechanism, and it is enforced in-app as an
invariant *before* the authorizer runs — independent of `MCP_AUTHZ`. A tool on
the deny-list is unreachable no matter which ClusterRole a caller holds.

## Programmatic registration

The wrappers in `src/server/register.ts` (`registerIndexerTool`, `registerIndexerResource`, `registerIndexerPrompt`) are the only path through which tools are added. They:

1. Call `registerToolPermission(name, permissionClass)` so `checkAccess` knows the class.
2. Append `[Requires permission: <class>]` to the description so clients can display the requirement.
3. Wrap the handler so `checkAccess(name)` runs before the handler executes; denied calls never reach the handler.
4. Forward the SDK's `extra.signal` so handlers can honor client cancellation.

This means every tool is access-controlled by construction — there is no path to register a tool that bypasses the resolver.
