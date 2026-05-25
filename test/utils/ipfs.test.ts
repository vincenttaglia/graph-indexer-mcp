/**
 * Tests for `toQmDeploymentId` and `toBytes32DeploymentId`.
 *
 * Anchor pair (verified against a live indexer):
 *   bytes32: 0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c
 *   Qm:      QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu
 *
 * Both forms encode the same sha256 hash; Qm wraps it in a multihash header
 * (0x12 = sha2-256 + 0x20 = 32-byte length) then base58-encodes 34 bytes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBytes32DeploymentId,
  toQmDeploymentId,
} from '../../src/utils/ipfs.js';

const KNOWN_BYTES32 =
  '0xebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c';
const KNOWN_QM = 'QmeDLbKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqCFu';

describe('toQmDeploymentId / toBytes32DeploymentId — known pair', () => {
  it('converts the canonical bytes32 → Qm', () => {
    assert.equal(toQmDeploymentId(KNOWN_BYTES32), KNOWN_QM);
  });

  it('converts the canonical Qm → bytes32', () => {
    assert.equal(toBytes32DeploymentId(KNOWN_QM), KNOWN_BYTES32);
  });
});

describe('round-trip', () => {
  it('bytes32 → Qm → bytes32 returns original (lowercased)', () => {
    const back = toBytes32DeploymentId(toQmDeploymentId(KNOWN_BYTES32));
    assert.equal(back, KNOWN_BYTES32);
  });

  it('Qm → bytes32 → Qm returns original', () => {
    const back = toQmDeploymentId(toBytes32DeploymentId(KNOWN_QM));
    assert.equal(back, KNOWN_QM);
  });

  it('round-trips other random-but-valid bytes32 values', () => {
    const inputs = [
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '0xdeadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef',
    ];
    for (const input of inputs) {
      const back = toBytes32DeploymentId(toQmDeploymentId(input));
      assert.equal(back, input, `round-trip mismatch for ${input}`);
    }
  });
});

describe('idempotence', () => {
  it('toQmDeploymentId is a no-op on a Qm input', () => {
    assert.equal(toQmDeploymentId(KNOWN_QM), KNOWN_QM);
  });

  it('toBytes32DeploymentId is a no-op on a bytes32 input (lowercased)', () => {
    assert.equal(toBytes32DeploymentId(KNOWN_BYTES32), KNOWN_BYTES32);
  });

  it('toBytes32DeploymentId lowercases an uppercase-hex input', () => {
    const upper =
      '0xEBDB70AB2E968FC325EB22FEB042217CD8B8EE325C80A5F5F9AC43A9ABBD459C';
    assert.equal(toBytes32DeploymentId(upper), KNOWN_BYTES32);
  });
});

describe('error cases', () => {
  it('toQmDeploymentId throws on random non-hex string', () => {
    assert.throws(() => toQmDeploymentId('not-a-deployment-id'), /Invalid deployment ID/);
  });

  it('toQmDeploymentId throws on hex with wrong length', () => {
    assert.throws(
      () => toQmDeploymentId('0xebdb70ab'),
      /Invalid deployment ID/,
    );
  });

  it('toQmDeploymentId throws on hex missing 0x prefix', () => {
    assert.throws(
      () =>
        toQmDeploymentId(
          'ebdb70ab2e968fc325eb22feb042217cd8b8ee325c80a5f5f9ac43a9abbd459c',
        ),
      /Invalid deployment ID/,
    );
  });

  it('toBytes32DeploymentId throws on random non-Qm string', () => {
    assert.throws(
      () => toBytes32DeploymentId('not-a-deployment-id'),
      /Invalid deployment ID/,
    );
  });

  it('toBytes32DeploymentId throws on Qm-shaped but invalid base58 chars', () => {
    // Qm + 44 chars, but contains '0', 'O', 'I', 'l' which aren't in base58
    assert.throws(
      () => toBytes32DeploymentId('Qm0OIlKHYypURMRigRxSspUm8w5zrDfXc3Skw2PiDxqC'),
      /Invalid deployment ID/,
    );
  });

  it('toBytes32DeploymentId throws on Qm with wrong length', () => {
    assert.throws(
      () => toBytes32DeploymentId('QmShort'),
      /Invalid deployment ID/,
    );
  });
});
