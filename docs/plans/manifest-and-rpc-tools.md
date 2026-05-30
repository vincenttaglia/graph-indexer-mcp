# Plan: `get_subgraph_manifest` + read-only RPC passthrough tools

Status: proposed
Owner: TBD
Last updated: 2026-05-30

## 1. Goal

Add two new MCP tools:
1. **`get_subgraph_manifest`** — given a subgraph deployment ID, fetch its manifest
   from IPFS and return it parsed (YAML→JSON) plus raw.
2. **`rpc_call`** — a **read-only** JSON-RPC passthrough so an agent can query
   chain state across the chains the indexer serves, via operator-configured
   endpoints, with a method allowlist.

## 2. Decisions (locked via review)

- **RPC posture: read-only allowlist.** Only safe read methods are permitted;
  state-changing methods (`eth_sendRawTransaction`, `eth_sendTransaction`,
  `personal_*`, …) are hard-refused in code. The server holds no signer, so this
  is both safe and complete. Gated under the existing `read` permission class —
  **no new permission class, no access-control core change.**
- **RPC chains: multi-chain map, local vs third-party differentiated.** Endpoints
  are an operator-supplied `alias → { local?, remote? }` map. The agent selects a
  chain alias (never a raw URL) and may prefer `local` (the indexer's own node —
  trusted, private, fast) or `remote` (third-party/public — may rate-limit, log
  queries, or require keys). Results label which kind was used; raw URLs are never
  returned (they may embed API keys).
- **Manifest: deployment-ID → IPFS gateway.** Accept `Qm…` or `0x…bytes32`,
  normalize with the existing `src/utils/ipfs.ts` converters, GET from a
  configurable IPFS gateway, return parsed manifest + raw text.

## 3. Background (verified against the codebase)

- The **network subgraph does NOT expose manifest content** — only on-chain
  metadata (`src/clients/network-subgraph.ts`, `SubgraphDeployment` fields:
  id/signalledTokens/stakedTokens/…). The manifest lives on **IPFS**, and the
  deployment ID **is** its CID.
- `src/utils/ipfs.ts` already provides `toQmDeploymentId()` /
  `toBytes32DeploymentId()` (base58 ↔ bytes32) but **no fetch capability**.
- **No IPFS endpoint and no blockchain RPC** exist in `src/config.ts` today.
- **No ethers/viem/web3** dependency — JSON-RPC will be plain `fetch` + JSON.
- Tool pattern: `registerIndexerTool(server, { name, permissionClass, description,
  inputSchema, handler })`; `asText(payload)` formats `CallToolResult`; handlers
  call `extra.signal.throwIfAborted()` and forward `signal` into I/O
  (`src/tools/network-tools.ts`).
- Timeout/abort pattern to reuse: the `timedFetch` composition in
  `src/utils/graphql-client.ts` (~lines 163–200) — `AbortSignal.any([...])` +
  per-request timeout. We'll extract a tiny shared `httpPostJson`/`httpGetText`
  helper rather than depend on `graphql-request` (which is GraphQL-only).

## 4. New configuration (`src/config.ts`)

Follow the existing Zod + `envToConfigInput` + `csv()` pattern.

```ts
// IPFS (manifest tool)
ipfsGatewayUrl: z.url().default('https://ipfs.network.thegraph.com'),  // IPFS_GATEWAY_URL
ipfsMaxBytes: z.coerce.number().int().positive().default(5_000_000),    // IPFS_MAX_BYTES (manifest size cap)

// RPC (passthrough tool) — JSON map parsed from RPC_ENDPOINTS
rpcEndpoints: z.record(
  z.string(),                                   // chain alias, e.g. "arbitrum-one"
  z.object({ local: z.url().optional(), remote: z.url().optional() })
    .refine(v => v.local || v.remote, 'each chain needs a local or remote URL'),
).default({}),
rpcAllowRemote: z.coerce.boolean().default(true),   // RPC_ALLOW_REMOTE — kill switch for third-party
rpcTimeoutMs: z.coerce.number().int().positive().default(10_000),  // RPC_TIMEOUT_MS
rpcMaxBytes: z.coerce.number().int().positive().default(2_000_000), // RPC_MAX_BYTES
```

`envToConfigInput`: `rpcEndpoints: env.RPC_ENDPOINTS ? JSON.parse(env.RPC_ENDPOINTS) : undefined`
(wrap parse in a clear error if malformed). Example env:

