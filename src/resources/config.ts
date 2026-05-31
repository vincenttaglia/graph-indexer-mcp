/**
 * Resource: `indexer://config`
 *
 * Exposes a sanitized snapshot of the running MCP server's configuration so
 * Claude can see what indexer it is connected to, which endpoints it talks to,
 * and the optimization thresholds / list overrides currently in effect.
 *
 * Sensitive material is scrubbed before serialization:
 *   - `graphmanAuthToken` is replaced with `"REDACTED"` if set.
 *   - `graphNodePostgresUrl` (when set) is sanitized via `sanitizeEndpoint` so
 *     username and password components in the libpq URI never leave the
 *     process. The same helper is applied to every other URL field for
 *     consistency: subgraph endpoints often carry a gateway API key encoded
 *     in the path (`/api/<key>/...`) which `sanitizeEndpoint` rewrites to
 *     `/api/REDACTED`.
 *
 * Stage 4 may add cache headers; for now every read produces a fresh snapshot.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerResource } from '../server/register.js';
import type { Config } from '../config.js';
import { sanitizeEndpoint } from '../utils/graphql-client.js';

export interface ConfigResourceDeps {
  config: Config;
}

const URI = 'indexer://config';

/**
 * Produce a shallow, JSON-serializable view of `Config` with secrets removed
 * and URLs sanitized. Returning a plain object (rather than a Config) makes
 * the redaction step visible at the type level — any caller that wants the
 * real, secret-bearing config has to ask for it explicitly.
 */
export function buildSanitizedConfig(config: Config): Record<string, unknown> {
  const postgresSanitized = config.graphNodePostgresUrl
    ? sanitizeEndpoint(config.graphNodePostgresUrl)
    : null;

  return {
    indexerAddress: config.indexerAddress,
    protocolNetwork: config.protocolNetwork,

    endpoints: {
      networkSubgraphUrl: sanitizeEndpoint(config.networkSubgraphUrl),
      eboSubgraphUrl: sanitizeEndpoint(config.eboSubgraphUrl),
      qosSubgraphUrl: sanitizeEndpoint(config.qosSubgraphUrl),
      graphNodeStatusUrl: sanitizeEndpoint(config.graphNodeStatusUrl),
      indexerAgentUrl: sanitizeEndpoint(config.indexerAgentUrl),
      graphmanApiUrl: sanitizeEndpoint(config.graphmanApiUrl),
      graphNodePostgresUrl: postgresSanitized,
    },

    graphman: {
      // Never expose the actual token. `"REDACTED"` lets callers know one is
      // configured without leaking it; `null` would imply unconfigured.
      authToken: config.graphmanAuthToken ? 'REDACTED' : null,
    },

    accessControl: {
      level: config.accessLevel,
      overrides: {
        allow: [...config.accessOverrides.allow],
        deny: [...config.accessOverrides.deny],
      },
    },

    optimization: {
      maxAllocations: config.maxAllocations,
      maxAllocationPct: config.maxAllocationPct,
      riskyDeploymentCapPct: config.riskyDeploymentCapPct,
      minSignal: config.minSignal,
      gasEstimateGrt: config.gasEstimateGrt,
      minRewards28dGrt: config.minRewards28dGrt,
    },

    lists: {
      whitelist: [...config.whitelist],
      blacklist: [...config.blacklist],
      frozenlist: [...config.frozenlist],
      riskyDeployments: [...config.riskyDeployments],
    },
  };
}

export function registerConfigResource(
  server: McpServer,
  deps: ConfigResourceDeps,
): void {
  registerIndexerResource(server, {
    name: 'indexer-config',
    uri: URI,
    description:
      'Sanitized snapshot of the MCP server configuration: indexer address, ' +
      'endpoints (credentials stripped), access level, optimization thresholds, ' +
      'and list overrides. Secrets (graphmanAuthToken, Postgres credentials) ' +
      'are never included.',
    mimeType: 'application/json',
    handler: (uri) => {
      const payload = buildSanitizedConfig(deps.config);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  });
}
