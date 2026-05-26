/**
 * Tests for `createGraphqlClient`'s defensive handling of `graphql-request`'s
 * strict response-envelope parser failures.
 *
 * Background: `graphql-request` runs every response through
 * `parseExecutionResult` which validates the `errors`/`data`/`extensions`
 * shapes against the GraphQL spec. If the upstream returns a non-spec body
 * (e.g. the indexer-agent emitting `{ "errors": "some string" }` when its
 * schema validation fails), the parser throws a generic
 *   "Invalid execution result: errors is not plain object OR array"
 * and the parsed body is DISCARDED before the caller can see it. The
 * defensive wrapper detects this error class, re-fetches the body via raw
 * `fetch`, and surfaces the actual response in the thrown error.
 *
 * The fetch spy mirrors the pattern used in test/clients/network-subgraph.test.ts
 * — we intercept `globalThis.fetch` (which `timedFetch` delegates to) so we can
 * control the response body and count requests.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGraphqlClient } from '../../src/utils/graphql-client.js';

interface FetchCall {
  url: string;
  body: unknown;
}

interface FetchResponse {
  status?: number;
  /** If set, used as the response body verbatim. */
  rawBody?: string;
  /** Otherwise, JSON-stringified to the body. */
  jsonBody?: unknown;
  /** Content-type header. Defaults to application/json. */
  contentType?: string;
}

function installFetchSpy(
  responder: (call: FetchCall, callIndex: number) => FetchResponse,
): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    const callIndex = calls.length;
    calls.push({ url, body });
    const spec = responder({ url, body }, callIndex);
    const responseBody =
      spec.rawBody !== undefined ? spec.rawBody : JSON.stringify(spec.jsonBody);
    return new Response(responseBody, {
      status: spec.status ?? 200,
      headers: {
        'content-type': spec.contentType ?? 'application/json',
      },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('createGraphqlClient: default success path', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('returns parsed data when the upstream emits a spec-compliant body', async () => {
    // Sanity check: the happy path must still work after the defensive
    // wrapper is added — no regression on normal responses.
    spy = installFetchSpy(() => ({
      jsonBody: { data: { hello: 'world' } },
    }));

    const client = createGraphqlClient({
      endpoint: 'http://localhost:9999/graphql',
      label: 'success-path',
      maxRetries: 0,
    });

    const result = await client.request<{ hello: string }>('{ hello }');
    assert.deepEqual(result, { hello: 'world' });
    assert.equal(spy.calls.length, 1, 'happy path: exactly one upstream call');
  });
});

describe('createGraphqlClient: parse-error recovery', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('surfaces the raw response body when graphql-request rejects errors-as-string', async () => {
    // Reproduces the indexer-agent failure mode that motivated the wrapper:
    // the agent returns `{ "errors": "Schema validation failed: ..." }`
    // (errors as a string, not an array). graphql-request's
    // parseExecutionResult throws
    //   "Invalid execution result: errors is not plain object OR array"
    // and discards the body. The defensive wrapper must re-fetch the body
    // and embed it in the thrown error so the operator can see WHAT the
    // server actually said.
    spy = installFetchSpy(() => ({
      status: 200,
      jsonBody: {
        errors: 'Schema validation failed: unknown field "frobnicate"',
      },
    }));

    const client = createGraphqlClient({
      endpoint: 'http://localhost:9999/graphql',
      label: 'parse-error-recovery',
      maxRetries: 3, // even with retries configured, parse errors must NOT retry
    });

    await assert.rejects(
      () => client.request('mutation Test { test }', { x: 1 }),
      (err: Error) => {
        // Original parse error must be present so devs grepping for the
        // graphql-request message find it.
        assert.match(
          err.message,
          /errors is not plain object OR array/,
          `expected error to include the original parse-failure message; got: ${err.message}`,
        );
        // The recovered body must be embedded so the operator can see the
        // ACTUAL upstream payload (the whole reason this wrapper exists).
        assert.match(
          err.message,
          /Schema validation failed/,
          `expected error to include the recovered response body; got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('does NOT retry on parse errors (one initial + one recovery = 2 calls total)', async () => {
    // A parse error of this class is a schema mismatch, not a transient blip.
    // The wrapper must mark it non-retriable so the operator gets the answer
    // fast instead of waiting through (default 3 retries × exponential
    // backoff) before surfacing the body. We count the fetches:
    //
    //   - 1 for the original failed parse (via graphql-request → timedFetch
    //     → globalThis.fetch)
    //   - 1 for the recovery fetch (direct globalThis.fetch in the catch)
    //   = 2 total. Anything > 2 means the retry loop kicked in.
    spy = installFetchSpy(() => ({
      status: 200,
      jsonBody: {
        errors: 'Schema validation failed: post-Horizon ActionInput mismatch',
      },
    }));

    const client = createGraphqlClient({
      endpoint: 'http://localhost:9999/graphql',
      label: 'no-retry-parse-error',
      maxRetries: 3,
      retryBaseDelayMs: 1, // keep the test snappy even if retry accidentally kicks in
    });

    await assert.rejects(() => client.request('{ probe }'));

    assert.equal(
      spy.calls.length,
      2,
      `expected exactly 2 fetch calls (1 original + 1 recovery), got ${spy.calls.length}`,
    );
  });
});