```
RPC_ENDPOINTS={"arbitrum-one":{"local":"http://arb-node:8545","remote":"https://arb1.arbitrum.io/rpc"},"mainnet":{"remote":"https://eth.example/rpc"}}
```

The RPC tool registers only when `rpcEndpoints` is non-empty (otherwise the tool
is omitted, so it never appears unconfigured).

## 5. New dependency

- **`yaml`** (npm, widely-used, no transitive deps) for manifest parsing. This is
  the one new runtime dependency. Alternative: return raw only — rejected, since
  the decision is to return parsed JSON. On parse failure the tool returns the raw
  text plus a `parse_error` field (never throws away the bytes).

## 6. Tool designs

### 6.1 `get_subgraph_manifest`  (permission class: `read`)
- **Input:** `{ deployment_id: z.string().min(1) }` (accepts `Qm…` or
  `0x…bytes32`).
- **Handler:**
  1. `extra.signal.throwIfAborted()`.
  2. `const cid = toQmDeploymentId(deployment_id)` (validates + normalizes;
     throws a clear error on a bad ID).
  3. `const raw = await ipfsClient.cat(cid, { signal, maxBytes })` →
     `GET {ipfsGatewayUrl}/ipfs/{cid}` with timeout + size cap.
  4. Parse YAML → JSON; build result `{ deployment_id: cid, manifest: <parsed>,
     manifest_raw: <text> }`. On parse error: `{ …, manifest: null, manifest_raw,
     parse_error }`.
- **Client:** new `src/clients/ipfs.ts` — `createIpfsClient({ gatewayUrl, maxBytes })`
  with `cat(cid, opts)`. Fail-closed on non-2xx / oversize / timeout with a clear
  message; never include gateway credentials in errors.

### 6.2 `rpc_call`  (permission class: `read`)
- **Input:**
  ```ts
  {
    chain: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'chain alias'),  // must exist in rpcEndpoints
    method: z.string(),                                             // must be in READ_ALLOWLIST
    params: z.array(z.unknown()).default([]),
    source: z.enum(['local', 'remote', 'auto']).default('auto'),
  }
  ```
- **Method allowlist (fixed constant in code; read-only):** `eth_chainId`,
  `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_call`,
  `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`,
  `eth_getLogs`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
  `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_estimateGas`,
  `net_version`, `web3_clientVersion`. Anything else → refuse with
  `"method X is not permitted (read-only allowlist)"`. (A small, explicit list is
  the security boundary — extending it is a deliberate code change + review.)
- **Endpoint resolution:**
  - `chain` must be a key in `config.rpcEndpoints` (else refuse — prevents
    SSRF/typo; the agent never supplies a URL).
  - `source='local'` → require `entry.local`; `'remote'` → require `entry.remote`
    AND `rpcAllowRemote` (else refuse); `'auto'` → prefer `local`, else `remote`
    if allowed.
- **Handler:** build `{ jsonrpc: '2.0', id: 1, method, params }`, POST with
  timeout + size cap + `extra.signal`. Return `{ chain, endpoint_kind:
  'local'|'remote', result }` or `{ …, error }` faithfully relaying the JSON-RPC
  error object. **Never** return the endpoint URL.
- **Client:** new `src/clients/rpc.ts` — `createRpcClient({ endpoints, allowRemote,
  timeoutMs, maxBytes })` with `call(chain, method, params, source, opts)`.

## 7. Shared HTTP helper

Extract `src/utils/http.ts` with `httpGetText(url, { signal, timeoutMs, maxBytes })`
and `httpPostJson(url, body, { signal, timeoutMs, maxBytes })`, reusing the
`timedFetch` timeout/`AbortSignal.any` pattern from `graphql-client.ts`. Both cap
the response body (stream + byte counter → abort on overflow) and fail closed.
Used by both new clients; keeps timeout/size logic in one audited place.

## 8. Work breakdown (foundation-first swarm, mirrors the authz feature)

Both tools funnel through the shared files `src/config.ts` and `src/index.ts`, so
a naive parallel fan-out conflicts. Same proven shape:

### Stage 1 — Foundation (solo, on a feature branch)
- Add all config fields (§4) + `envToConfigInput` wiring + the `RPC_ENDPOINTS`
  JSON parse guard.
