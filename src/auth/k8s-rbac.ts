import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Authorizer, RequestContext } from './authorizer.js';
import type { PermissionClass } from '../access-control.js';

/**
 * Kubernetes-RBAC authorizer.
 *
 * It delegates per-tool authorization to the in-cluster apiserver using two
 * subresource APIs, and there are THREE distinct tokens/identities in play —
 * the comments below are deliberate because the distinction is subtle:
 *
 *   1. The CALLER's token (`ctx.identity.token`): the bearer token the MCP
 *      client presented over the http transport. We do NOT trust it directly;
 *      we ask the apiserver to validate it (TokenReview) and tell us who it is.
 *
 *   2. The APP's OWN ServiceAccount token (mounted at
 *      `/var/run/secrets/kubernetes.io/serviceaccount/token`): this is the pod's
 *      identity. We send it as `Authorization: Bearer <app-SA-token>` on the
 *      TokenReview / SubjectAccessReview requests. The app's SA must hold
 *      `system:auth-delegator` (create on tokenreviews + subjectaccessreviews)
 *      for these calls to succeed.
 *
 *   3. The resolved SUBJECT (`status.user.username` / `groups` from the
 *      TokenReview): the identity the caller's token maps to. We feed this into
 *      the SubjectAccessReview to ask "is this subject allowed verb=<class> on
 *      mcp.thegraph.io/tools?".
 *
 * Flow per `authorize()`:
 *   - no caller token                         → deny (fail-closed)
 *   - TokenReview(caller token)               → not authenticated → deny
 *   - SubjectAccessReview(subject, verb=class) → status.allowed
 *
 * Everything is fail-closed: any I/O error, non-2xx, parse error, or missing
 * in-cluster file logs one stderr warning and denies. We NEVER allow on error.
 */

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN_PATH = `${SA_DIR}/token`;
const CA_PATH = `${SA_DIR}/ca.crt`;

const SAR_GROUP = 'mcp.thegraph.io';
const SAR_RESOURCE = 'tools';

const TOKEN_REVIEW_TTL_MS = 30_000;
const SAR_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 1000;

/**
 * Per-request timeout for apiserver calls. On fire we destroy the request and
 * fail closed (deny in `authorize`, throw in `init`). Short on purpose: these
 * are in-cluster control-plane calls on the hot path of every tool invocation.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Hard cap on the buffered response body from the apiserver. A TokenReview /
 * SubjectAccessReview response is a few hundred bytes; 1 MiB is generous while
 * preventing a hostile or compromised endpoint from exhausting memory. Over the
 * cap → destroy the request and fail closed.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Hash a secret (caller token / app-SA token) for safe use as a Map key. We
 * NEVER use a raw token as a key or log it; a SHA-256 hex digest is a stable,
 * non-reversible binding to the exact token bytes.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Result of a TokenReview, cached by a hash of the caller token. */
interface TokenReviewResult {
  authenticated: boolean;
  user?: string;
  groups?: string[];
}

/**
 * A tiny bounded TTL map. Entries expire after `ttlMs`; once `max` entries are
 * present, the oldest insertion is evicted (Map preserves insertion order), so
 * memory stays bounded under a flood of distinct keys. Uses `Date.now()` for
 * expiry — fine for production runtime code.
 */
class TtlMap<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number = MAX_CACHE_ENTRIES,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Refresh insertion order on overwrite so TTL reflects the latest write.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

/** Minimal result of an HTTP POST: status code + parsed JSON body. */
interface PostResult {
  status: number;
  body: unknown;
}

/**
 * Injectable side-effects. Defaults read the real in-cluster files and POST to
 * the apiserver over TLS verified with the cluster CA. Unit tests override
 * these to avoid touching the filesystem or network.
 */
export interface K8sRbacDeps {
  /** Read a file as UTF-8 text. Throws if missing. */
  readFile(path: string): string;
  /**
   * POST `body` (JSON) to `apiPath` on the apiserver. Implementations supply
   * the base URL, the app-SA bearer token, and TLS settings themselves.
   */
  post(apiPath: string, body: unknown): Promise<PostResult>;
  /** Read the apiserver base URL (e.g. `https://10.0.0.1:443`). */
  apiServerBase(): string;
}

function warn(message: string): void {
  process.stderr.write(`[mcp] k8s-rbac: ${message}\n`);
}

function readApiServerBase(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) {
    throw new Error(
      'KUBERNETES_SERVICE_HOST is not set — not running in-cluster? k8s-rbac requires in-cluster service-account credentials.',
    );
  }
  return `https://${host}:${port}`;
}

