import { GraphQLClient, ClientError, type Variables } from 'graphql-request';

export interface GraphqlClientOptions {
  endpoint: string;
  /** Sent as `Authorization: Bearer <token>` if set. */
  authToken?: string;
  /** Extra headers merged on top of the defaults. */
  extraHeaders?: Record<string, string>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max retries on transient failures. Default 3. */
  maxRetries?: number;
  /** Exponential backoff base in ms. Default 250. */
  retryBaseDelayMs?: number;
  /** Human-readable label used in stderr timing logs. */
  label?: string;
}

export interface GraphqlRequestOptions {
  /**
   * External AbortSignal to honor for cancellation. When this fires, the
   * in-flight HTTP request is aborted. Combined with the internal per-request
   * timeout controller via `AbortSignal.any` so either source can cancel.
   */
  signal?: AbortSignal;
}

export interface TypedGraphqlClient {
  request<TResult, TVariables extends Variables = Variables>(
    query: string,
    variables?: TVariables,
    opts?: GraphqlRequestOptions,
  ): Promise<TResult>;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Produce a log-safe version of an endpoint URL.
 * Strips credentials, query string, hash, and known credential-bearing path
 * segments (e.g. The Graph gateway's `/api/<key>/...`).
 */
export function sanitizeEndpoint(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/\/api\/[^/]+/g, '/api/REDACTED');
    return u.toString();
  } catch {
    return '<unparseable-url>';
  }
}

