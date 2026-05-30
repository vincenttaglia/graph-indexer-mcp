#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { initAccessControlWith, validateOverrides } from './access-control.js';
import { StaticAuthorizer, type Authorizer } from './auth/authorizer.js';
import { loadConfig } from './config.js';
import { createGraphqlClient } from './utils/graphql-client.js';
import type { KubectlContext } from './utils/kubectl.js';

import { createNetworkSubgraphClient } from './clients/network-subgraph.js';
import { createEboSubgraphClient } from './clients/ebo-subgraph.js';
import { createQosSubgraphClient } from './clients/qos-subgraph.js';
import { createGraphNodeClient } from './clients/graph-node.js';
import { createPostgresClient } from './clients/postgres.js';
import { createIndexerAgentClient } from './clients/indexer-agent.js';
import { createGraphmanClient } from './clients/graphman.js';

import { registerNetworkTools } from './tools/network-tools.js';
import { registerEboTools } from './tools/ebo-tools.js';
import { registerQosTools } from './tools/qos-tools.js';
import { registerGraphNodeTools } from './tools/graphnode-tools.js';
import { registerPostgresTools } from './tools/postgres-tools.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerGraphmanTools } from './tools/graphman-tools.js';
import { registerCompositeTools } from './tools/composite-tools.js';

import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Build the grant strategy. Static is the default level-based model; k8s-rbac
  // is lazily imported so the k8s code path only loads when selected.
  const authorizer: Authorizer =
    config.authz === 'k8s-rbac'
      ? await (await import('./auth/k8s-rbac.js')).makeK8sRbacAuthorizer(config)
      : new StaticAuthorizer(
          config.accessLevel,
          new Set(config.accessOverrides.allow),
        );
  initAccessControlWith(authorizer, {
    deny: new Set(config.accessOverrides.deny),
  });
  await authorizer.init?.();

  const server = new McpServer(
    {
      name: 'graph-indexer-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Instantiate per-data-source clients.
  // ---------------------------------------------------------------------------

  const networkClient = createNetworkSubgraphClient({
    endpoint: config.networkSubgraphUrl,
  });
  const eboClient = createEboSubgraphClient({
    endpoint: config.eboSubgraphUrl,
  });
  const qosClient = createQosSubgraphClient({
    endpoint: config.qosSubgraphUrl,
  });
  const graphNodeClient = createGraphNodeClient({
    endpoint: config.graphNodeStatusUrl,
  });
  const postgresClient = createPostgresClient(config.graphNodePostgresUrl);
  const agentClient = createIndexerAgentClient({
    endpoint: config.indexerAgentUrl,
  });

  // Graphman is dual-mode: GraphQL on :8050 + CLI fallback via kubectl exec.
  const graphmanGql = createGraphqlClient({
    endpoint: config.graphmanApiUrl,
    authToken: config.graphmanAuthToken,
    label: 'graphman',
  });
  const graphmanKubectl: KubectlContext = {
    namespace: config.graphmanKubectlNamespace,
    podLabel: config.graphmanPodLabel,
  };
  const graphmanClient = createGraphmanClient({
    gql: graphmanGql,
    kubectl: graphmanKubectl,
    configPath: config.graphmanConfigPath,
  });

  // ---------------------------------------------------------------------------
  // Register all Stage 1 tools. Each register function adds its tools to the
  // shared McpServer registry; access control is applied per-tool via
  // registerIndexerTool (see src/server/register.ts).
  // ---------------------------------------------------------------------------

  registerNetworkTools(server, { client: networkClient, config });
  registerEboTools(server, { client: eboClient, config });
  registerQosTools(server, { client: qosClient, config });
  registerGraphNodeTools(server, { client: graphNodeClient });
  registerPostgresTools(server, { client: postgresClient });
  registerAgentTools(server, { client: agentClient, networkClient, config });
  registerGraphmanTools(server, { client: graphmanClient });

  // Stage 3: composite tools wrapping the three workflow services.
  registerCompositeTools(server, {
    config,
    networkClient,
    eboClient,
    qosClient,
    graphNodeClient,
    postgresClient,
    agentClient,
    graphmanClient,
  });

  // Stage 2: resources (read-only context) and prompts (workflow templates).
  registerResources(server, {
    config,
    networkClient,
    graphNodeClient,
    postgresClient,
    graphmanClient,
  });
  registerPrompts(server);

  // After all registrations, surface override entries that don't match any
  // registered tool — likely typos in ACCESS_OVERRIDES_ALLOW / _DENY.
  const { unknownAllow, unknownDeny } = validateOverrides();
  for (const name of unknownAllow) {
    process.stderr.write(
      `[mcp] warn: access_overrides.allow references unknown tool "${name}"\n`,
    );
  }
  for (const name of unknownDeny) {
    process.stderr.write(
      `[mcp] warn: access_overrides.deny references unknown tool "${name}"\n`,
    );
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown: close the pg pool so node can exit cleanly.
  // ---------------------------------------------------------------------------

  // Holds the http transport handle (if any) so shutdown can close it.
  let httpHandle: { close(): Promise<void> } | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[mcp] received ${signal}, shutting down\n`);
    try {
      await httpHandle?.close();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp] http close error: ${detail}\n`);
    }
    try {
      await postgresClient?.close();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp] pg close error: ${detail}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.transport === 'http') {
    const { startHttpTransport } = await import('./transport/http.js');
    httpHandle = await startHttpTransport(server, config);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
  process.stderr.write(
    `[mcp] graph-indexer-mcp started (transport=${config.transport}, authz=${config.authz}, access_level=${config.accessLevel}, indexer=${config.indexerAddress})\n`,
  );
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[mcp] fatal: ${detail}\n`);
  process.exit(1);
});
