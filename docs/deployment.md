# Deployment

`graph-indexer-mcp` ships three supported deployment patterns. Pick the one that matches where the indexer infrastructure lives and how the operator wants Claude to connect.

| Pattern | Transport | Where it runs | Best for |
| --- | --- | --- | --- |
| Local stdio | stdio | Operator's laptop | Single-operator dev / hand-driven sessions via Claude Desktop. |
| Remote HTTP | Streamable HTTP | Service alongside indexer | Shared team access, durable connections. |
| In-cluster | Streamable HTTP (or stdio in a kubectl-exec session) | Pod next to graph-node | Production. Per-caller Kubernetes RBAC authorization. |

In every mode, the configuration model is the same: env vars (validated by Zod at startup) drive everything. See [config-reference.md](config-reference.md).

---

## 1. Local stdio (Claude Desktop)

Operator runs `node dist/index.js` as a subprocess of Claude Desktop.

**Required:**

- Node `>=22` on the host.
- Built artifact at `dist/index.js` (run `npm run build`).
- Network reachability to the configured endpoints (network subgraph gateway, indexer-agent, graphman API, graph-node).

**Optional:**

- `GRAPH_NODE_POSTGRES_URL` for subgraph-size tools — point at a read-only role.

`claude_desktop_config.json` snippet:

```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "node",
      "args": ["/absolute/path/to/graph-indexer-mcp/dist/index.js"],
      "env": {
        "INDEXER_ADDRESS": "0x...",
        "NETWORK_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "EBO_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "QOS_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "GRAPH_NODE_STATUS_URL": "http://localhost:8030/graphql",
        "INDEXER_AGENT_URL": "http://localhost:18000/graphql",
        "GRAPHMAN_API_URL": "http://localhost:8050",
        "GRAPHMAN_AUTH_TOKEN": "replace-me",
        "GRAPH_NODE_POSTGRES_URL": "postgresql://readonly:pw@localhost:5432/graph-node",
        "ACCESS_LEVEL": "read_write"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config. Server logs appear on stderr.

---

## 2. Remote HTTP

Run the server as a long-lived process. Set `MCP_TRANSPORT=http` to start the Streamable HTTP listener (implemented; see [HTTP profile / in-cluster RBAC](#http-profile--in-cluster-rbac) below for the transport details and the `MCP_AUTHZ` axis). The container image and Compose file live in the repo root (`Dockerfile`, `docker-compose.yml`).

**Required:**

- Build or pull the container image.
- Provide all the env vars above via your secret manager / orchestrator.
- Reachability from the MCP container to every configured endpoint.
- TLS termination + an auth shim in front of the HTTP transport (the MCP transport itself does not authenticate).

**Optional:**

- A reverse proxy (nginx, Traefik, Caddy) that handles TLS, authentication, and IP allowlisting.
- A separate Postgres read-only role exposed on a private network.

Connect a remote MCP-aware client by pointing it at the HTTP endpoint. Keep the URL inside an authenticated boundary — the server has no concept of per-request identity beyond the `ACCESS_LEVEL` baked into its environment.

---

## 3. In-cluster (Kubernetes)

The recommended production pattern. Run the MCP as a pod in the same namespace as graph-node. Manifests live under `k8s/`: ConfigMap, Secret, ServiceAccount, and a choice of Deployment — `deployment.yaml` (stdio profile) or `deployment-http.yaml` + `service.yaml` (HTTP profile). For per-caller Kubernetes RBAC authorization see [HTTP profile / in-cluster RBAC](#http-profile--in-cluster-rbac).

> **Note:** the MCP no longer needs to `exec` into graph-node. The graphman
> CLI-fallback path (which used `kubectl exec`) has been removed — the MCP runs
> remote from graph-node and speaks only the graphman GraphQL API on `:8050`.
> The old pods/exec Role + RoleBinding manifests are gone; the ServiceAccount
> remains, used by the HTTP / k8s-rbac authorizer for TokenReview/SAR.

**Required:**

- Image pushed to a registry the cluster can pull from.
- ConfigMap for non-secret env (`INDEXER_ADDRESS`, all `*_URL` values, `ACCESS_LEVEL`, lists, tuning params).
- Secret for `GRAPHMAN_AUTH_TOKEN`, `GRAPH_NODE_POSTGRES_URL` (if used).
- A NetworkPolicy or equivalent allowing egress to the indexer-agent, graphman API, graph-node Status API, Postgres, and the external subgraph gateway.

**Optional:**

- HorizontalPodAutoscaler — not generally useful (per-operator session load is small).
- A separate ingress for the remote-HTTP transport if external access is desired.

---

## HTTP profile / in-cluster RBAC

The stdio profile bakes a single `ACCESS_LEVEL` into the process: every caller
shares it. The HTTP profile instead lets the server authenticate each caller and
delegate the per-call grant decision to Kubernetes RBAC, so different identities
get different permission tiers against one server.

### The two orthogonal axes

Authorization is configured along two independent axes (see
[config-reference.md](config-reference.md)):

| Axis | Env var | Values | Default |
| --- | --- | --- | --- |
| Transport | `MCP_TRANSPORT` | `stdio`, `http` | `stdio` |
| Authorizer | `MCP_AUTHZ` | `static`, `k8s-rbac` | `static` |

They combine freely with one constraint: **`k8s-rbac` requires `http`** —
per-caller identity only exists on the HTTP transport (stdio has no bearer
token), so `MCP_AUTHZ=k8s-rbac` with `MCP_TRANSPORT=stdio` is rejected at
startup. The default `stdio` + `static` is byte-for-byte the legacy behavior.

| `MCP_TRANSPORT` | `MCP_AUTHZ` | Result |
| --- | --- | --- |
| `stdio` | `static` | Default. `kubectl exec` sessions, one `ACCESS_LEVEL`. |
| `http` | `static` | Networked listener, still one `ACCESS_LEVEL` for all callers. Put auth in front. |
| `http` | `k8s-rbac` | Networked listener, per-caller authorization via Kubernetes RBAC. |
| `stdio` | `k8s-rbac` | Rejected at startup (no identity on stdio). |

### Manifests

The HTTP / k8s-rbac profile adds these manifests on top of the base set
(ConfigMap, Secret, ServiceAccount):

| File | Purpose |
| --- | --- |
| `k8s/deployment-http.yaml` | HTTP-profile Deployment (port 8080, `httpGet` probes, `replicas: 2`, RollingUpdate). Apply **instead of** `deployment.yaml`. |
| `k8s/service.yaml` | ClusterIP Service exposing port 8080. |
| `k8s/clusterrolebinding-auth-delegator.yaml` | Binds the SA to `system:auth-delegator` (TokenReview + SubjectAccessReview). |
| `k8s/clusterrole-mcp-roles.yaml` | Synthetic-resource ClusterRoles (`mcp-readonly`, `mcp-operator`, `mcp-admin`) + example bindings. |

Apply:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml -f k8s/secret.yaml
kubectl apply -f k8s/serviceaccount.yaml
# HTTP / k8s-rbac additions:
kubectl apply -f k8s/clusterrolebinding-auth-delegator.yaml
kubectl apply -f k8s/clusterrole-mcp-roles.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/deployment-http.yaml      # NOT deployment.yaml
```

