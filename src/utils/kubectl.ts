import { execa, ExecaError } from 'execa';

export interface KubectlContext {
  namespace: string;
  /** Label selector used to discover the graph-node pod, e.g. `app=graph-node`. */
  podLabel: string;
}

export interface KubectlExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KubectlExecOptions {
  /**
   * Per-invocation timeout in milliseconds. On timeout the function resolves
   * with `{ stdout: '', stderr: 'timeout after Xms', exitCode: -1 }` rather
   * than throwing, so callers can surface structured error responses.
   * Defaults to 30s.
   */
  timeoutMs?: number;
  /**
   * External AbortSignal to honor. When this fires, the in-flight kubectl
   * process is killed via execa's native signal support. Combined with the
   * `timeoutMs`-driven internal abort via `AbortSignal.any` so either source
   * can cancel.
   */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POD_CACHE_TTL_MS = 60_000;
let cachedPod: { key: string; pod: string; expiresAt: number } | null = null;

function cacheKey(ctx: KubectlContext): string {
  return `${ctx.namespace}::${ctx.podLabel}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof ExecaError) {
    // execa surfaces timeouts via `timedOut` (and may also set `isCanceled`).
    if ((err as unknown as { timedOut?: boolean }).timedOut) return true;
  }
  if (err instanceof Error) {
    return /timed? ?out/i.test(err.message);
  }
  return false;
}

/**
 * Build the execa options for a single invocation, fanning in the optional
 * external signal alongside the per-call timeout. Returns an object with the
 * fields execa expects (`timeout`, `cancelSignal` when applicable).
 */
function buildExecaOpts(timeoutMs: number, signal: AbortSignal | undefined): {
  reject: false;
  timeout: number;
  cancelSignal?: AbortSignal;
} {
  const out: { reject: false; timeout: number; cancelSignal?: AbortSignal } = {
    reject: false,
    timeout: timeoutMs,
  };
  if (signal) out.cancelSignal = signal;
  return out;
}

/**
 * Discover the first Running graph-node pod matching `ctx.podLabel`.
 *
 * Filters by `status.phase=="Running"` so we never `kubectl exec` into a
 * pod that's `Pending`, `Succeeded`, or `Failed`. We can't easily check
 * the `Ready` condition via jsonpath alone, but Running + the cache TTL
 * is good enough; on the rare case the pod becomes NotReady between
 * discovery and exec, the exec itself will fail with a clear error.
 *
 * Results are cached per (namespace, label) for `POD_CACHE_TTL_MS`.
 */
export async function discoverPod(
  ctx: KubectlContext,
  opts: KubectlExecOptions = {},
): Promise<string> {
  const key = cacheKey(ctx);
  const now = Date.now();
  if (cachedPod && cachedPod.key === key && cachedPod.expiresAt > now) {
    return cachedPod.pod;
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Fast-fail at the boundary so an already-aborted caller doesn't even fork
  // a kubectl subprocess.
  opts.signal?.throwIfAborted();
  const args = [
    'get',
    'pods',
    '-n',
    ctx.namespace,
    '-l',
    ctx.podLabel,
    '-o',
    // Emit a newline per Running pod; we'll pick the first.
    'jsonpath={range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\\n"}{end}',
  ];
  process.stderr.write(`[kubectl] discover: kubectl ${args.join(' ')}\n`);
  let result;
  try {
    result = await execa('kubectl', args, buildExecaOpts(timeoutMs, opts.signal));
  } catch (err) {
    // External cancellation propagates as the caller's abort reason rather
    // than a generic "Failed to discover..." error.
    if (opts.signal?.aborted) {
      opts.signal.throwIfAborted();
    }
    // With reject:false execa normally won't throw, but timeouts still can.
    if (isTimeoutError(err)) {
      throw new Error(
        `Timed out after ${timeoutMs}ms discovering graph-node pod in namespace "${ctx.namespace}" with label "${ctx.podLabel}"`,
      );
    }
    throw new Error(
      `Failed to discover graph-node pod in namespace "${ctx.namespace}" with label "${ctx.podLabel}": ${errorMessage(err)}`,
    );
  }
  const firstPod = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (result.exitCode !== 0 || !firstPod) {
    throw new Error(
      `Failed to discover graph-node pod in namespace "${ctx.namespace}" with label "${ctx.podLabel}": ${
        result.stderr.trim() || 'no Running pods returned'
      }`,
    );
  }
  cachedPod = { key, pod: firstPod, expiresAt: now + POD_CACHE_TTL_MS };
  return firstPod;
}

export function invalidatePodCache(): void {
  cachedPod = null;
}

/**
 * Run an arbitrary command inside the discovered graph-node pod via `kubectl exec`.
 * Returns stdout/stderr/exit code without throwing on non-zero exit so the caller
 * can produce structured error responses. Honors a per-call timeout.
 */
export async function execInPod(
  ctx: KubectlContext,
  command: string[],
  opts: KubectlExecOptions = {},
): Promise<KubectlExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Fast-fail at the boundary so an already-aborted caller doesn't even fork
  // a kubectl subprocess.
  opts.signal?.throwIfAborted();
  let pod: string;
  try {
    const discoverOpts: KubectlExecOptions = { timeoutMs };
    if (opts.signal) discoverOpts.signal = opts.signal;
    pod = await discoverPod(ctx, discoverOpts);
  } catch (err) {
    return { stdout: '', stderr: errorMessage(err), exitCode: -1 };
  }
  const args = ['exec', '-n', ctx.namespace, pod, '--', ...command];
  const start = Date.now();
  process.stderr.write(`[kubectl] exec: kubectl ${args.join(' ')}\n`);
  try {
    const result = await execa('kubectl', args, buildExecaOpts(timeoutMs, opts.signal));
    const elapsed = Date.now() - start;
    process.stderr.write(
      `[kubectl] done ${elapsed}ms exitCode=${result.exitCode ?? -1}\n`,
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = errorMessage(err);
    process.stderr.write(`[kubectl] error after ${elapsed}ms: ${message}\n`);
    // External cancellation: propagate so the caller's abort contract is
    // honored. We do NOT swallow the abort into a structured `{ exitCode: -1 }`
    // because callers (tool handlers) need the throw to surface as their own
    // abort reason via `extra.signal.throwIfAborted()`.
    if (opts.signal?.aborted) {
      opts.signal.throwIfAborted();
    }
    if (isTimeoutError(err)) {
      return { stdout: '', stderr: `timeout after ${timeoutMs}ms`, exitCode: -1 };
    }
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : message,
        exitCode: typeof err.exitCode === 'number' ? err.exitCode : -1,
      };
    }
    return { stdout: '', stderr: message, exitCode: -1 };
  }
}

/**
 * Convenience wrapper for `graphman` CLI invocations inside the graph-node pod.
 * `configPath` is passed via `--config` so callers don't have to repeat it.
 */
export async function execGraphman(
  ctx: KubectlContext,
  configPath: string,
  graphmanArgs: string[],
  opts: KubectlExecOptions = {},
): Promise<KubectlExecResult> {
  return execInPod(ctx, ['graphman', '--config', configPath, ...graphmanArgs], opts);
}
