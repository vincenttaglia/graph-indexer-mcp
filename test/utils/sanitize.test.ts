/**
 * Tests for `sanitizeEndpoint` (exported from src/utils/graphql-client.ts) and
 * the `sanitizeError` helper used in src/resources/overview.ts.
 *
 * `sanitizeError` is not exported by the source; we re-implement the IDENTICAL
 * logic here so the test continues to verify the contract. Update both when the
 * source helper changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEndpoint } from '../../src/utils/graphql-client.js';

// Mirror of src/resources/overview.ts:sanitizeError — keep in sync.
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/https?:\/\/[^\s"')]+/gi, (match) => sanitizeEndpoint(match));
}

describe('sanitizeEndpoint', () => {
  it('strips username/password from a URL', () => {
    const out = sanitizeEndpoint('https://user:pass@host.example/path');
    assert.equal(out, 'https://host.example/path');
  });

  it('strips ?query and #hash', () => {
    const out = sanitizeEndpoint('https://host.example/path?token=abc#frag');
    assert.equal(out, 'https://host.example/path');
  });

  it('redacts /api/<key>/... path segment', () => {
    const out = sanitizeEndpoint(
      'https://gateway.thegraph.com/api/SECRETKEY123/subgraphs/id/foo',
    );
    assert.equal(out, 'https://gateway.thegraph.com/api/REDACTED/subgraphs/id/foo');
  });

  it('handles credentials + query + hash + /api/<key>/ all at once', () => {
    const out = sanitizeEndpoint(
      'https://user:pass@gateway.thegraph.com/api/SECRET/subgraphs/id/foo?token=x#frag',
    );
    assert.equal(out, 'https://gateway.thegraph.com/api/REDACTED/subgraphs/id/foo');
  });

  it('returns <unparseable-url> for non-URL input', () => {
    assert.equal(sanitizeEndpoint('not a url'), '<unparseable-url>');
  });

  it('preserves a plain endpoint untouched', () => {
    const out = sanitizeEndpoint('http://localhost:8030/graphql');
    assert.equal(out, 'http://localhost:8030/graphql');
  });

  it('handles multiple /api/<key>/ segments', () => {
    const out = sanitizeEndpoint(
      'https://host.example/api/AAA/foo/api/BBB/bar',
    );
    // Both occurrences should be redacted.
    assert.equal(out, 'https://host.example/api/REDACTED/foo/api/REDACTED/bar');
  });
});

describe('sanitizeError', () => {
  it('sanitizes a single URL embedded in an Error message', () => {
    const err = new Error(
      'fetch failed for https://user:pass@host/path?x=y',
    );
    const out = sanitizeError(err);
    assert.ok(!out.includes('user:pass'));
    assert.ok(!out.includes('?x=y'));
    assert.ok(out.includes('https://host/path'));
  });

  it('leaves non-URL messages unchanged', () => {
    assert.equal(sanitizeError('connection refused'), 'connection refused');
  });

  it('sanitizes multiple URLs in one error', () => {
    const err = new Error(
      'tried https://user:pw@a.example/api/SECRET/foo and https://user:pw@b.example/api/X/bar',
    );
    const out = sanitizeError(err);
    assert.ok(!out.includes('user:pw'));
    assert.ok(out.includes('https://a.example/api/REDACTED/foo'));
    assert.ok(out.includes('https://b.example/api/REDACTED/bar'));
  });

  it('handles non-Error values via String(...)', () => {
    assert.equal(sanitizeError(42), '42');
    assert.equal(sanitizeError(null), 'null');
  });
});
