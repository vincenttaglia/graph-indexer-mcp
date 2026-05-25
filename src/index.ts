#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { initAccessControl, validateOverrides } from './access-control.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initAccessControl({
    level: config.accessLevel,
    allow: new Set(config.accessOverrides.allow),
    deny: new Set(config.accessOverrides.deny),
  });

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

  // -------------------------------------------------------------------------
  // Stage 1 will register tools, resources, and prompts here by calling
  // registerIndexerTool / registerIndexerResource / registerIndexerPrompt
  // from `src/server/register.ts`. McpServer owns list/call dispatch, so
  // multiple modules can register without clobbering each other.
  // -------------------------------------------------------------------------

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[mcp] graph-indexer-mcp started (access_level=${config.accessLevel}, indexer=${config.indexerAddress})\n`,
  );
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[mcp] fatal: ${detail}\n`);
  process.exit(1);
});
