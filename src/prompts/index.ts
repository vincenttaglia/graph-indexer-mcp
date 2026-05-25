/**
 * MCP prompt registry.
 *
 * Stage 2 ships six workflow templates per design §7. Each prompt module
 * exports a single `register<Name>Prompt(server)` function that wires
 * itself into the McpServer via `registerIndexerPrompt`. This file is the
 * single entry point; the integration step in `src/index.ts` will call
 * `registerPrompts(server)` once, alongside the existing tool and
 * resource registrations.
 *
 * Prompts are purely advisory text — they orchestrate Stage 1 tools but
 * do not themselves invoke any I/O. Every tool name embedded in prompt
 * text is verified against the Stage 1 tool registry; see the commit
 * message and grep output in the worktree for the verification step.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerOptimizeAllocationsPrompt } from './optimize-allocations.js';
import { registerPreEpochHealthCheckPrompt } from './pre-epoch-health-check.js';
import { registerDiscoverNewSubgraphsPrompt } from './discover-new-subgraphs.js';
import { registerInvestigateUnhealthyPrompt } from './investigate-unhealthy.js';
import { registerRecoverFailedDeploymentPrompt } from './recover-failed-deployment.js';
import { registerCleanupStaleDeploymentsPrompt } from './cleanup-stale-deployments.js';

export function registerPrompts(server: McpServer): void {
  registerOptimizeAllocationsPrompt(server);
  registerPreEpochHealthCheckPrompt(server);
  registerDiscoverNewSubgraphsPrompt(server);
  registerInvestigateUnhealthyPrompt(server);
  registerRecoverFailedDeploymentPrompt(server);
  registerCleanupStaleDeploymentsPrompt(server);
}
