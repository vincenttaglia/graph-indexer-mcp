import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeK8sRbacAuthorizerWithDeps,
  type K8sRbacDeps,
} from '../../src/auth/k8s-rbac.js';
import type { Config } from '../../src/config.js';
import type { RequestContext } from '../../src/auth/authorizer.js';

const TOKEN_REVIEW_PATH = '/apis/authentication.k8s.io/v1/tokenreviews';
const SAR_PATH = '/apis/authorization.k8s.io/v1/subjectaccessreviews';

// Minimal Config stub — the authorizer only reads `k8sApiAudience`.
function fakeConfig(overrides: Partial<Config> = {}): Config {
  return { k8sApiAudience: undefined, ...overrides } as Config;
}

interface FakeOptions {
  authenticated?: boolean;
  username?: string;
  groups?: string[];
  sarAllowed?: boolean;
  throwOnPost?: boolean;
}

/** Build fake deps plus a call log so tests can assert cache behavior. */
function makeFakeDeps(opts: FakeOptions) {
  const calls: { path: string; body: unknown }[] = [];
  const deps: K8sRbacDeps = {
    readFile: (path) => {
      if (path.endsWith('/token')) return 'app-sa-token';
      if (path.endsWith('/ca.crt')) return 'fake-ca';
      throw new Error(`unexpected readFile: ${path}`);
    },
    apiServerBase: () => 'https://10.0.0.1:443',
    post: (apiPath, body) => {
      calls.push({ path: apiPath, body });
      if (opts.throwOnPost) return Promise.reject(new Error('boom'));
      if (apiPath === TOKEN_REVIEW_PATH) {
        return Promise.resolve({
          status: 201,
          body: {
            status: {
              authenticated: opts.authenticated ?? true,
              user:
                (opts.authenticated ?? true)
                  ? { username: opts.username ?? 'alice', groups: opts.groups ?? ['g1'] }
                  : undefined,
            },
          },
        });
      }
      if (apiPath === SAR_PATH) {
        return Promise.resolve({
          status: 201,
          body: { status: { allowed: opts.sarAllowed ?? false } },
        });
      }
      throw new Error(`unexpected post: ${apiPath}`);
    },
  };
  return { deps, calls };
}

const withToken: RequestContext = { identity: { token: 'caller-token' } };

describe('k8s-rbac authorizer', () => {
  it('denies when there is no caller token', async () => {
    const { deps, calls } = makeFakeDeps({ sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize({ identity: null }, 'read', 't1'), false);
    assert.equal(await authz.authorize({ identity: {} }, 'read', 't1'), false);
    assert.equal(calls.length, 0, 'no apiserver calls should be made without a token');
  });

  it('allows when authenticated and the SAR is allowed', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: true, sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize(withToken, 'read', 't1'), true);
    assert.deepEqual(
      calls.map((c) => c.path),
      [TOKEN_REVIEW_PATH, SAR_PATH],
    );
  });

  it('denies when authenticated but the SAR is denied', async () => {
    const { deps } = makeFakeDeps({ authenticated: true, sarAllowed: false });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize(withToken, 'agent_queue', 't1'), false);
  });

  it('denies (without an SAR) when the token is not authenticated', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: false });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize(withToken, 'read', 't1'), false);
    assert.deepEqual(
      calls.map((c) => c.path),
      [TOKEN_REVIEW_PATH],
      'should not run an SAR for an unauthenticated token',
    );
  });

  it('fails closed (deny) when the apiserver POST throws', async () => {
    const { deps } = makeFakeDeps({ throwOnPost: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize(withToken, 'read', 't1'), false);
  });

  it('caches: a second identical call within TTL does not re-hit the apiserver', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: true, sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    assert.equal(await authz.authorize(withToken, 'read', 't1'), true);
    assert.equal(calls.length, 2, 'first call: TokenReview + SAR');
    assert.equal(await authz.authorize(withToken, 'read', 't1'), true);
    assert.equal(calls.length, 2, 'second identical call: fully cached, no new posts');
  });

  it('reuses the TokenReview cache across distinct verbs (one TokenReview, two SARs)', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: true, sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    await authz.authorize(withToken, 'read', 't1');
    await authz.authorize(withToken, 'agent_queue', 't2');
    const tokenReviews = calls.filter((c) => c.path === TOKEN_REVIEW_PATH);
    const sars = calls.filter((c) => c.path === SAR_PATH);
    assert.equal(tokenReviews.length, 1, 'token review cached');
    assert.equal(sars.length, 2, 'one SAR per distinct verb');
  });

  it('passes audiences in the TokenReview when k8sApiAudience is set', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: true, sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(
      fakeConfig({ k8sApiAudience: 'mcp.thegraph.io' }),
      deps,
    );
    await authz.authorize(withToken, 'read', 't1');
    const tr = calls.find((c) => c.path === TOKEN_REVIEW_PATH)!;
    assert.deepEqual((tr.body as { spec: { audiences: string[] } }).spec.audiences, [
      'mcp.thegraph.io',
    ]);
  });

  it('sends the correct SAR resourceAttributes (group/resource/verb)', async () => {
    const { deps, calls } = makeFakeDeps({ authenticated: true, sarAllowed: true });
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
    await authz.authorize(withToken, 'graphman_destructive', 't1');
    const sar = calls.find((c) => c.path === SAR_PATH)!;
    const spec = (sar.body as {
      spec: {
        user: string;
        groups?: string[];
        resourceAttributes: { group: string; resource: string; verb: string };
      };
    }).spec;
    assert.equal(spec.user, 'alice');
    assert.deepEqual(spec.groups, ['g1']);
    assert.deepEqual(spec.resourceAttributes, {
      group: 'mcp.thegraph.io',
      resource: 'tools',
      verb: 'graphman_destructive',
    });
  });

  describe('init() self-check', () => {
    it('succeeds when files exist and the SAR create is accepted (2xx)', async () => {
      const { deps } = makeFakeDeps({ authenticated: true, sarAllowed: false });
      const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
      await authz.init!();
    });

    it('throws an actionable error mentioning auth-delegator on 403', async () => {
      const deps: K8sRbacDeps = {
        readFile: () => 'x',
        apiServerBase: () => 'https://10.0.0.1:443',
        post: () => Promise.resolve({ status: 403, body: { message: 'forbidden' } }),
      };
      const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
      await assert.rejects(() => authz.init!(), /system:auth-delegator/);
    });

    it('throws when in-cluster files are missing', async () => {
      const deps: K8sRbacDeps = {
        readFile: () => {
          throw new Error('ENOENT');
        },
        apiServerBase: () => 'https://10.0.0.1:443',
        post: () => Promise.resolve({ status: 201, body: {} }),
      };
      const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
      await assert.rejects(() => authz.init!(), /service-account credentials/);
    });
  });
});
