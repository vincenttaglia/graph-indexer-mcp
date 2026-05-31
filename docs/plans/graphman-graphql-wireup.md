# Plan: Re-enable 7 graphman tools via the new graphman GraphQL API

Status: proposed
Owner: TBD
Last updated: 2026-05-31

> **Rescan note (2026-05-31):** §3–§5 were corrected against the actual graph-node
> `graphman-api-expand` source (resolver `#[Object]` impls + `entities/` structs). An
> earlier summary had several errors — `drop` is really `deleteDeployment`; `rewind`
> takes a deployment **list** + `startBlock`; `unused.remove` uses **minutes** and
> `count` defaults to **all**; `clearCallCache` has **three** modes incl. remove-all.
> The contract below is read from source, not summarized.

## 1. Goal

Wire **7 of the 9** currently-disabled graphman tools to the **graphman GraphQL API** that
the graph-node `graphman-api-expand` branch adds, replacing the removed kubectl/CLI path.
After this, 12 graphman tools are live over GraphQL — no kubectl, no local `graphman`
binary, no host-manual steps.

**Wire these 7** (boilerplate currently commented in `src/clients/graphman.ts` +
`src/tools/graphman-tools.ts`): `graphman_rewind_deployment`,
`graphman_reassign_deployment`, `graphman_unassign_deployment`,
`graphman_drop_deployment`, `graphman_check_blocks`, `graphman_truncate_chain_cache`,
`graphman_clear_call_cache`.

**Intentionally NOT wired** — `graphman_unused_record` and `graphman_unused_remove`.
Deployment deletion goes **solely through `deleteDeployment`** (it force-deletes the
indexed data directly and auto-unassigns first), so the old "record-unused →
remove-unused" GC sequence is redundant. Their commented boilerplate is **deleted**, not
revived. (The graph-node `unused.*` GraphQL mutations still exist; we simply don't expose
them. `unassign` is kept — it's a distinct "stop indexing, keep data" op, not part of the
deletion flow.)

## 2. Runtime prerequisite (graph-node side — already built)

The patch is the graph-node branch `graphman-api-expand` at
`~/Documents/VSCodeium/graph-node`. It exposes the mutations below on the existing
graphman GraphQL server (already configured as `GRAPHMAN_API_URL`, Bearer auth via
`GRAPHMAN_AUTH_TOKEN` — confirmed in `server/graphman/src/auth.rs`; **no MCP auth/config
change needed**). This plan covers only the **MCP-side wiring**; the operator must run a
graph-node build including this branch for the tools to work at runtime.

## 3. Verified API contract (read from source)

Root mutation namespaces: **`deployment`, `unused`, `chain`**. Deployments are addressed
by `DeploymentSelector` input `{ hash, name, shard, schema }` (we pass `{ hash: <Qm CID> }`).
Scalars `BlockHash` (hex string), `BlockNumber` (String-serialized i32), `ExecutionId`
(String-serialized i64) — block numbers go on the wire as **strings**. `delaySeconds`,
`count`, `ttlDays`, `maxContracts` are GraphQL **Int**.

### `deployment` namespace
- **`rewind`** → `ExecutionId` **(ASYNC)**
  `rewind(deployments: [DeploymentSelector!]!, startBlock: Boolean = false, blockHash: BlockHash, blockNumber: BlockNumber, force: Boolean = false, delaySeconds: Int = 20)`
  Server validates: `deployments` non-empty (all same chain); `startBlock` XOR
  (`blockHash` AND `blockNumber`). Pauses → waits `delaySeconds` → rewinds (or truncates
  to start block) → resumes, in the background.
- **`deleteDeployment`** → `[String!]` (deleted locators) **(sync)** — this is our "drop".
  `deleteDeployment(deployment: DeploymentSelector!, all: Boolean = false)`
  Force-deletes indexed data + metadata; first unassigns. A `Qm` hash may match multiple
  deployments → the call **fails unless `all = true`** (or target a single `sgd` namespace).
- **`reassign`** → union `ReassignResponse = Ok{success} | CompletedWithWarnings{success, warnings: [String!]!}` **(sync)**
  `reassign(deployment: DeploymentSelector!, node: String!)` (`node` validated as NodeId).
- **`unassign`** → `EmptyResponse{success}` **(sync)**
  `unassign(deployment: DeploymentSelector!)`

### `chain` namespace
- **`checkBlocks`** → union `CheckBlocksResponse = Result{diverged, blocks[{number, outcome, hashes, diff}]} | Execution{id}` **(sync for byHash/byNumber; ASYNC for byRange)**
  `checkBlocks(chain: String!, method: CheckBlocksMethod!)` where
  `CheckBlocksMethod = { byHash: BlockHash, byNumber: { number: BlockNumber!, deleteDuplicates: Boolean = false }, byRange: { from: BlockNumber, to: BlockNumber, deleteDuplicates: Boolean = false } }` — **exactly one** of the three.
  **Always deletes cache entries that diverge** from the provider (`diverged` = count
  deleted); `outcome ∈ {Matched, Diverged, NotFound, DuplicatesDeleted, DuplicatesSkipped}`.
