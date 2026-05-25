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
| `read` | All read-only tools — every `get_*` / `*_info` / `run_*` composite, `get_action_queue`, `get_indexing_rules`, `graphman_deployment_info`, `graphman_get_execution_status`, `graphman_check_blocks`. |
| `agent_queue` | Adds entries to the indexer-agent action queue: `queue_allocate`, `queue_unallocate`, `queue_reallocate`, `set_indexing_rule`, `set_cost_model`. Queued actions still require approval before execution. |
| `agent_approve` | Approves or cancels queued agent actions: `approve_actions`, `cancel_actions`. Granted only at `full` because approval triggers on-chain transactions. |
| `graphman_safe` | Non-destructive graphman writes: `graphman_pause_deployment`, `graphman_resume_deployment`, `graphman_restart_deployment`, `graphman_reassign_deployment`. |
| `graphman_destructive` | Destructive graphman ops: `graphman_rewind_deployment`, `graphman_unassign_deployment`, `graphman_drop_deployment`, `graphman_unused_record`, `graphman_unused_remove`, `graphman_truncate_chain_cache`, `graphman_clear_call_cache`. Most also require an explicit `confirm: true` arg. |

The exact class for any tool is in [tool-catalog.md](tool-catalog.md) under the **Permission** field. Tool descriptions are auto-annotated with `[Requires permission: <class>]` so clients can surface it.

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
- `graphman_unused_remove`, `graphman_rewind_deployment`, etc. → allowed (level grants `graphman_destructive`).
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

## Programmatic registration

The wrappers in `src/server/register.ts` (`registerIndexerTool`, `registerIndexerResource`, `registerIndexerPrompt`) are the only path through which tools are added. They:

1. Call `registerToolPermission(name, permissionClass)` so `checkAccess` knows the class.
2. Append `[Requires permission: <class>]` to the description so clients can display the requirement.
3. Wrap the handler so `checkAccess(name)` runs before the handler executes; denied calls never reach the handler.
4. Forward the SDK's `extra.signal` so handlers can honor client cancellation.

This means every tool is access-controlled by construction — there is no path to register a tool that bypasses the resolver.