- Add the `yaml` dependency (`package.json`).
- Create `src/utils/http.ts` (§7) with unit tests.
- Create STUB modules: `src/clients/ipfs.ts`, `src/clients/rpc.ts`,
  `src/tools/manifest-tools.ts`, `src/tools/rpc-tools.ts` (exports throwing
  "not implemented") with the exact signatures the leaves will fill.
- Wire `index.ts`: instantiate the two clients from config and call
  `registerManifestTools` / `registerRpcTools` (the latter only when
  `rpcEndpoints` is non-empty), alongside the existing registrations (~lines
  95–101). Lazy/conditional as needed.
- `npm run typecheck` + `npm test` green; commit.

### Stage 2 — Parallel leaves (isolated worktrees, disjoint files)
- **Leaf A — manifest:** implement `src/clients/ipfs.ts` (`cat`) +
  `src/tools/manifest-tools.ts` (`get_subgraph_manifest`) + tests
  (`test/clients/ipfs.test.ts`, tool test with injected fake fetch: Qm and
  bytes32 input, YAML parse, parse-error path, oversize/timeout → fail-closed).
- **Leaf B — rpc:** implement `src/clients/rpc.ts` + `src/tools/rpc-tools.ts`
  (`rpc_call`) + tests: allowlisted method passes; non-allowlisted refused;
  state-changing refused; unknown chain refused; `source` resolution incl.
  `rpcAllowRemote=false` blocking remote; JSON-RPC error relayed; URL never
  leaked; timeout/size fail-closed.

### Stage 3 — Integrate + verify + audit
- Merge both branches (disjoint → clean), `typecheck` + `test` + `build`.
- Codex security audit focused on: SSRF (chain→URL only from config, no raw URL
  path), allowlist completeness (no state-changing method reachable, no
  case/alias bypass), URL/secret leakage in errors/logs, fail-closed on every
  error path, response-size/timeout enforcement, YAML parse safety (no code exec
  — `yaml.parse` is data-only), and that the manifest CID normalization can't be
  tricked into fetching an arbitrary path.

## 9. Docs
- `docs/tool-catalog.md`: add both tools + their permission class (`read`).
- `docs/config-reference.md`: `IPFS_GATEWAY_URL`, `IPFS_MAX_BYTES`,
  `RPC_ENDPOINTS` (JSON shape + example), `RPC_ALLOW_REMOTE`, `RPC_TIMEOUT_MS`,
  `RPC_MAX_BYTES`.
- `docs/access-control.md`: note `rpc_call` is read-only-by-construction (method
  allowlist) and why it stays in the `read` class; note the local/remote trust &
  privacy distinction.

## 10. Security notes
- **SSRF:** the agent supplies a chain **alias**, never a URL; the URL comes from
  operator config. Unknown alias → refuse. `rpcAllowRemote=false` fully disables
  third-party egress.
- **No writes possible:** method allowlist is a fixed code constant of read
  methods; the server has no signer regardless. State-changing methods are
  explicitly unreachable.
- **Secret hygiene:** endpoint URLs (which may carry API keys) are never returned
  or logged; errors reference `chain`+`endpoint_kind` only.
- **Resource abuse:** timeout + response-size caps on both tools; `eth_getLogs`
  with a huge range is bounded by the timeout/size cap (documented; not otherwise
  range-limited in v1).
- **Manifest:** `yaml.parse` returns plain data (no anchors-to-code / no exec).
  CID is normalized through the existing strict `Qm`/bytes32 validators, so no
  path traversal into the gateway.

## 11. Risks / open questions
- **`yaml` dependency** — one new runtime dep; acceptable and standard. Flag if
  the team prefers raw-only (would drop the parsed view).
- **Local vs remote default (`auto` prefers local)** — confirm operators want
  local-first; privacy-sensitive setups may want remote disabled by default.
- **Multi-chain mapping is operator toil** — `RPC_ENDPOINTS` must be maintained by
  hand; there's no auto-discovery of which chain a subgraph indexes in v1 (a
  future enhancement could derive it from the manifest's `dataSources[].network`
  — note the synergy with tool #1).
- **IPFS gateway availability** — default points at The Graph's gateway; operators
  with a local IPFS node should set `IPFS_GATEWAY_URL` to it (guaranteed pinned).

## 12. Sequencing
Stage 1 (foundation: config + http util + stubs + wiring + yaml dep) → Stage 2
(Leaf A manifest ∥ Leaf B rpc in worktrees) → Stage 3 (integrate, verify, Codex
audit). Each stage independently reviewable; matches the authz feature workflow.