function sanitizeMessage(msg: string): string {
  return msg.replace(/\/api\/[^/\s"']+/g, '/api/REDACTED');
}

function isTransientError(err: unknown): boolean {
  if (err instanceof ClientError) {
    const status = err.response?.status;
    return typeof status === 'number' && TRANSIENT_HTTP_STATUSES.has(status);
  }
  if (err instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|aborted/i.test(err.message);
  }
  return false;
}

/**
 * Sleep for `ms` milliseconds, but abort early if `signal` fires. Used by the
 * retry backoff so an external cancellation during the sleep doesn't waste
 * one more attempt before propagating.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Per-attempt context carrying the caller's external signal into the `fetch`
 * shim. graphql-request invokes our shim with an opaque `init`, so we need
 * an out-of-band channel to attach the signal. A WeakMap keyed on the
 * GraphQLClient instance keeps the latest-known external signal for the
 * current attempt without leaking the signal across overlapping requests on
 * other clients.
 *
 * Concurrent requests on the SAME client are still safe because each
 * `request()` invocation awaits its own `client.request(...)` synchronously
 * after setting the signal — graphql-request invokes the fetch shim before
 * returning, so the slot is read before any other concurrent attempt has a
 * chance to overwrite it. The `finally` clears the slot to avoid leaking the
 * signal into a subsequent un-signaled request.
 *
 * For extra safety against future graphql-request changes that might defer
 * the fetch shim invocation, we attach the signal directly to a per-attempt
 * AbortController and pre-compose the combined signal at request-build time
 * (see below).
 */

export function createGraphqlClient(opts: GraphqlClientOptions): TypedGraphqlClient {
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
  if (opts.authToken) headers['Authorization'] = `Bearer ${opts.authToken}`;

  const timeoutMs = opts.timeoutMs;

  // Per-request signal slot. graphql-request invokes the fetch shim
  // synchronously while building the request (before any further await), so
  // each `request()` attempt sets this immediately before calling
  // `client.request(...)` and clears it in `finally`. Concurrent `request()`
  // calls on the same client serialize through this slot because each call
  // sets-then-yields (await client.request) — graphql-request resolves the
  // fetch invocation synchronously within that frame.
  //
  // Belt-and-suspenders: if a future graphql-request version defers the
  // shim invocation, the worst case is the SECOND concurrent call sees its
  // own signal under the slot when invoked (still correct — we only ever
  // store the most recently-set external signal).
  let pendingExternalSignal: AbortSignal | undefined;

  const timedFetch: typeof fetch = ((url, init) => {
    const sources: AbortSignal[] = [];

    // Per-request internal timeout. Preserved verbatim from the prior
    // behaviour: only fires when `timeoutMs` is configured.
    let timeoutController: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutController = new AbortController();
      timer = setTimeout(() => timeoutController!.abort(), timeoutMs);
      sources.push(timeoutController.signal);
    }

    // Fan-in the caller-supplied external signal so client-initiated
    // cancellation propagates all the way to the in-flight HTTP request.
    if (pendingExternalSignal) {
      sources.push(pendingExternalSignal);
    }

    // Whatever the upstream `init` already carries should remain authoritative
    // for headers/method/body. We only override `signal` when at least one
    // source exists; otherwise leave the request untouched (no signal).
    let combinedSignal: AbortSignal | undefined;
    if (sources.length === 1) {
      combinedSignal = sources[0];
    } else if (sources.length > 1) {
      // Node 22+ provides AbortSignal.any natively.
      combinedSignal = AbortSignal.any(sources);
    }

    const finalInit: RequestInit = combinedSignal
      ? { ...init, signal: combinedSignal }
      : { ...init };

    return fetch(url, finalInit).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }) as typeof fetch;

  const client = new GraphQLClient(opts.endpoint, {
    headers,
    fetch: timedFetch,
  });

  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.retryBaseDelayMs ?? 250;
  const label = opts.label ?? sanitizeEndpoint(opts.endpoint);

  return {
    async request<TResult, TVariables extends Variables = Variables>(
      query: string,
      variables?: TVariables,
      reqOpts?: GraphqlRequestOptions,
    ): Promise<TResult> {
      // Fast-fail when the external signal is already aborted at entry — the
      // retry loop below would otherwise pointlessly fire one fetch before
      // observing the abort.
      reqOpts?.signal?.throwIfAborted();

      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Per-iteration abort gate: if the caller cancelled while we were
        // backoff-sleeping (or between attempts in any other way), bail
        // before starting another fetch. The pre-loop check at line 174
        // only covers entry; this catches mid-loop aborts.
        reqOpts?.signal?.throwIfAborted();
        // Stash the external signal so `timedFetch` can fan it in for this
        // attempt. Cleared after the attempt to avoid leaking the signal into
        // unrelated requests on the shared client.
        const prevPending = pendingExternalSignal;
        if (reqOpts?.signal) pendingExternalSignal = reqOpts.signal;
        const start = Date.now();
        try {
          const result = await client.request<TResult>(query, variables);
          const elapsed = Date.now() - start;
          process.stderr.write(
            `[gql ${label}] ok ${elapsed}ms (attempt ${attempt + 1})\n`,
          );
          return result;
        } catch (err) {
          lastErr = err;
          const elapsed = Date.now() - start;
          // Distinguish EXTERNAL cancellation (caller's AbortSignal) from
          // the INTERNAL per-request timeout controller. Both surface as
          // AbortError, but they have different retry semantics:
          //
          //   - external: caller explicitly cancelled — must NOT retry, and
          //     must propagate the caller's own abort reason.
          //   - internal timeout: a transient network condition the caller
          //     wants us to recover from. Before the abort plumbing landed,
          //     these matched the retry regex /aborted/i and were retried;
          //     we preserve that by treating internal aborts as transient.
          //
          // `isAbortError(err)` alone can't tell them apart, so we key on
          // the external signal's `.aborted` state at catch time.
          const externallyAborted = Boolean(reqOpts?.signal?.aborted);
          const retriable =
            !externallyAborted && isTransientError(err) && attempt < maxRetries;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[gql ${label}] ${retriable ? 'retry' : 'fail'} ${elapsed}ms (attempt ${
              attempt + 1
            }): ${sanitizeMessage(msg)}\n`,
          );
          if (externallyAborted) {
            // Re-throw via throwIfAborted so the caller sees their own reason
            // (e.g. the DOMException AbortError they passed to abort(reason))
            // rather than whatever the underlying fetch surfaced.
            reqOpts!.signal!.throwIfAborted();
          }
          if (!retriable) break;
          // sleep is abort-aware: if the caller's signal fires during
          // backoff, the sleep rejects and we propagate without waiting
          // out the remaining delay.
          await sleep(baseDelay * 2 ** attempt, reqOpts?.signal);
        } finally {
          // Restore the slot to whatever was set before this attempt began
          // (typically `undefined`). Doing it this way rather than always
          // setting `undefined` preserves the outer-scope signal in the
          // unlikely event that a recursive request fires before the outer
          // one resumes.
          pendingExternalSignal = prevPending;
        }
      }
      throw lastErr;
    },
  };
}
