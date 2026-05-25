/**
 * Convert between the two Subgraph Deployment ID encodings:
 *   - bytes32 form: `0x<64-hex-chars>`   (Solidity / network subgraph storage)
 *   - IPFS CIDv0 form: `Qm<base58-44>`   (graph-node, IPFS native)
 *
 * Both encode the SAME sha256 hash of the deployment manifest. CIDv0
 * wraps it in a multihash header (algorithm + length) and base58-encodes
 * the resulting 34 bytes.
 *
 * Conversions are pure and total: any valid bytes32 has a valid Qm
 * equivalent and vice versa. The helpers also accept the target form
 * as input (idempotent) so callers don't need to know which they have.
 *
 * Why this exists: the network subgraph stores deployment IDs as bytes32
 * (`0xebdb70ab...`), but graph-node's `indexingStatuses(subgraphs: [...])`
 * query only recognizes the CIDv0 (`Qm...`) form. Passing bytes32 IDs
 * straight through silently returns null for every deployment — which is
 * indistinguishable from "deployment not assigned to this node" and was
 * mis-classifying every active allocation as `health: 'failed'`. The
 * graph-node client now normalizes to the Qm form at its boundary so
 * internal callers can pass either encoding.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const QM_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = BASE58_ALPHABET[Number(n % 58n)]! + s;
    n /= 58n;
  }
  // Preserve leading-zero bytes as base58 "1"s
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
    n = n * 58n + BigInt(idx);
  }
  // Re-attach leading zero bytes (each leading '1' in base58 → one zero byte)
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  const hex = n === 0n ? '' : n.toString(16);
  const padded = hex.padStart(hex.length + (hex.length % 2), '0');
  const bytes = new Uint8Array(leadingZeros + padded.length / 2);
  for (let i = 0; i < padded.length / 2; i++) {
    bytes[leadingZeros + i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Accept either bytes32 or Qm form; return the Qm IPFS CIDv0 form. */
export function toQmDeploymentId(input: string): string {
  if (QM_RE.test(input)) return input;
  if (!BYTES32_RE.test(input)) {
    throw new Error(
      `Invalid deployment ID: ${JSON.stringify(input)} (expected 0x<64-hex> or Qm<base58-44>)`,
    );
  }
  const hex = input.slice(2);
  // Multihash header: 0x12 (sha2-256) + 0x20 (length = 32 bytes) + raw hash
  const full = '1220' + hex;
  const bytes = new Uint8Array(full.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(full.slice(i * 2, i * 2 + 2), 16);
  }
  return base58Encode(bytes);
}

/** Accept either Qm or bytes32 form; return the bytes32 hex form (0x-prefixed). */
export function toBytes32DeploymentId(input: string): string {
  if (BYTES32_RE.test(input)) return input.toLowerCase();
  if (!QM_RE.test(input)) {
    throw new Error(
      `Invalid deployment ID: ${JSON.stringify(input)} (expected 0x<64-hex> or Qm<base58-44>)`,
    );
  }
  const bytes = base58Decode(input);
  // Strip the 2-byte multihash header (0x12, 0x20); the rest is the raw 32-byte hash
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new Error(
      `Qm hash decoded to unexpected shape (expected 0x1220 prefix + 32 bytes, got ${bytes.length} bytes)`,
    );
  }
  let hex = '';
  for (let i = 2; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return '0x' + hex;
}
