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
 * Safe-integer block number schema. `z.coerce.number().int().nonnegative()`
 * alone will accept values beyond `Number.MAX_SAFE_INTEGER`, which would
 * silently lose precision for very-high block heights. Refining to
 * `Number.isSafeInteger` rejects those up front. If a chain ever produces
 * blocks past 2^53-1, switch to a `bigint` path for arithmetic.
 */
const safeBlockNumber = z.coerce
  .number()
  .int()
  .nonnegative()
  .refine(
    (n) => Number.isSafeInteger(n),
    'block number exceeds Number.MAX_SAFE_INTEGER',
  );

const safeEpochLength = z.coerce
  .number()
  .int()
  .positive()
  .refine(
    (n) => Number.isSafeInteger(n),
    'epoch_length_blocks exceeds Number.MAX_SAFE_INTEGER',
  );

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
    handler: async (_args, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.getCurrentEpoch({ signal: extra.signal });
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
      epoch_number: z.coerce
        .number()
        .int()
        .nonnegative()
        .describe('Protocol epoch number (non-negative integer).'),
      chain_name: z
        .string()
        .describe("Chain alias as used by The Graph (e.g. 'mainnet', 'arbitrum-one')."),
    },
    handler: async ({ epoch_number, chain_name }, extra) => {
      extra.signal.throwIfAborted();
      const result = await client.getEpochBlocks(epoch_number, chain_name, {
        signal: extra.signal,
      });
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
      'max(0, current_block_number - current_epoch_start_block)); hours = ' +
      'blocks_remaining * avg_block_time_seconds / 3600. ' +
      'Note: this tool takes `current_block_number` and `epoch_length_blocks` as inputs ' +
      "because the EBO subgraph does not supply the chain's current head or the " +
      'epoch-length parameter. Stage 3 workflow services will source these from the ' +
      'Network Subgraph (epoch length) and Graph Node Status API / RPC (chain head) ' +
      'and pass them in.',
    inputSchema: {
      current_block_number: safeBlockNumber.describe(
        'Current head block number on `chain_name`. In Stage 3 this is sourced from ' +
          'Graph Node Status API or RPC.',
      ),
      epoch_length_blocks: safeEpochLength.describe(
        'Epoch length in blocks on `chain_name`. In Stage 3 this is sourced from the ' +
          'Network Subgraph.',
      ),
      avg_block_time_seconds: z.coerce
        .number()
        .positive()
        .default(12)
        .describe('Average block time in seconds for `chain_name`. Defaults to 12 (mainnet).'),
      chain_name: z
        .string()
        .default('mainnet')
        .describe("Chain alias as used by The Graph (e.g. 'mainnet', 'arbitrum-one')."),
    },
    handler: async (
      {
        current_block_number,
        epoch_length_blocks,
        avg_block_time_seconds,
        chain_name,
      },
      extra,
    ) => {
      extra.signal.throwIfAborted();
      const current = await client.getCurrentEpoch({ signal: extra.signal });
      const match = current.blockNumbersByNetwork.find(
        (b) => b.network === chain_name,
      );
      if (!match) {
        return {
          content: [
            {
              type: 'text',
              text: `EBO has no current-epoch start block recorded for chain "${chain_name}". ` +
                `Available chains in epoch ${current.epoch}: ` +
                `${current.blockNumbersByNetwork.map((b) => b.network).join(', ') || '(none)'}.`,
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

      // Clamp to handle stale / wrong-chain `current_block_number` inputs:
      // if the caller's head is *behind* the recorded epoch-start block we
      // treat it as "0 blocks into the epoch" rather than reporting more
      // than a full epoch remaining (which would be misleading).
      const blocksIntoEpoch = Math.max(0, current_block_number - epochStartBlock);
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
                current_epoch: current.epoch,
                current_epoch_start_block: epochStartBlock,
                current_block_number,
                epoch_length_blocks,
                avg_block_time_seconds,
                blocks_into_epoch: blocksIntoEpoch,
                blocks_remaining: blocksRemaining,
                hours_remaining: hoursRemaining,
                next_epoch_block: nextEpochBlock,
                // Surface when the caller's head is behind the epoch start so
                // consumers know the result was clamped.
                current_block_behind_epoch_start:
                  current_block_number < epochStartBlock,
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
