# Plan: Pluggable Authorization (k8s RBAC as an option, env-var setups still default)

Status: proposed
Owner: TBD
Last updated: 2026-05-30

## 1. Goal

Let the server delegate per-tool authorization to **Kubernetes RBAC** when deployed
in-cluster, **without** changing or breaking the existing stdio + `ACCESS_LEVEL`
setup. Auth mode is a runtime choice, not a fork.

### Non-goals
- Replacing the access-level model. It stays as the default authorizer.
- Per-user *backend* credentials (graphman/agent still use one service token).
  Identity is used for **authorization**, not for impersonating backends.
- Building an OAuth issuer. We consume tokens the cluster can already validate.

## 2. Design principles

1. **One chokepoint.** All decisions already flow through `checkAccess()`
   (`src/access-control.ts:78`), invoked once in the handler wrapper
   (`src/server/register.ts:78`). We keep exactly one decision point.
2. **Invariants vs. grants.** Split the resolver into:
   - *Invariants* (fail-closed floor, always enforced): unknown tool → deny;
     deny-list → deny. These stay in the wrapper, so every authorizer inherits them.
   - *Grants* (policy, pluggable): "does this caller get this permission class?"
     Becomes an `Authorizer` strategy.
   - The env `allow`-override moves *into* the static authorizer (it must not
     bypass RBAC in k8s mode). The `deny`-override stays an invariant kill-switch.
3. **Two orthogonal axes.** `MCP_TRANSPORT` (stdio | http) and `MCP_AUTHZ`
   (static | k8s-rbac | …) are independent. Identity only exists on http, so
   `k8s-rbac` requires http; this combo is validated at startup.
4. **Default path unchanged.** `stdio` + `static` behaves byte-for-byte like today;
   no token plumbing, no k8s dependency loaded.

## 3. Target architecture

```
client ──(transport)──► register.ts wrapper
                          │  build RequestContext from extra.authInfo / sessionId
                          ▼
                    checkAccess(tool, ctx)            [src/access-control.ts]
                          │  INVARIANTS (always):
                          │    - tool registered?      no → deny
                          │    - tool on deny-list?    yes → deny
                          ▼  GRANT (pluggable):
                    Authorizer.authorize(ctx, class, tool)
                          ├─ StaticAuthorizer   → allow-list OR level grants class
                          └─ K8sRbacAuthorizer  → TokenReview + SubjectAccessReview (cached)
```

### New interfaces (`src/auth/authorizer.ts`)

```ts
export interface RequestContext {
  identity: { token?: string; user?: string; groups?: string[] } | null; // null on stdio
  sessionId?: string;
}

export interface Authorizer {
  /** Decide GRANTS only. Invariants are enforced by checkAccess(). */
  authorize(ctx: RequestContext, permissionClass: PermissionClass, toolName: string): Promise<boolean>;
  /** Optional startup self-check (e.g. confirm SAR access). */
  init?(): Promise<void>;
}
```

## 4. Work breakdown (phased, each phase independently shippable)