- **`truncateChainCache`** → `EmptyResponse{success}` **(sync)**
  `truncateChainCache(chain: String!)`
- **`clearCallCache`** → union `ClearCallCacheResponse = Empty{success} | Stale{…eviction stats}` **(sync)**
  `clearCallCache(chain: String!, from: BlockNumber, to: BlockNumber, removeEntireCache: Boolean = false, ttlDays: Int, maxContracts: Int)`
  **Three mutually-exclusive modes:** (a) range = `from`+`to`; (b) `removeEntireCache: true`;
  (c) stale-eviction = `ttlDays` (≥1, optional `maxContracts`). Server rejects mixed modes.

### `unused` namespace — NOT wired
`unused.record` / `unused.remove` exist on the server but are intentionally not exposed
(see §1). `deleteDeployment` is the sole MCP deletion path.

`EmptyResponse = { success }`. `ExecutionId` polled via the existing
`graphman_get_execution_status` (execution query).

## 4. Contract changes vs. the old CLI (decisions baked in)

1. **`rewind` is async + multi-deployment + explicit `startBlock`.** Returns
   `ExecutionId` (poll like `restart`). Our tool keeps a single `deployment_id` (wrap in a
   1-element list) and adds `start_block`, `force`, `delay_seconds`. Zod refine: `start_block`
   XOR (`block_hash` AND `block_number`).
2. **"drop" → `deleteDeployment` with `all`.** Tool maps to `deployment.deleteDeployment`;
   add an `all: boolean` arg (needed when a `Qm` hash matches multiple deployments — without
   it the server errors). Result is a list of deleted locators (surface it).
3. **`clear_call_cache` gains modes (remove-all NOT dropped).** Tool input supports the
   three modes: `{ chain, from?, to?, remove_entire_cache?, ttl_days?, max_contracts? }` with
   a refine enforcing exactly one mode. The old `remove_all` maps to `remove_entire_cache`.
   Surface the union (`Empty` vs `Stale` stats).
4. **`unused_record` / `unused_remove` are dropped** — deletion is solely
   `deleteDeployment` (auto-unassigns + force-deletes data in one call). Delete their
   commented boilerplate rather than reviving it.
5. **`check_blocks` is a mutation that deletes diverged cache entries** (confirmed in
   `chain_mutation.rs`/`check_blocks.rs`). Reclassify `read → graphman_safe` (see §5).
   Tool input `{ chain, by_hash? | by_number{ number, delete_duplicates? } | by_range{ from?, to?, delete_duplicates? } }`, exactly-one refine. Returns sync `Result` or `{ execution_id }`
   for `by_range` (async).
6. **`reassign` returns a union** — surface `{ success, warnings? }`.
7. **`drop`/`deleteDeployment` auto-unassigns internally** — single call; the cleanup
   prompt no longer needs to pre-sequence unassign → unused.
8. **Normalize ids to Qm** via `toQmDeploymentId()` before populating
   `DeploymentSelector.hash` (the existing pause/resume pass the raw id; normalize the new
   ops, and consider fixing the existing ones for consistency).

## 5. Permission classes

| Tool | Class | Confirm? | Note |
|---|---|---|---|
| `graphman_reassign_deployment` | `graphman_safe` | no | unchanged |
| `graphman_check_blocks` | **`graphman_safe`** (was `read`) | no | now deletes diverged cache entries (re-fetchable, so `safe` not `destructive`) |
| `graphman_rewind_deployment` | `graphman_destructive` | **yes** | discards entity state; async |
| `graphman_drop_deployment` | `graphman_destructive` | **yes** | irreversible data deletion (sole deletion path) |
| `graphman_unassign_deployment` | `graphman_destructive` | **yes** | unchanged |
| `graphman_truncate_chain_cache` | `graphman_destructive` | **yes** | irreversible cache wipe |
| `graphman_clear_call_cache` | `graphman_destructive` | **yes** | `removeEntireCache` is heavy |

Keep the tool-layer `confirm: z.literal(true)` gate on every destructive op (independent of
GraphQL). `graphman_destructive` then has live tools again — the k8s
`read_write_destructive`/`mcp-admin` mappings and the configmap `ACCESS_OVERRIDES_DENY`
default become meaningful (§7).

## 6. Work breakdown

Cohesive, all-graphman; foundation-first since the tool layer depends on the client method
signatures.

### Stage 1 — Client + types (`src/clients/graphman.ts`, `src/types/graphman.ts`)
- Replace the commented CLI boilerplate with the GraphQL operation documents from §3 and
  implement the **7** methods on `GraphmanClient` via `gql.request(...)` (mirror pause/
  resume/restart; forward `signal`; normalize ids via `toQmDeploymentId`). **Delete** the
  commented `unusedRecord`/`unusedRemove` method boilerplate.
- Async ops (`rewind`, `checkBlocks` byRange) return `{ executionId }` → reuse
  `getExecutionStatus`. Handle the unions (`ReassignResponse`, `CheckBlocksResponse`,
  `ClearCallCacheResponse`) — return discriminated results.