/**
 * Default POST transport using `node:https`.
 *
 * We use `node:https` rather than global `fetch` specifically because it takes
 * a custom CA cleanly: we pass the mounted cluster CA bundle as the `ca` option
 * so TLS to the apiserver is verified against the cluster's own CA (the
 * apiserver cert is not signed by a public root). Global `fetch` (undici) only
 * accepts a CA via a custom `Dispatcher`/`Agent`, which is clumsier and easy to
 * get wrong; `node:https` is the clean, dependency-free choice here.
 *
 * The app's OWN ServiceAccount token is sent as the Bearer credential.
 */
function makeHttpsPost(deps: {
  readFile: (path: string) => string;
  base: string;
  /** Override the request timeout (ms). Defaults to REQUEST_TIMEOUT_MS. Tests only. */
  timeoutMs?: number;
  /** Override the response body cap (bytes). Defaults to MAX_RESPONSE_BYTES. Tests only. */
  maxResponseBytes?: number;
}): (apiPath: string, body: unknown) => Promise<PostResult> {
  const ca = deps.readFile(CA_PATH);
  const url = new URL(deps.base);
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  return (apiPath, body) =>
    new Promise<PostResult>((resolve, reject) => {
      // Re-read the SA token per request: projected SA tokens are rotated and
      // refreshed on disk by the kubelet, so caching it could go stale.
      let saToken: string;
      try {
        saToken = deps.readFile(TOKEN_PATH).trim();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      // Guard so the timeout and error/oversize paths each settle the promise at
      // most once, and so a late event never double-settles.
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (result: PostResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: apiPath,
          method: 'POST',
          ca,
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${saToken}`,
            'content-length': payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (c: Buffer) => {
            received += c.length;
            if (received > maxResponseBytes) {
              // Hostile/compromised endpoint streaming an oversize body. Stop
              // reading, destroy the request, and fail closed.
              req.destroy();
              fail(
                new Error(
                  `response body exceeded ${maxResponseBytes} bytes (status ${res.statusCode ?? 0})`,
                ),
              );
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = undefined;
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                fail(new Error(`non-JSON response (status ${res.statusCode}): ${text.slice(0, 200)}`));
                return;
              }
            }
            succeed({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      // `timeout` only emits the event; we must destroy the socket ourselves.
      req.on('timeout', () => {
        req.destroy();
        fail(new Error(`request timed out after ${timeoutMs}ms`));
      });
      req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      req.write(payload);
      req.end();
    });
}

/** Build the default deps that talk to the real in-cluster apiserver. */
function defaultDeps(): K8sRbacDeps {
  let cachedBase: string | undefined;
  const readFile = (path: string): string => readFileSync(path, 'utf8');
  const apiServerBase = (): string => {
    if (cachedBase === undefined) cachedBase = readApiServerBase();
    return cachedBase;
  };
  let cachedPost: ((apiPath: string, body: unknown) => Promise<PostResult>) | undefined;
  const post = (apiPath: string, body: unknown): Promise<PostResult> => {
    if (!cachedPost) cachedPost = makeHttpsPost({ readFile, base: apiServerBase() });
    return cachedPost(apiPath, body);
  };
  return { readFile, post, apiServerBase };
}

interface K8sStatusObject {
  status?: {
    authenticated?: boolean;
    allowed?: boolean;
    user?: { username?: string; groups?: string[] };
    error?: string;
  };
  message?: string;
}

/**
 * Core authorizer implementation, parameterized over `deps` so it is unit
 * testable without files or network. The exported `makeK8sRbacAuthorizer`
 * wraps this with the real in-cluster deps.
 */
export function makeK8sRbacAuthorizerWithDeps(
  config: Config,
  deps: K8sRbacDeps,
): Authorizer {
  const audiences = config.k8sApiAudience ? [config.k8sApiAudience] : undefined;
  const tokenReviewCache = new TtlMap<TokenReviewResult>(TOKEN_REVIEW_TTL_MS);
  const sarCache = new TtlMap<boolean>(SAR_TTL_MS);

  /**
   * Validate the caller's token via a TokenReview and resolve it to a subject.
   * Cached by token (~30s). On any error, returns an unauthenticated result so
   * the caller fails closed.
   */
  async function cachedTokenReview(token: string): Promise<TokenReviewResult> {
    // Key by a hash of the token — never use the raw token as a Map key.
    const tokenKey = hashToken(token);
    const cached = tokenReviewCache.get(tokenKey);
    if (cached) return cached;

    let res: PostResult;
    try {
      res = await deps.post('/apis/authentication.k8s.io/v1/tokenreviews', {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token, audiences },
      });
    } catch (err) {
      warn(`TokenReview request failed: ${err instanceof Error ? err.message : String(err)}`);
      return { authenticated: false };
    }

    if (res.status < 200 || res.status >= 300) {
      const obj = res.body as K8sStatusObject | undefined;
      warn(`TokenReview returned HTTP ${res.status}${obj?.message ? `: ${obj.message}` : ''}`);
      return { authenticated: false };
    }

    const obj = res.body as K8sStatusObject | undefined;
    if (obj?.status?.authenticated !== true || !obj.status.user?.username) {
      // Not authenticated (or no resolvable username): deny. Do not cache hard
      // failures aggressively — but a confirmed "not authenticated" is a stable
      // answer for this token, so caching it for the TTL is fine and cheap.
      const result: TokenReviewResult = { authenticated: false };
      tokenReviewCache.set(tokenKey, result);
      return result;
    }

    const result: TokenReviewResult = {
      authenticated: true,
      user: obj.status.user.username,
      groups: obj.status.user.groups ?? [],
    };
    tokenReviewCache.set(tokenKey, result);
    return result;
  }

  /**
   * Ask the apiserver whether `subject` may perform `verb` on
   * `mcp.thegraph.io/tools`. Cached by `sha256(token)|verb` (~10s). Fails closed.
   *
   * The cache key is bound to the CALLER TOKEN, not the resolved username. The
   * SAR authorizes `user + groups`, so two distinct tokens that happen to map to
   * the same username but DIFFERENT groups must not share a cached ALLOW —
   * keying by username alone would let a less-privileged token inherit a more
   * privileged token's cached verb (e.g. `agent_approve`). Binding to the token
   * captures the complete resolved subject with no group/uid canonicalization to
   * get wrong. `tokenKey` is already a SHA-256 hex digest — never the raw token.
   */
  async function cachedSar(
    tokenKey: string,
    user: string,
    groups: string[] | undefined,
    verb: PermissionClass,
  ): Promise<boolean> {
    const key = `${tokenKey}|${verb}`;
    const cached = sarCache.get(key);
    if (cached !== undefined) return cached;

    let res: PostResult;
    try {
      res = await deps.post('/apis/authorization.k8s.io/v1/subjectaccessreviews', {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SubjectAccessReview',
        spec: {
          user,
          groups,
          resourceAttributes: {
            group: SAR_GROUP,
            resource: SAR_RESOURCE,
            verb,
          },
        },
      });
    } catch (err) {
      warn(`SubjectAccessReview request failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    if (res.status < 200 || res.status >= 300) {
      const obj = res.body as K8sStatusObject | undefined;
      warn(`SubjectAccessReview returned HTTP ${res.status}${obj?.message ? `: ${obj.message}` : ''}`);
      return false;
    }

    const obj = res.body as K8sStatusObject | undefined;
    const allowed = obj?.status?.allowed === true;
    sarCache.set(key, allowed);
    return allowed;
  }

  return {
    async authorize(
      ctx: RequestContext,
      permissionClass: PermissionClass,
      _toolName: string,
    ): Promise<boolean> {
      const token = ctx.identity?.token;
      if (!token) return false; // no identity → deny

      const review = await cachedTokenReview(token);
      if (!review.authenticated || !review.user) return false;

      // Bind the SAR cache to the caller token (hashed), not the username, so
      // tokens sharing a username but differing in groups never share a result.
      return cachedSar(hashToken(token), review.user, review.groups, permissionClass);
    },

    /**
     * Startup self-check. Confirms:
     *   - the in-cluster SA token + CA files are present and readable, and
     *   - the app's SA can actually create a TokenReview AND a
     *     SubjectAccessReview (i.e. it holds `system:auth-delegator`, which
     *     grants create on BOTH tokenreviews and subjectaccessreviews).
     *
     * Both subresources are exercised because a misconfigured RBAC setup could
     * grant one without the other; if we only checked the SAR, an SA that lacks
     * TokenReview-create would pass readiness then deny every real call (every
     * `authorize()` begins with a TokenReview). For each we issue a throwaway
     * request and require only that the apiserver ACCEPT the create (HTTP 2xx) —
     * we do NOT require `authenticated`/`allowed` to be true (the synthetic
     * token/subject have no validity/bindings). A 401/403 → fail fast with an
     * actionable message rather than silently denying every request at runtime.
     */
    async init(): Promise<void> {
      // 1. Verify the in-cluster files exist and are readable. This also primes
      //    the base-URL/CA resolution so a misconfiguration surfaces now.
      try {
        deps.readFile(TOKEN_PATH);
        deps.readFile(CA_PATH);
      } catch (err) {
        throw new Error(
          `k8s-rbac self-check failed: cannot read in-cluster service-account credentials under ${SA_DIR} ` +
            `(${err instanceof Error ? err.message : String(err)}). The server must run in-cluster with an ` +
            'automounted ServiceAccount.',
        );
      }
      try {
        deps.apiServerBase();
      } catch (err) {
        throw new Error(
          `k8s-rbac self-check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2. Issue a throwaway TokenReview and require the apiserver to accept the
      //    create (2xx). The synthetic token is invalid, so `authenticated:false`
      //    in the RESULT is expected and fine; what we verify is that the SA may
      //    CREATE tokenreviews at all. Every real `authorize()` starts here.
      let trRes: PostResult;
      try {
        trRes = await deps.post('/apis/authentication.k8s.io/v1/tokenreviews', {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenReview',
          spec: { token: 'mcp-k8s-rbac-self-check-invalid-token', audiences },
        });
      } catch (err) {
        throw new Error(
          `k8s-rbac self-check failed: could not reach the apiserver to create a TokenReview ` +
            `(${err instanceof Error ? err.message : String(err)}). Check network/TLS to the apiserver.`,
        );
      }

      if (trRes.status === 401 || trRes.status === 403) {
        const obj = trRes.body as K8sStatusObject | undefined;
        throw new Error(
          `k8s-rbac self-check failed: the pod's ServiceAccount is not allowed to create ` +
            `TokenReviews (HTTP ${trRes.status}${obj?.message ? `: ${obj.message}` : ''}). ` +
            "Bind the ServiceAccount to the built-in 'system:auth-delegator' ClusterRole " +
            '(it grants create on tokenreviews).',
        );
      }
      if (trRes.status < 200 || trRes.status >= 300) {
        const obj = trRes.body as K8sStatusObject | undefined;
        throw new Error(
          `k8s-rbac self-check failed: unexpected HTTP ${trRes.status} creating a TokenReview` +
            `${obj?.message ? `: ${obj.message}` : ''}.`,
        );
      }

      // 3. Issue a trivial SAR and require the apiserver to accept it (2xx).
      let res: PostResult;
      try {
        res = await deps.post('/apis/authorization.k8s.io/v1/subjectaccessreviews', {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SubjectAccessReview',
          spec: {
            user: 'mcp-k8s-rbac-self-check',
            resourceAttributes: {
              group: SAR_GROUP,
              resource: SAR_RESOURCE,
              verb: 'read',
            },
          },
        });
      } catch (err) {
        throw new Error(
          `k8s-rbac self-check failed: could not reach the apiserver to create a SubjectAccessReview ` +
            `(${err instanceof Error ? err.message : String(err)}). Check network/TLS to the apiserver.`,
        );
      }

      if (res.status === 401 || res.status === 403) {
        const obj = res.body as K8sStatusObject | undefined;
        throw new Error(
          `k8s-rbac self-check failed: the pod's ServiceAccount is not allowed to create ` +
            `SubjectAccessReviews (HTTP ${res.status}${obj?.message ? `: ${obj.message}` : ''}). ` +
            "Bind the ServiceAccount to the built-in 'system:auth-delegator' ClusterRole.",
        );
      }
      if (res.status < 200 || res.status >= 300) {
        const obj = res.body as K8sStatusObject | undefined;
        throw new Error(
          `k8s-rbac self-check failed: unexpected HTTP ${res.status} creating a SubjectAccessReview` +
            `${obj?.message ? `: ${obj.message}` : ''}.`,
        );
      }
    },
  };
}

/**
 * Build the Kubernetes-RBAC authorizer with real in-cluster dependencies.
 *
 * Construction is cheap: it only wires up the deps. Heavy I/O (file reads, the
 * self-SAR) happens in `init()`, and per-request validation in `authorize()`.
 */
export async function makeK8sRbacAuthorizer(config: Config): Promise<Authorizer> {
  return makeK8sRbacAuthorizerWithDeps(config, defaultDeps());
}

// Internal exports for tests.
export const __testing = {
  TtlMap,
  TOKEN_PATH,
  CA_PATH,
  makeHttpsPost,
  hashToken,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
};