### Phase 1 — Authorizer abstraction (no behavior change)
Refactor `src/access-control.ts`:
- Add `Authorizer` + `RequestContext` (new file `src/auth/authorizer.ts`).
- Add `StaticAuthorizer` implementing today's logic exactly: `allow.has(tool) ||
  LEVEL_CLASSES[level].has(class)`. Keep `LEVEL_CLASSES` where it is or move it
  next to `StaticAuthorizer`.
- Change module state from `activeConfig` to `{ authorizer, hardDeny }`.
- **Backward-compatible init:** keep `initAccessControl(config: AccessControlConfig)`
  — it now constructs a `StaticAuthorizer` from `{level, allow}` and stores
  `deny` as `hardDeny`. Existing callers (`src/index.ts:32`,
  `test/tools/agent-tools.test.ts:250,518`) keep working unchanged.
- Add `initAccessControlWith(authorizer, { deny })` for the pluggable path.
- Make `checkAccess(toolName, ctx?: RequestContext): Promise<AccessCheckResult>`
  **async**. Resolution order unchanged except the grant step delegates to the
  authorizer:
  1. not initialized → throw (as today)
  2. `hardDeny.has(tool)` → deny  *(invariant)*
  3. unregistered class → deny  *(invariant)*
  4. `await authorizer.authorize(ctx ?? {identity:null}, class, tool)` → allow/deny
- `validateOverrides()` stays; it only inspects the deny-list + static allow-list.

**Ripple:** `checkAccess` becomes async →
- `src/server/register.ts:78` → `const check = await checkAccess(def.name, ctx)`
  (wrapper is already `async`).
- `test/access-control.test.ts` (~30 sync `checkAccess(...).allowed` call sites)
  → add `await`, make the `it(...)` callbacks async, pass a null-identity ctx.
  Mechanical; assertions and expected values are unchanged.

Exit criteria: full test suite green with zero semantic changes; `stdio`+`static`
identical to today.

### Phase 2 — Request-context plumbing
In `src/server/register.ts`:
- Build `RequestContext` from the SDK `extra` already in scope:
  ```ts
  const ctx: RequestContext = {
    identity: extra.authInfo ? { token: extra.authInfo.token } : null,
    sessionId: extra.sessionId,
  };
  ```
- Pass `ctx` into `checkAccess`. On stdio, `extra.authInfo` is undefined →
  `identity: null` → `StaticAuthorizer` ignores it.
- (Optional, later) thread the same ctx through resource/prompt registration if we
  want them gated too. Out of scope for v1 (tools are the privileged surface).

### Phase 3 — Config + factory + HTTP transport
`src/config.ts`:
- Add `transport: z.enum(['stdio','http']).default('stdio')` ← `MCP_TRANSPORT`.
- Add `authz: z.enum(['static','k8s-rbac']).default('static')` ← `MCP_AUTHZ`.
- Add `httpPort: z.coerce.number().int().positive().default(8080)` ← `MCP_HTTP_PORT`.
- Add `httpHost`, optional `k8sApiAudience` (token audience for projected SA tokens).
- Cross-field validation: `authz === 'k8s-rbac'` ⇒ `transport === 'http'`, else
  throw a clear error at `loadConfig`.

`src/index.ts`:
- Build the authorizer via a small factory:
  ```ts
  const authorizer = config.authz === 'k8s-rbac'
    ? await (await import('./auth/k8s-rbac.js')).makeK8sRbacAuthorizer(config) // lazy
    : new StaticAuthorizer(config.accessLevel, new Set(config.accessOverrides.allow));
  initAccessControlWith(authorizer, { deny: new Set(config.accessOverrides.deny) });
  await authorizer.init?.();
  ```
- Branch the transport:
  - `stdio` → existing `StdioServerTransport` path (unchanged).
  - `http` → new `src/transport/http.ts`: a Node `http` server hosting
    `StreamableHTTPServerTransport` (SDK 1.29 supports it) on `httpPort`, plus
    plain `GET /healthz` (liveness) and `GET /readyz` (readiness — returns 200 only
    after `server.connect` succeeds and, for k8s mode, after `authorizer.init()`
    confirms SAR access). No new HTTP framework dependency — use the std `http`
    module.
- Keep graceful shutdown; also close the http server on SIGTERM/SIGINT.

### Phase 4 — K8sRbacAuthorizer (`src/auth/k8s-rbac.ts`)
- `authorize(ctx, class)`:
  1. if no `ctx.identity?.token` → return false.
  2. `user = await cachedTokenReview(token)` → POST
     `/apis/authentication.k8s.io/v1/tokenreviews` (optionally with audience).
     On `authenticated:false` → false.
  3. `await cachedSAR(user, verb=class)` → POST
     `/apis/authorization.k8s.io/v1/subjectaccessreviews` with
     `{ user, groups, resourceAttributes: { group: 'mcp.thegraph.io',
        resource: 'tools', verb: <class> } }`. Return `status.allowed`.
- **API access:** call the in-cluster apiserver directly via global `fetch`
  (Node 22) using `KUBERNETES_SERVICE_HOST/PORT`, the mounted SA token at
  `/var/run/secrets/kubernetes.io/serviceaccount/token`, and the cluster CA at
  `…/ca.crt`. Avoids adding `@kubernetes/client-node` (keeps the lean dep list;
  consistent with the existing kubectl-via-execa choice). If preferred, swap in
  `@kubernetes/client-node` — interface is unaffected.
- **Cache:** in-memory `Map` keyed on `token` (TokenReview, ~30s TTL) and on
  `user|verb` (SAR, ~10s TTL). Bounded size + TTL; no `Date.now` concerns here
  (production runtime, not a workflow script).
- `init()`: do a trivial self-SAR to confirm the pod's SA actually has
  `system:auth-delegator`; log a clear error and fail readiness if not.
- **Fail-closed:** any apiserver error → deny (with one stderr warn), never allow.

### Phase 5 — K8s manifests (`k8s/`)
- `clusterrolebinding-auth-delegator.yaml`: bind the existing ServiceAccount to the
  built-in `system:auth-delegator` ClusterRole (grants create on tokenreviews +
  subjectaccessreviews).
- `clusterrole-mcp-roles.yaml` + example bindings: synthetic
  `apiGroups: ['mcp.thegraph.io'], resources: ['tools'], verbs: [<permission
  classes>]` — one ClusterRole per tier (e.g. `mcp-readonly`, `mcp-operator`,
  `mcp-admin`). Operators bind users/groups to these via RoleBindings.
- `service.yaml`: ClusterIP exposing `httpPort` (only for `transport: http`).
- `deployment.yaml` updates (http variant): add `containerPort`, switch
  liveness/readiness probes from `pgrep` to `httpGet /healthz` and `/readyz`,
  allow `replicas > 1` + `RollingUpdate` (safe once stateless-per-request).
- Keep the current stdio manifests as-is for the stdio profile (document both).

### Phase 6 — Tests + docs
- Unit: `StaticAuthorizer` parity test (mirrors existing matrix); `K8sRbacAuthorizer`
  with a faked fetch (authenticated/denied/error → deny; cache hit avoids 2nd call);
  config cross-validation (`k8s-rbac` + `stdio` rejected).
- Update `test/access-control.test.ts` for async (Phase 1 ripple).
- Docs: extend `docs/access-control.md` (authorizer model, invariants vs grants),
  `docs/deployment.md` (http profile, the two axes, manifests), and
  `docs/config-reference.md` (`MCP_TRANSPORT`, `MCP_AUTHZ`, `MCP_HTTP_PORT`,
  audience). Note the RBAC-is-allow-only caveat: deny-list remains the only "deny".

## 5. Backward compatibility
- Default config (`MCP_TRANSPORT=stdio`, `MCP_AUTHZ=static`) ⇒ identical behavior.
- `initAccessControl(config)` signature preserved ⇒ `src/index.ts` + existing tests
  compile and pass with only the async-`await` edits.
- No new runtime dependency unless `MCP_AUTHZ=k8s-rbac` (lazy import).

## 6. Security notes
- Invariants enforced regardless of authorizer: unknown-tool deny + deny-list
  kill-switch. An authorizer can only grant *within* the floor.
- `agent_approve` parity: under k8s, granting on-chain approval = binding a subject
  to a ClusterRole whose verbs include `agent_approve`. Keep that in a separate,
  rarely-bound `mcp-admin` role — mirrors "only `full` grants approve" today.
- HTTP transport is network-reachable: require it to sit behind TLS; `k8s-rbac`
  authenticates callers, but TLS protects the bearer token in transit.

## 7. Risks / open questions
- **Async ripple in tests** — mechanical but ~30 edits; low risk, high churn.
- **Token audience** — projected SA tokens are audience-scoped; we must set the
  right `audiences` in TokenReview or validation fails. Needs an operator-set value.
- **Human identity** — machine clients use projected SA tokens cleanly; human users
  need OIDC tokens from the cluster IdP. Document the supported token types.
- **SAR latency** — mitigated by caching; confirm TTLs acceptable for the workload.
- **MCP client token delivery** — confirm the chosen MCP client can attach a bearer
  token to the StreamableHTTP transport (SDK supports it; client support varies).

## 8. Suggested sequencing
Phase 1 → 2 land first (pure refactor, shippable, zero behavior change). Phase 3
adds the http substrate + flags. Phase 4–5 deliver k8s-rbac. Phase 6 throughout.
Each phase is independently reviewable and reversible.
