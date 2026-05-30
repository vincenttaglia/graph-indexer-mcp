/**
 * IPFS gateway client for fetching subgraph manifests.
 *
 * A subgraph deployment ID IS its manifest's IPFS CID, so `cat(cid)` resolves
 * `GET {gatewayUrl}/ipfs/{cid}` and returns the raw manifest text. Used by
 * `get_subgraph_manifest` (see plan §6.1).
 */

export interface IpfsClient {
  /**
   * Fetch the content at `cid` from the configured gateway and return it as
   * text. Fail-closed on non-2xx / oversize / timeout. Never includes gateway
   * credentials in thrown errors.
   */
  cat(cid: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

export function createIpfsClient(cfg: {
  gatewayUrl: string;
  maxBytes: number;
  timeoutMs?: number;
}): IpfsClient {
  // TODO(leaf-A): implement per plan §6.1.
  //   - `cat(cid, opts)` → `GET {cfg.gatewayUrl}/ipfs/{cid}` via
  //     `httpGetText(url, { signal: opts?.signal, timeoutMs: cfg.timeoutMs ?? 30_000,
  //     maxBytes: cfg.maxBytes, label: 'ipfs' })`.
  //   - Normalize gatewayUrl trailing slash so the path is exactly
  //     `/ipfs/{cid}` (no double slash, no traversal).
  //   - Fail-closed (httpGetText already throws on non-2xx/oversize/timeout);
  //     do NOT leak the full URL (which may carry credentials) — httpGetText's
  //     `label` keeps errors credential-safe.
  void cfg;
  throw new Error('ipfs client not implemented yet');
}
