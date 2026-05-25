# graph-indexer-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes Graph Protocol indexer operations to Claude (or any MCP client). It wraps the network/EBO/QoS subgraphs, the graph-node Status API, graph-node Postgres, the indexer-agent management API, and graphman (GraphQL + CLI fallback via `kubectl exec`) behind a single tool surface, with access control and three workflow services for allocation optimization, pre-epoch health checks, and discovery/cleanup.

- **Version:** `0.1.0`
- **Node:** `>=22` (ESM, TypeScript strict)
- **MCP SDK:** `@modelcontextprotocol/sdk ^1.29`

## Quickstart

```bash
git clone <repo-url> graph-indexer-mcp
cd graph-indexer-mcp
npm install
npm run build
cp .env.example .env
# edit .env: set INDEXER_ADDRESS, *_URL endpoints, GRAPHMAN_AUTH_TOKEN
npm start
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "node",
      "args": ["/absolute/path/to/graph-indexer-mcp/dist/index.js"],
      "env": {
        "INDEXER_ADDRESS": "0x1234abcd...",
        "NETWORK_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "EBO_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "QOS_SUBGRAPH_URL": "https://gateway.thegraph.com/api/KEY/subgraphs/id/...",
        "GRAPH_NODE_STATUS_URL": "http://localhost:8030/graphql",
        "INDEXER_AGENT_URL": "http://localhost:18000/graphql",
        "GRAPHMAN_API_URL": "http://localhost:8050",
        "GRAPHMAN_AUTH_TOKEN": "...",
        "ACCESS_LEVEL": "read_write"
      }
    }
  }
}
```

## What's included

- **44 MCP tools** across 7 data sources plus 4 composite workflow tools.
  - Network subgraph (6), EBO (3), QoS (3), graph-node status (3), Postgres (2), indexer-agent (9), graphman (14), composite (4).
- **3 MCP resources**: `indexer://config`, `indexer://overview`, `indexer://glossary`.
- **6 MCP prompts** (workflow templates): `optimize_allocations`, `pre_epoch_health_check`, `discover_new_subgraphs`, `investigate_unhealthy`, `recover_failed_deployment`, `cleanup_stale_deployments`.

See [docs/tool-catalog.md](docs/tool-catalog.md) for the full inventory with args and permission classes.

## Configuration

Minimum required env vars:

| Var | Purpose |
| --- | --- |
| `INDEXER_ADDRESS` | Operator's on-chain indexer address (0x-prefixed, 40 hex chars). |
| `NETWORK_SUBGRAPH_URL` | Network subgraph GraphQL endpoint. |
| `EBO_SUBGRAPH_URL` | Epoch Block Oracle subgraph GraphQL endpoint. |
| `QOS_SUBGRAPH_URL` | QoS / gateway-stats subgraph GraphQL endpoint. |
| `GRAPH_NODE_STATUS_URL` | graph-node Status API (`/graphql` on port 8030 by default). |
| `INDEXER_AGENT_URL` | indexer-agent Management API GraphQL endpoint. |
| `GRAPHMAN_API_URL` | graphman GraphQL endpoint (port 8050 by default). |
| `GRAPHMAN_AUTH_TOKEN` | Bearer token for the graphman GraphQL API. |

Optional but recommended:

- `GRAPH_NODE_POSTGRES_URL` — read-only DSN; enables `get_subgraph_size` / `get_all_subgraph_sizes`.
- `GRAPHMAN_KUBECTL_NAMESPACE`, `GRAPHMAN_POD_LABEL`, `GRAPHMAN_CONFIG_PATH` — for the graphman CLI fallback via `kubectl exec`.
- `ACCESS_LEVEL`, `ACCESS_OVERRIDES_ALLOW`, `ACCESS_OVERRIDES_DENY` — access control.

See [docs/config-reference.md](docs/config-reference.md) for every variable, type, default, validator, and example.

## Access control TL;DR

| Level | Permission classes granted |
| --- | --- |
| `read_only` | `read` |
| `read_write` (default) | `read`, `agent_queue`, `graphman_safe` |
| `read_write_destructive` | `read`, `agent_queue`, `graphman_safe`, `graphman_destructive` |
| `full` | all five (adds `agent_approve`) |

Resolution order on every tool call: explicit deny → tool must be registered → explicit allow → level grants the class → otherwise deny.

See [docs/access-control.md](docs/access-control.md) for permission classes, overrides syntax, and worked examples.

## Architecture

- **Clients** (`src/clients/*`) — one per data source, each wraps a typed GraphQL client (or pg / kubectl exec) and exposes typed methods. All client calls accept an `AbortSignal` that is combined with a per-request timeout via `AbortSignal.any`.
- **Tools / resources / prompts** (`src/tools/*`, `src/resources/*`, `src/prompts/*`) — register against `McpServer` via the small wrappers in `src/server/register.ts`, which apply access control and forward the SDK's per-request `extra.signal` to handlers.
- **Services** (`src/services/*`) — `AllocationOptimizer`, `HealthMonitor`, `DiscoveryEngine` implement the §4.1 / §4.2 / §4.3 workflows by orchestrating multiple clients in parallel.
- **Composite tools** wrap each service so the workflows are directly callable from MCP without rerunning all the constituent reads.

All on-chain amounts are passed as `BigInt`-as-string in wei to avoid `Number` precision loss. Inputs are validated with Zod at the tool boundary; misuse is rejected before any I/O.

## Running modes

- **Local stdio (Claude Desktop, Cursor, etc.):** `npm start` launches `dist/index.js` over stdio — the default transport in this build.
- **Remote (Streamable HTTP):** a `Dockerfile` and remote-HTTP entrypoint are produced by the deploy track. Run as a service alongside the indexer infrastructure and authenticate at the transport layer.
- **In-cluster (Kubernetes):** the `k8s/` manifests (deploy track) include a Deployment, Service, and the ServiceAccount + RBAC needed for the graphman CLI fallback (`pods/exec`). Recommended whenever the CLI fallback is in use.

See [docs/deployment.md](docs/deployment.md) for setup of each pattern.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc
npm run dev          # tsc --watch
npm start            # node dist/index.js
```

Test commands are added by the tests track; once landed, `npm test` runs the unit + integration suite.

## Documentation index

- [docs/tool-catalog.md](docs/tool-catalog.md) — every tool, resource, and prompt with args and permission class.
- [docs/config-reference.md](docs/config-reference.md) — every environment variable.
- [docs/access-control.md](docs/access-control.md) — levels, permission classes, overrides, resolution order.
- [docs/deployment.md](docs/deployment.md) — local stdio, remote HTTP, in-cluster patterns.
- [docs/troubleshooting.md](docs/troubleshooting.md) — common failures and fixes.

Design and planning documents:

- [graph-indexer-mcp-design.md](graph-indexer-mcp-design.md) — full design.
- [graph-indexer-mcp-implementation-plan.md](graph-indexer-mcp-implementation-plan.md) — phased plan.

## License

TBD.
