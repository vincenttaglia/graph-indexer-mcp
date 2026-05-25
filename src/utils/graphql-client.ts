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

export interface TypedGraphqlClient {
  request<TResult, TVariables extends Variables = Variables>(
    query: string,
    variables?: TVariables,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGraphqlClient(opts: GraphqlClientOptions): TypedGraphqlClient {
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
  if (opts.authToken) headers['Authorization'] = `Bearer ${opts.authToken}`;

  const timeoutMs = opts.timeoutMs;
  const timedFetch: typeof fetch | undefined = timeoutMs
    ? ((url, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...init, signal: controller.signal }).finally(() =>
          clearTimeout(timer),
        );
      }) as typeof fetch
    : undefined;

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
    ): Promise<TResult> {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          const retriable = isTransientError(err) && attempt < maxRetries;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[gql ${label}] ${retriable ? 'retry' : 'fail'} ${elapsed}ms (attempt ${
              attempt + 1
            }): ${sanitizeMessage(msg)}\n`,
          );
          if (!retriable) break;
          await sleep(baseDelay * 2 ** attempt);
        }
      }
      throw lastErr;
    },
  };
}