Then bind a subject (user, OIDC group, or ServiceAccount) to one of the tiers —
see the commented `ClusterRoleBinding` example in `k8s/clusterrole-mcp-roles.yaml`.

### The `system:auth-delegator` requirement

The k8s-rbac authorizer makes two apiserver calls per (uncached) request:

1. **TokenReview** — resolve the caller's bearer token to a user + groups.
2. **SubjectAccessReview** — ask "may this subject perform `<permission class>`
   on `tools.mcp.thegraph.io`?".

Both require the pod's ServiceAccount to hold the built-in
`system:auth-delegator` ClusterRole, which
`k8s/clusterrolebinding-auth-delegator.yaml` grants. Without it the calls 403 and
the authorizer **fails closed** — every tool call is denied. The pod's readiness
self-check confirms this access on startup, so a missing binding surfaces as a
pod that never becomes ready.

### Token types

The authorizer accepts any token the cluster can validate via TokenReview:

- **Machine clients** — projected ServiceAccount tokens
  (`serviceAccountToken` projected volume, or `kubectl create token <sa>`). Bind
  the SA to a tier with a `ClusterRoleBinding`.
- **Humans** — OIDC tokens issued by the cluster's configured identity provider.
  Bind the OIDC user or group (`oidc:<group>`) to a tier.

### Audience caveat

Projected SA tokens are **audience-scoped**: a token minted for audience `A` is
rejected by TokenReview unless the review names that audience. If your clients
present audience-scoped tokens, set `K8S_API_AUDIENCE` (env on
`deployment-http.yaml`) to the matching audience. Leave it unset to accept the
apiserver's default audience. A mismatch presents as `authenticated: false` and
the call is denied even though the token is otherwise valid.

### TLS

The HTTP transport does not terminate TLS and the bearer token rides on every
request, so this profile must sit behind TLS (ingress / service mesh / sidecar).
`k8s-rbac` authenticates the caller; TLS protects the token in transit.

---

## Verifying a deployment

After starting the server in any mode:

1. Server prints to stderr: `[mcp] graph-indexer-mcp started (access_level=..., indexer=0x...)`.
2. Connect a client and request the resource `indexer://config` — confirms the configuration was loaded and credentials were stripped from the snapshot.
3. Call `get_network_parameters` — confirms the network subgraph endpoint is reachable.
4. Call `get_infrastructure_overview` — exercises every data source and reports per-source failures under `partialErrors`.
5. Call `graphman_deployment_info` for a known deployment — confirms the graphman GraphQL API on `:8050` is reachable and authenticated.

If any of those fail, see [troubleshooting.md](troubleshooting.md).
