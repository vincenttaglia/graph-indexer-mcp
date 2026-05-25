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

const POD_CACHE_TTL_MS = 60_000;
let cachedPod: { key: string; pod: string; expiresAt: number } | null = null;

function cacheKey(ctx: KubectlContext): string {
  return `${ctx.namespace}::${ctx.podLabel}`;
}

export async function discoverPod(ctx: KubectlContext): Promise<string> {
  const key = cacheKey(ctx);
  const now = Date.now();
  if (cachedPod && cachedPod.key === key && cachedPod.expiresAt > now) {
    return cachedPod.pod;
  }
  const args = [
    'get',
    'pods',
    '-n',
    ctx.namespace,
    '-l',
    ctx.podLabel,
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ];
  process.stderr.write(`[kubectl] discover: kubectl ${args.join(' ')}\n`);
  const result = await execa('kubectl', args, { reject: false });
  const pod = result.stdout.trim();
  if (result.exitCode !== 0 || !pod) {
    throw new Error(
      `Failed to discover graph-node pod in namespace "${ctx.namespace}" with label "${ctx.podLabel}": ${
        result.stderr.trim() || 'no pods returned'
      }`,
    );
  }
  cachedPod = { key, pod, expiresAt: now + POD_CACHE_TTL_MS };
  return pod;
}

export function invalidatePodCache(): void {
  cachedPod = null;
}

/**
 * Run an arbitrary command inside the discovered graph-node pod via `kubectl exec`.
 * Returns stdout/stderr/exit code without throwing on non-zero exit so the caller
 * can produce structured error responses.
 */
export async function execInPod(
  ctx: KubectlContext,
  command: string[],
): Promise<KubectlExecResult> {
  const pod = await discoverPod(ctx);
  const args = ['exec', '-n', ctx.namespace, pod, '--', ...command];
  const start = Date.now();
  process.stderr.write(`[kubectl] exec: kubectl ${args.join(' ')}\n`);
  try {
    const result = await execa('kubectl', args, { reject: false });
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
    process.stderr.write(`[kubectl] error after ${elapsed}ms: ${(err as Error).message}\n`);
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
        exitCode: typeof err.exitCode === 'number' ? err.exitCode : -1,
      };
    }
    return { stdout: '', stderr: (err as Error).message, exitCode: -1 };
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
): Promise<KubectlExecResult> {
  return execInPod(ctx, ['graphman', '--config', configPath, ...graphmanArgs]);
}