- Extend `src/types/graphman.ts`: `CheckBlocksResult`/`CheckedBlock`/`CheckBlockOutcomeKind`,
  reassign warnings, clear-call-cache stale stats. (No `UnusedDeploymentInfo` — not wired.)
- Invalidate `deploymentInfoCache` on success for rewind/drop/reassign/unassign.
- Remove obsolete `runCli`/`GraphmanCliResult` remnants.

### Stage 2 — Tools (`src/tools/graphman-tools.ts`)
- Un-comment + rewrite the **7** `registerIndexerTool` blocks with the §4 Zod schemas and §5
  permission classes; **delete** the commented `graphman_unused_record` /
  `graphman_unused_remove` tool blocks. Refines: rewind (start_block XOR hash+number),
  check_blocks (exactly-one method), clear_call_cache (exactly-one mode), confirm gates on
  the 5 destructive ops. Add the `all` flag to drop and surface deleted locators; surface
  reassign warnings; return execution ids for async ops with a "poll
  graphman_get_execution_status" hint. Keep the existing injection guards (deployment id /
  chain / node patterns).

### Stage 3 — Docs, prompts, resources (reverse the "disabled/manual" notes)
- `docs/tool-catalog.md`: move the 7 back to active (Graphman → 12 tools); keep
  `graphman_unused_record`/`graphman_unused_remove` listed under a short
  "Intentionally not exposed" note (deletion goes through `deleteDeployment`); document new
  args/async returns/`all`/modes.
- `docs/access-control.md`: restore the 7 tools to their class rows; note check_blocks →
  `graphman_safe`; drop the "currently unavailable" caveats.
- `docs/config-reference.md`: remove the "tools unavailable" note for these.
- Prompts: in `investigate-unhealthy.ts`, `pre-epoch-health-check.ts`,
  `recover-failed-deployment.ts`, **reverse the `(manual)` markings** back to live tool
  calls (keep the rpc_call/get_subgraph_manifest enhancements). **`cleanup-stale-deployments.ts`
  needs rework, not just un-marking**: its removal sequence was close-allocation → pause →
  unassign → unused_record → unused_remove → drop. With `unused_*` gone, that collapses to
  **close allocation → `graphman_drop_deployment` (deleteDeployment)** (which auto-unassigns
  + force-deletes); drop the unused_record/unused_remove steps entirely. `set_indexing_rule
  decisionBasis=never` and `graphman_pause_deployment` remain as the non-deletion options.
  Note check_blocks now returns structured divergence.
- `src/resources/glossary.ts` + recover prompt header: un-disable.
- Update memory `project_graphman_no_kubectl.md`: kubectl stays removed; 7 ops are now live
  over GraphQL; `unused_record`/`unused_remove` intentionally dropped (deletion =
  `deleteDeployment`).

### Stage 4 — Tests + audit
- Per-tool unit tests with a fake `gql` (mirror `test/tools/*`): assert the correct GraphQL
  document + variables; async ops return an execution id; unions are decoded (reassign
  warnings, checkBlocks Result vs Execution, clearCallCache Empty vs Stale); refines reject
  bad combos (rewind start_block+hash, check_blocks two-methods, clear_call_cache two-modes,
  destructive without confirm; drop `all` path). Restore graphman fakes in `test/fakes.ts`
  (7 ops, no unused_*).
- `npm run typecheck` + `npm test` + `npm run build`.
- Codex audit on the diff (confirm gates, permission classes esp. check_blocks reclass,
  injection guards, union/async handling, drop multi-match `all` behavior).

## 7. Cleanups this unblocks
- Configmap `ACCESS_OVERRIDES_DENY: graphman_drop_deployment,graphman_rewind_deployment`
  stops logging "unknown tool" warnings (tools exist again) — keep as a real safety default.
- `graphman_destructive` has live tools again — verify access-control level examples reflect it.

## 8. Risks / decisions (resolved on rescan unless noted)
- **graph-node version**: API only exists on a build including `graphman-api-expand`. Older
  graph-node → GraphQL errors surfaced as `isError` (acceptable; document the prerequisite).
- **check_blocks semantics — RESOLVED**: always deletes diverged entries (+ duplicates when
  `deleteDuplicates`). → `graphman_safe`, no `confirm`.
- **clear_call_cache — RESOLVED**: remove-all exists (`removeEntireCache`) plus a new
  `ttlDays` stale-eviction mode; expose all three.
- **`deleteDeployment` is the sole deletion path** — `unused.*` deliberately not exposed.
  If an operator ever needs the record/remove GC flow, it's an explicit future addition, not
  an oversight.
- **drop multi-match**: a `Qm` hash can match multiple `sgd` deployments; without `all` the
  server errors. The tool should default `all=false` (safe; errors on ambiguity) and surface
  the locator list so the operator can disambiguate (re-call with `all=true` or an `sgd`
  selector).

## 9. Sequencing
Stage 1 (client+types) → Stage 2 (tools) → Stage 3 (docs/prompts/resources) →
Stage 4 (tests+audit). Single cohesive branch; matches the prior feature workflow.
