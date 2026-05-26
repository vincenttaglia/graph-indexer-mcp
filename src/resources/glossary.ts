/**
 * Resource: `indexer://glossary`
 *
 * Static markdown glossary of Graph Protocol and graph-indexer-mcp
 * terminology. Loaded eagerly at module import time — the content is a
 * compile-time string constant, so reads are zero-I/O and never fail.
 *
 * The terminology mirrors what the design doc uses (see `graph-indexer-mcp-
 * design.md` §3 Closability paths and §4 workflows). When the design doc
 * evolves, update both — there is no automated cross-check.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerIndexerResource } from '../server/register.js';

const URI = 'indexer://glossary';

const GLOSSARY_MARKDOWN = `# Graph Protocol Glossary

A reference for terminology used throughout the Graph Indexer MCP server,
grouped by area. When a term appears in tool descriptions, workflows, or
errors, this glossary is the authoritative definition.

---

## Identity & Staking

**Indexer**
An operator that runs Graph Node infrastructure to index subgraphs and serve
GraphQL queries. Identified on-chain by an Ethereum address (\`indexer_address\`).
Indexers earn indexing rewards (newly issued GRT) and query fees.

**GRT**
The Graph Token — the protocol's native ERC-20. All staking, signal,
allocation, rewards, and fees are denominated in GRT. On-chain values are wei
(1 GRT = 1e18 wei) and the MCP preserves BigInt precision by representing them
as decimal strings.

**Staking**
GRT locked by an indexer as collateral for honest behavior. Staked GRT is
required to allocate to subgraph deployments and is subject to slashing if the
indexer submits a disputed Proof of Indexing.

**Delegation**
GRT delegated to an indexer by other GRT holders. Delegated stake adds to the
indexer's allocatable capacity (up to a protocol-wide \`delegationRatio\`
multiplier). Delegators earn a share of the indexer's rewards and fees,
controlled by the indexer's \`indexingRewardCut\` and \`queryFeeCut\` (PPM
values where 1e6 = 100%).

**Token Capacity**
The maximum stake an indexer can allocate — own stake plus delegated stake
capped by the protocol's delegation ratio.

---

## Subgraphs & Deployments

**Subgraph**
A user-facing project that maps on-chain data to a queryable GraphQL schema.
A subgraph can have many versions over its lifetime; each version is a
\`SubgraphDeployment\`.

**Subgraph Deployment**
The immutable, indexable artifact pinned to IPFS and identified by an IPFS
hash (\`Qm...\` or the deployment ID byte form). When an operator says "I'm
syncing this subgraph" they mean the deployment.

**Deployment ID (IPFS hash)**
The unique identifier for a deployment, e.g. \`Qm...\`. Used by graph-node,
graphman, the network subgraph, and the indexer agent to reference a specific
indexable build.

**Signal**
GRT deposited by curators on a specific subgraph deployment to indicate its
worth. \`signalledTokens\` on a deployment is the cumulative curation signal,
and indexing reward distribution across deployments is proportional to
signal.

**Curation**
The activity of depositing signal. Curators earn a fraction of query fees
proportional to their share of signal on a deployment.

**deniedAt**
A block number on a \`SubgraphDeployment\` indicating when (if ever) the
deployment was added to the protocol's reward denylist. \`0\` means rewards
are enabled. A deployment with \`deniedAt != 0\` accrues no indexing rewards
for any indexer — the MCP excludes such deployments from APR computation and
allocation candidacy.

**Off-chain Sync**
Indexing a deployment without an on-chain allocation (an "offchain" indexing
rule managed by the indexer agent). Useful for warming up large subgraphs
before allocating, or for serving queries without competing for indexing
rewards.

---

## Allocations & Epochs

**Allocation**
A staking position attached to a specific subgraph deployment. An allocation
locks a chosen amount of an indexer's stake against one deployment for a
period of time, after which the indexer closes it with a Proof of Indexing
and collects accrued rewards.

**Active / Closed**
An allocation is \`Active\` from open until close, then \`Closed\`. The
network subgraph's \`Allocation.status\` field carries this value.

**Epoch**
A unit of protocol time (~24 hours / ~6,646 Ethereum blocks). Each allocation
records its open epoch and, on closure, its close epoch. Allocations must be
closed at most once per epoch to earn rewards.

**Epoch-Start Block (per chain)**
The first block of the current epoch on a given chain. Closability
classification depends on whether the deployment was healthy at this block
(see "Closable Allocation").

**EBO (Epoch Block Oracle)**
The on-chain oracle that records per-chain epoch-start blocks. Queried via
the EBO subgraph; required because allocations span multiple chains and each
chain advances at a different rate.

**POI (Proof of Indexing)**
A cryptographic digest submitted when an allocation is closed, attesting to
the deterministic state of the deployment at a specific block. An incorrect
POI can be disputed and results in slashed stake.

**Closable Allocation**
An allocation that can be safely closed on-chain with a valid POI without
risking dispute. Two paths qualify:

- **Path A — Healthy Close.** All three: (1) allocation is \`Active\`,
  (2) deployment has indexed past the current epoch-start block, and
  (3) deployment was healthy at that block. The submitted POI is for the
  epoch-start block.
- **Path B — Deterministic Failure Close.** All three: (1) allocation is
  \`Active\`, (2) deployment has \`failed\` health with a deterministic
  \`fatalError\`, and (3) the failure block has been cross-verified against
  other indexers on the same deployment. The submitted POI is for the block
  immediately before the deterministic failure.

Allocations that fit neither path are NOT safely closable and require
operator review.

---

## Rewards & Economics

**Indexing Rewards**
GRT issued per block by the protocol and distributed to indexers in proportion
to (signal share × allocation share) across all deployments. The per-block
issuance is \`networkGRTIssuancePerBlock\` on the network subgraph singleton.

**Query Fees**
GRT collected from gateways for queries served against an indexer's
deployments. Split between indexer, delegators, and curators per the
configured cuts.

**APR (Annual Percentage Rate)**
The projected annualized return on an allocation, derived from issuance,
signal share, and the indexer's slice of the deployment's total stake. The
MCP exposes a \`calculate_deployment_apr\` tool that computes APR using
\`networkGRTIssuancePerBlock × blocksPerYear\` as the issuance basis.

**Gas**
On-chain transaction cost for allocation open/close operations. The
\`gas_estimate_grt\` config supplies a per-lifecycle estimate used by the
optimizer to avoid unprofitable churn. The default (0.3 GRT) covers
single-mode (non-batched) submission on Arbitrum One — observed at
~$0.02/lifecycle (~0.2 GRT at GRT ≈ $0.10) plus 50% headroom. Operators
batching via the indexer-agent action queue see ~0.004 GRT/lifecycle and
should override much lower; Ethereum L1 (rare now) costs ~$70/lifecycle
= ~700 GRT at GRT ≈ $0.10.

**Rewards Cut / Query Fee Cut**
The indexer's retained share of rewards or fees, expressed in PPM
(parts-per-million, 1e6 = 100%). The remainder flows to delegators.

**Reward Share (deployment-level)**
\`(deployment.signalledTokens / network.totalTokensSignalled) × issuance_per_year\`
— the deployment-wide pool an indexer competes for.

**Indexer Share (per-allocation)**
\`new_allocation / (deployment.stakedTokens + new_allocation)\` — the
fraction of the deployment's reward pool a given allocation captures.

**Gateway**
The query-routing layer (e.g., the Edge & Node gateway) that brokers query
traffic from clients to indexers. Gateway routing decisions are heavily
influenced by an indexer's QoS (latency, freshness, error rate).

**Query Share**
The fraction of total query volume across the network that an indexer's
deployments serve.

---

## Health Classification

**healthy / unhealthy / failed**
Graph Node's three-state health classification for a deployment:
- \`healthy\` — indexing without errors.
- \`unhealthy\` — indexing with non-fatal errors recorded, but progressing.
- \`failed\` — indexing halted by a \`fatalError\` (must be recovered with
  graphman, or closed via Path B if deterministic).

**Deterministic Error**
A fatal error that every correct indexer hits at the same block (e.g., a
contract call that reverts identically across all RPC providers). Required
for Path B closure.

**Non-Deterministic Error**
A fatal error caused by indexer-side conditions (RPC timeouts, OOM,
transient network failures). Not eligible for Path B; recovery via graphman
is the expected remediation.

---

## Infrastructure Components

**Graph Node**
The indexer's core service. Reads on-chain data, executes subgraph mappings,
writes entities to Postgres, and serves the GraphQL Status API
(\`graph_node_status_url\`) used by the MCP for health checks.

**Indexer Agent**
A control-plane service that turns indexing rules into on-chain
allocation actions (open / close / reallocate) and manages off-chain sync
rules. The MCP queues actions via the agent's \`queueActions\` GraphQL
mutation; an operator (or the MCP at \`full\` access level) approves and
executes the queue.

**Indexer Service**
The query-serving frontend. Accepts gateway traffic, signs query responses,
and reports QoS metrics. Not directly controlled by the MCP, but its
performance is visible via the QoS subgraph.

**Indexer CLI**
A command-line wrapper around the indexer agent's GraphQL API. Operators use
it for ad-hoc rule management; the MCP talks to the agent directly and does
not shell out to the CLI.

**Graph Node Postgres**
The Postgres database backing graph-node. Each deployment's entity tables
live under a \`sgd<N>\` schema. The MCP queries it read-only (via
\`graph_node_postgres_url\`) for subgraph disk sizes.

**graphman**
The graph-node operator CLI / GraphQL API used for maintenance: pause/resume,
restart, rewind, reassign, drop, chain cache management, and "unused
deployment" reaping. The MCP uses graphman's GraphQL API on port 8050 where
available and falls back to invoking the CLI via \`kubectl exec\` for
operations not yet exposed as GraphQL.

**Network Subgraph**
The protocol's on-chain accounting subgraph. Source of truth for indexer
stake, allocations, deployment signal, and global parameters (epoch length,
issuance). The MCP queries it for nearly every allocation-related decision.

**QoS Subgraph**
A subgraph that aggregates per-deployment quality-of-service metrics (query
volume, latency, error rate) reported by gateways. The MCP queries it to rank
deployment query demand for discovery workflows.

**EBO Subgraph**
A subgraph for the Epoch Block Oracle — exposes per-chain epoch start blocks
and oracle state. Required for cross-chain allocation closability decisions.
`;

export function registerGlossaryResource(server: McpServer): void {
  registerIndexerResource(server, {
    name: 'indexer-glossary',
    uri: URI,
    description:
      'Graph Protocol terminology reference (markdown). Covers staking, ' +
      'subgraphs, allocations, epochs, rewards economics, health states, and ' +
      'infrastructure components (graph-node, indexer-agent, graphman, etc.).',
    mimeType: 'text/markdown',
    handler: (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: GLOSSARY_MARKDOWN,
        },
      ],
    }),
  });
}
