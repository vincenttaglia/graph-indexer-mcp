/**
 * Small shared HTTP helpers reused by the IPFS and RPC clients.
 *
 * Both helpers reproduce the timeout + `AbortSignal.any([...])` composition
 * from `createGraphqlClient`'s `timedFetch` (see `graphql-client.ts` ~163–200):
 * an internal per-request timeout controller is fanned in with the caller's
 * external signal so either source can cancel the in-flight fetch.
 *
 * They are deliberately fail-closed:
 *   - non-2xx          → throw
 *   - response timeout → throw (the abort surfaces as an Error)
 *   - oversize body    → abort the stream and throw, having read at most
 *                        `maxBytes` (+ one chunk) so a hostile server can't
 *                        stream unbounded data into memory.
 *
 * SECRET HYGIENE: thrown error messages NEVER include the raw URL (it may carry
 * credentials, e.g. a gateway `/api/<key>/...` path or an RPC key in the query
 * string). Callers pass a safe `label` (e.g. `chain=arbitrum-one local`); when
 * absent we fall back to the URL's origin only — never the full URL.
 */

export interface HttpOptions {
  /** External AbortSignal to honor for cancellation. */
  signal?: AbortSignal;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Hard cap on the response body size in bytes; over-cap fails closed. */
  maxBytes: number;
  /**
   * Safe label used in error messages INSTEAD of the raw URL. When omitted, the
   * URL's origin (scheme + host) is used — never the full URL/path/query.
   */
  label?: string;
}

/** Derive a credential-safe identifier for error messages. */
function safeRef(url: string, label: string | undefined): string {
  if (label) return label;
  try {
    return new URL(url).origin;
  } catch {
    return '<url>';
  }
}

/**
 * A credential-safe descriptor for a thrown `fetch`/runtime error. We must NOT
 * surface `err.message` verbatim: Node's `fetch` puts the full URL into the
 * message for some errors (e.g. a URL with userinfo →
 * "Request cannot be constructed from a URL that includes credentials: <url>"),
 * which would leak a configured endpoint's credentials past the `label` guard.
 * Instead we report only a coarse, URL-free code: the underlying system error
 * code (ECONNREFUSED, ENOTFOUND, …) when present, else the error's class name.
 */
function safeErrDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string' && code) return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return 'unknown error';
}

/**
 * Compose the caller's external signal with an internal timeout controller,
 * mirroring `timedFetch` in `graphql-client.ts`. Returns the combined signal
 * (or `undefined` when neither source exists) plus a `clear()` to cancel the
 * timer once the request settles.
 */
function composeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; clear: () => void; timedOut: () => boolean } {
  const sources: AbortSignal[] = [];

  let timeoutController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) {
    timeoutController = new AbortController();
    timer = setTimeout(() => timeoutController!.abort(), timeoutMs);
    sources.push(timeoutController.signal);
  }
  if (external) sources.push(external);

  let signal: AbortSignal | undefined;
  if (sources.length === 1) signal = sources[0];
  else if (sources.length > 1) signal = AbortSignal.any(sources);

  return {
    signal,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
    timedOut: () => Boolean(timeoutController?.signal.aborted),
  };
}

/**
 * Read a fetch Response body as UTF-8 text, enforcing `maxBytes`. Streams the
 * body and counts bytes so an oversize response is aborted early rather than
 * fully buffered. Throws (fail-closed) on overflow.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  ref: string,
): Promise<string> {
  const body = res.body;
  if (!body) {
    // No stream (e.g. empty body). Fall back to a buffered read, still capped.
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`[${ref}] response body exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`[${ref}] response body exceeds ${maxBytes} bytes`);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

/**
 * GET a URL and return the response body as text, fail-closed on non-2xx,
 * timeout, or oversize. Error messages reference `label`/origin, never the URL.
 */
export async function httpGetText(url: string, opts: HttpOptions): Promise<string> {
  const ref = safeRef(url, opts.label);
  opts.signal?.throwIfAborted();
  const { signal, clear, timedOut } = composeSignal(opts.signal, opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    clear();
    if (opts.signal?.aborted) opts.signal.throwIfAborted();
    if (timedOut()) throw new Error(`[${ref}] request timed out after ${opts.timeoutMs}ms`);
    throw new Error(`[${ref}] request failed (${safeErrDetail(err)})`);
  }
  try {
    if (!res.ok) {
      throw new Error(`[${ref}] HTTP ${res.status} ${res.statusText}`.trimEnd());
    }
    return await readCapped(res, opts.maxBytes, ref);
  } finally {
    clear();
  }
}

/**
 * POST a JSON body and parse the JSON response. Sends
 * `Content-Type: application/json`. Fail-closed on non-2xx, timeout, oversize,
 * or invalid JSON. Error messages reference `label`/origin, never the URL.
 */
export async function httpPostJson(
  url: string,
  body: unknown,
  opts: HttpOptions,
): Promise<unknown> {
  const ref = safeRef(url, opts.label);
  opts.signal?.throwIfAborted();
  const { signal, clear, timedOut } = composeSignal(opts.signal, opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clear();
    if (opts.signal?.aborted) opts.signal.throwIfAborted();
    if (timedOut()) throw new Error(`[${ref}] request timed out after ${opts.timeoutMs}ms`);
    throw new Error(`[${ref}] request failed (${safeErrDetail(err)})`);
  }
  let text: string;
  try {
    if (!res.ok) {
      throw new Error(`[${ref}] HTTP ${res.status} ${res.statusText}`.trimEnd());
    }
    text = await readCapped(res, opts.maxBytes, ref);
  } finally {
    clear();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Don't echo the parser's message: it can embed a snippet of the response
    // body, which may contain endpoint-side secrets.
    throw new Error(`[${ref}] response was not valid JSON`);
  }
}
