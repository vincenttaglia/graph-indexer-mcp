/**
 * Blocks-per-year used to annualize `networkGRTIssuancePerBlock` in APR
 * calculations.
 *
 * Value: 5760 blocks/day × 365 = 2,102,400. Matches the canonical formula
 * in vincenttaglia/indexer-tools-v4
 * (src/services/calculations/apr.ts:calculateApr).
 *
 * IMPORTANT: This is denominated per-ETHEREUM-block regardless of which
 * chain hosts the Graph Network subgraph today. The issuance schedule was
 * set in mainnet days (15-second Ethereum block assumption) and preserved
 * after migration to Arbitrum — so this constant applies for both Ethereum
 * mainnet AND Arbitrum One Network subgraphs. Do NOT substitute Arbitrum's
 * actual block rate (~10.5M blocks/year at 3s, or ~126M at 0.25s). Those
 * values would inflate APR by 5x–60x.
 *
 * If The Graph governance ever changes the issuance schedule's
 * denomination (e.g., via a Horizon upgrade), this constant is the single
 * point of update.
 */
export const BLOCKS_PER_YEAR = 2_102_400;
