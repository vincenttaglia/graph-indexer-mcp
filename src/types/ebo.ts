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
 * Verified against the live EBO subgraph schema
 * (4KFYqUWRTZQ9gn7GPHC6YQ2q15chJfVrX43ezYcwkgxB):
 *
 *   type Epoch {
 *     id: ID!
 *     epochNumber: BigInt!
 *     blockNumbers: [NetworkEpochBlockNumber!]! @derivedFrom(field: "epoch")
 *   }
 *
 *   type NetworkEpochBlockNumber {
 *     id: ID!
 *     acceleration: BigInt!
 *     delta: BigInt!
 *     blockNumber: BigInt!         # start block on `network` for this epoch
 *     epochNumber: BigInt!
 *     network: Network!
 *     epoch: Epoch!
 *     previousBlockNumber: NetworkEpochBlockNumber
 *   }
 *
 *   type Network {
 *     id: ID!                       # chainID
 *     alias: String!                # e.g. "arbitrum-one", "mainnet"
 *   }
 *
 * Crucially: the live `Epoch` type does NOT have `startBlock` / `endBlock`
 * fields — those values live ONLY on `NetworkEpochBlockNumber`, per chain.
 */

/**
 * An epoch on the protocol (network-wide concept). The live schema only
 * exposes `epochNumber` directly on this entity; per-chain start blocks live
 * on `NetworkEpochBlockNumber` via the `Epoch.blockNumbers` @derivedFrom
 * relation.
 */
export interface Epoch {
  /** Subgraph entity id. Format is subgraph-defined; do not parse. */
  id: string;
  /** Protocol epoch number. */
  epochNumber: number;
}

/**
 * Per-chain block number at the start of a given epoch. This is the value an
 * indexer needs to generate the correct POI for a deployment on `network`.
 *
 * `network` is the human-readable chain alias (e.g. `mainnet`,
 * `arbitrum-one`) sourced from the linked `Network.alias` field. `chainId`
 * is the EVM chain id (sourced from `Network.id`); kept separately so callers
 * don't have to re-resolve.
 */
export interface NetworkEpochBlockNumber {
  /** Subgraph entity id. Format is subgraph-defined; do not parse. */
  id: string;
  /** Chain alias (e.g. `mainnet`, `arbitrum-one`). */
  network: string;
  /** Chain id (EVM chain id as string). */
  chainId: string;
  /** Epoch this row pertains to. */
  epochNumber: number;
  /** Block number on `network` at the start of `epochNumber` (BigInt as string). */
  blockNumber: string;
  /** Per-epoch acceleration parameter (BigInt as string). */
  acceleration: string;
  /** Per-epoch delta parameter (BigInt as string). */
  delta: string;
}
