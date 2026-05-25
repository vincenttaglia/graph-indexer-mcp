import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerTool } from '../server/register.js';
import type { Config } from '../config.js';
import type { EboSubgraphClient } from '../clients/ebo-subgraph.js';

export interface EboToolsDeps {
  client: EboSubgraphClient;
  config: Config;
}

/**
 * Register EBO subgraph tools. Three read-only tools as defined in
 * design §5.2:
 *   - get_current_epoch
 *   - get_epoch_blocks
 *   - get_epoch_time_remaining
 */
export function registerEboTools(server: McpServer, deps: EboToolsDeps): void {
  const { client } = deps;

  // -------------------------------------------------------------------------
  // get_current_epoch
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_current_epoch',
    permissionClass: 'read',
    description:
      'Get the current protocol epoch number and the per-chain start blocks within it. ' +
      'Returned block numbers come from the Epoch Block Oracle (EBO) subgraph and are the ' +
      'correct heights at which to compute POIs for the current epoch.',
    handler: async () => {
      const result = await client.getCurrentEpoch();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // get_epoch_blocks
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_epoch_blocks',
    permissionClass: 'read',
    description:
      'Get the start block on a specific chain for a specific epoch. Returns null if the ' +
      "EBO has not recorded a value for that (epoch, chain) pair. Use the deployment's " +
      'chain alias (e.g. `mainnet`, `arbitrum-one`).',
    inputSchema: {
      epoch_number: z.coerce.number().int().nonnegative(),
      chain_name: z.string(),
    },
    handler: async ({ epoch_number, chain_name }) => {
      const result = await client.getEpochBlocks(epoch_number, chain_name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                epoch_number,
                chain_name,
                result,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // get_epoch_time_remaining
  // -------------------------------------------------------------------------
  registerIndexerTool(server, {
    name: 'get_epoch_time_remaining',
    permissionClass: 'read',
    description:
      'Estimate how long until the next epoch flips on `chain_name`. ' +
      'Computes: blocks_remaining = max(0, epoch_length_blocks - ' +
      '(current_block_number - current_epoch_start_block)); hours = ' +
      'blocks_remaining * avg_block_time_seconds / 3600. ' +
      'Note: this tool takes `current_block_number` and `epoch_length_blocks` as inputs ' +
      "because the EBO subgraph does not supply the chain's current head or the " +
      'epoch-length parameter. Stage 3 workflow services will source these from the ' +
      'Network Subgraph (epoch length) and Graph Node Status API / RPC (chain head) ' +
      'and pass them in.',
    inputSchema: {
      current_block_number: z.coerce.number().int().nonnegative(),
      epoch_length_blocks: z.coerce.number().int().positive(),
      avg_block_time_seconds: z.coerce.number().positive().default(12),
      chain_name: z.string().default('mainnet'),
    },
    handler: async ({
      current_block_number,
      epoch_length_blocks,
      avg_block_time_seconds,
      chain_name,
    }) => {
      const current = await client.getCurrentEpoch();
      const match = current.networkBlocks.find((b) => b.network === chain_name);
      if (!match) {
        return {
          content: [
            {
              type: 'text',
              text: `EBO has no current-epoch start block recorded for chain "${chain_name}". ` +
                `Available chains in epoch ${current.epochNumber}: ` +
                `${current.networkBlocks.map((b) => b.network).join(', ') || '(none)'}.`,
            },
          ],
          isError: true,
        };
      }

      const epochStartBlock = Number.parseInt(match.blockNumber, 10);
      if (!Number.isFinite(epochStartBlock)) {
        return {
          content: [
            {
              type: 'text',
              text: `EBO returned non-numeric block number for ${chain_name}: ${match.blockNumber}`,
            },
          ],
          isError: true,
        };
      }

      const blocksIntoEpoch = current_block_number - epochStartBlock;
      const blocksRemaining = Math.max(0, epoch_length_blocks - blocksIntoEpoch);
      const hoursRemaining = (blocksRemaining * avg_block_time_seconds) / 3600;
      const nextEpochBlock = epochStartBlock + epoch_length_blocks;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                chain_name,
                current_epoch: current.epochNumber,
                current_epoch_start_block: epochStartBlock,
                current_block_number,
                epoch_length_blocks,
                avg_block_time_seconds,
                blocks_into_epoch: blocksIntoEpoch,
                blocks_remaining: blocksRemaining,
                hours_remaining: hoursRemaining,
                next_epoch_block: nextEpochBlock,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
