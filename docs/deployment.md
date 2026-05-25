# Deployment

`graph-indexer-mcp` ships three supported deployment patterns. Pick the one that matches where the indexer infrastructure lives and how the operator wants Claude to connect.

| Pattern | Transport | Where it runs | Best for |
| --- | --- | --- | --- |
| Local stdio | stdio | Operator's laptop | Single-operator dev / hand-driven sessions via Claude Desktop. |
| Remote HTTP | Streamable HTTP | Service alongside indexer | Shared team access, durable connections. |
| In-cluster | Streamable HTTP (or stdio in a kubectl-exec session) | Pod next to graph-node | Production. Best fit for graphman CLI fallback. |

In every mode, the configuration model is the same: env vars (validated by Zod at startup) drive everything. See [config-reference.md](config-reference.md).

---

## 1. Local stdio (Claude Desktop)

Operator runs `node dist/index.js` as a subprocess of Claude Desktop.

**Required:**

- Node `>=22` on the host.
- Built artifact at `dist/index.js` (run `npm run build`).
- Network reachability to the configured endpoints (network subgraph gateway, indexer-agent, graphman API, graph-node).
- If using graphman CLI fallback: `kubectl` on `$PATH` with a kubeconfig context whose default namespace + RBAC allows `pods/exec` on the graph-node pod.

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
        "GRAPHMAN_KUBECTL_NAMESPACE": "graph-protocol",
        "GRAPHMAN_POD_LABEL": "app=graph-node",
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

Run the server as a long-lived process. The remote-HTTP entrypoint, container image, and Compose file are produced by the deploy track (`Dockerfile`, `docker-compose.yml` in the repo root).

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

The recommended production pattern. Run the MCP as a pod in the same namespace as graph-node. The deploy track produces manifests under `k8s/` (Deployment, Service, ConfigMap, Secret, ServiceAccount, Role, RoleBinding).

**Required:**

- Image pushed to a registry the cluster can pull from.
- ConfigMap for non-secret env (`INDEXER_ADDRESS`, all `*_URL` values, `ACCESS_LEVEL`, lists, tuning params).
- Secret for `GRAPHMAN_AUTH_TOKEN`, `GRAPH_NODE_POSTGRES_URL` (if used).
- **ServiceAccount + Role with `pods/exec`** on the graph-node pod for the graphman CLI fallback. Minimum verbs on the `pods` resource: `get`, `list`. On `pods/exec`: `create`. Scope to the graph-node namespace.
- A NetworkPolicy or equivalent allowing egress to the indexer-agent, graphman API, graph-node Status API, Postgres, and the external subgraph gateway.

**Optional:**

- HorizontalPodAutoscaler — not generally useful (per-operator session load is small).
- A separate ingress for the remote-HTTP transport if external access is desired.

The in-cluster pattern avoids shipping kubeconfig: `kubectl` inside the pod automatically uses the mounted ServiceAccount token. Match `GRAPHMAN_KUBECTL_NAMESPACE` to the graph-node namespace and `GRAPHMAN_POD_LABEL` to a selector that uniquely matches the pod (or pods) hosting `graphman`.

### Minimum RBAC sketch

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: graph-protocol
  name: graph-indexer-mcp-graphman
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
```

Bound to the MCP server's ServiceAccount via a RoleBinding in the same namespace.

---

## Verifying a deployment

After starting the server in any mode:

1. Server prints to stderr: `[mcp] graph-indexer-mcp started (access_level=..., indexer=0x...)`.
2. Connect a client and request the resource `indexer://config` — confirms the configuration was loaded and credentials were stripped from the snapshot.
3. Call `get_network_parameters` — confirms the network subgraph endpoint is reachable.
4. Call `get_infrastructure_overview` — exercises every data source and reports per-source failures under `partialErrors`.
5. If graphman CLI fallback is wired: call `graphman_check_blocks` (read-only diagnostic) for any chain.

If any of those fail, see [troubleshooting.md](troubleshooting.md).
