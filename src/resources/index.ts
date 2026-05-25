/**
 * Barrel registration for all MCP resources.
 *
 * Stage 2 (Resources + Prompts) registers via `registerResources(server,
 * deps)` so the wiring in `src/index.ts` stays one line. Add new resources
 * by registering them inside this function — keep `src/index.ts` untouched
 * to avoid merge conflicts with the parallel prompts track.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import type { NetworkSubgraphClient } from '../clients/network-subgraph.js';
import type { GraphNodeClient } from '../clients/graph-node.js';
import type { PostgresClient } from '../clients/postgres.js';
import type { GraphmanClient } from '../clients/graphman.js';

import { registerConfigResource } from './config.js';
import { registerOverviewResource } from './overview.js';
import { registerGlossaryResource } from './glossary.js';

export interface ResourcesDeps {
  config: Config;
  networkClient: NetworkSubgraphClient;
  graphNodeClient: GraphNodeClient;
  /** Optional — `null` when `graphNodePostgresUrl` is unset. */
  postgresClient: PostgresClient | null;
  graphmanClient: GraphmanClient;
}

export function registerResources(server: McpServer, deps: ResourcesDeps): void {
  registerConfigResource(server, { config: deps.config });
  registerOverviewResource(server, {
    config: deps.config,
    networkClient: deps.networkClient,
    graphNodeClient: deps.graphNodeClient,
    postgresClient: deps.postgresClient,
    graphmanClient: deps.graphmanClient,
  });
  registerGlossaryResource(server);
}
