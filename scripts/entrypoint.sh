#!/bin/sh
# =============================================================================
# graph-indexer-mcp entrypoint
#
# Validate required env vars before exec'ing the node process. Failing fast
# with an explicit "missing X, Y, Z" line is much friendlier than letting Zod
# throw a wall of nested validation errors at startup.
#
# Exit codes:
#   0   normal (control transferred to the app via exec)
#   64  missing required env vars (EX_USAGE in sysexits.h)
# =============================================================================
set -eu

REQUIRED="INDEXER_ADDRESS \
NETWORK_SUBGRAPH_URL \
EBO_SUBGRAPH_URL \
QOS_SUBGRAPH_URL \
GRAPH_NODE_STATUS_URL \
INDEXER_AGENT_URL \
GRAPHMAN_API_URL \
GRAPHMAN_AUTH_TOKEN"

MISSING=""
for var in $REQUIRED; do
  # POSIX-portable indirect lookup.
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    MISSING="$MISSING $var"
  fi
done

if [ -n "$MISSING" ]; then
  echo "[entrypoint] missing required env vars:$MISSING" >&2
  echo "[entrypoint] see .env.example for the full list" >&2
  exit 64
fi

# Sanity check: log kubectl client version if present. The graphman CLI
# fallback path needs kubectl available + a kube context that can exec into
# graph-node pods. We don't fail here if kubectl is missing — the GraphQL
# transport may be enough on its own.
if command -v kubectl >/dev/null 2>&1; then
  kver=$(kubectl version --client=true 2>/dev/null | head -1 || true)
  echo "[entrypoint] kubectl: ${kver:-unknown}" >&2
else
  echo "[entrypoint] kubectl not on PATH; graphman CLI fallback disabled" >&2
fi

exec "$@"
