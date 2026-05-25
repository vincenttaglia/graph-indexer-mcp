/**
 * Type definitions for the Epoch Block Oracle (EBO) subgraph.
 *
 * The EBO tracks, per supported chain, the block number at the start of each
 * epoch. Indexers use this to compute POIs at the correct block height — POI
 * submission MUST happen as of the first block of the current epoch on the
 * deployment's chain. See design §2.2.
 *
 * Block numbers are modeled as `string` because they are BigInt-scale values
 * in the subgraph schema; downstream services may parse to BigInt/number when
 * arithmetic is required.
 *
 * TODO: verify field names against the live EBO subgraph schema. The shape
 * below tracks the table in design §2.2 but the actual subgraph may expose
 * slightly different identifiers (camelCase vs snake_case, optional fields).
 */

/**
 * An epoch on the protocol (network-wide concept, not chain-specific).
 * Per design §2.2 the entity exposes: `{ id, startBlock, endBlock }`. The
 * `id` IS the epoch number (as a string). `startBlock`/`endBlock` are
 * protocol-chain block numbers (i.e. on the chain that hosts the EBO
 * contract). To get the per-chain epoch-start block needed for POI
 * computation, use `NetworkEpochBlockNumber`.
 */
export interface Epoch {
  /** Epoch number as string — this is the subgraph entity id. */
  id: string;
  /** Block number at which this epoch began on the protocol chain. */
  startBlock: string;
  /** Block number at which this epoch ended (null/empty for the current epoch). */
  endBlock?: string | null;
}

/**
 * Per-chain block number at the start of a given epoch. This is the value an
 * indexer needs to generate the correct POI for a deployment on `network`.
 * Per design §2.2: `{ id, network, epochNumber, blockNumber }`. The exact
 * `id` format is left to the live subgraph (Stage 1 clients should filter
 * by `(network, epochNumber)` rather than reconstructing the id).
 */
export interface NetworkEpochBlockNumber {
  /** Subgraph entity id. Format is subgraph-defined; do not parse. */
  id: string;
  /** Chain alias as known to The Graph (e.g. `mainnet`, `arbitrum-one`). */
  network: string;
  /** Epoch this row pertains to. */
  epochNumber: number;
  /** Block number on `network` at the start of `epochNumber`. */
  blockNumber: string;
}
