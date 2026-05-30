/**
 * IPFS gateway client for fetching subgraph manifests.
 *
 * A subgraph deployment ID IS its manifest's IPFS CID, so `cat(cid)` resolves
 * `GET {gatewayUrl}/ipfs/{cid}` and returns the raw manifest text. Used by
 * `get_subgraph_manifest` (see plan §6.1).
 */

import { httpGetText } from '../utils/http.js';

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
  // Normalize the gateway base once: strip any trailing slashes so the join
  // below produces exactly `{base}/ipfs/{cid}` with no double slash and no
  // path traversal regardless of whether the operator's URL ends in `/`.
  const base = cfg.gatewayUrl.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 30_000;

  return {
    async cat(cid, opts) {
      const url = `${base}/ipfs/${cid}`;
      try {
        return await httpGetText(url, {
          signal: opts?.signal,
          timeoutMs,
          maxBytes: cfg.maxBytes,
          // `label: 'ipfs'` keeps thrown errors credential-safe — the raw
          // gateway URL (which may carry an `/api/<key>/...` path) never leaks.
          label: 'ipfs',
        });
      } catch (err) {
        // httpGetText already fails closed on non-2xx / oversize / timeout and
        // scrubs the URL. Re-wrap with the CID (NOT the gateway URL) so the
        // caller can correlate the failure to a deployment without exposing
        // gateway credentials.
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to fetch IPFS content for CID ${cid}: ${detail}`);
      }
    },
  };
}
