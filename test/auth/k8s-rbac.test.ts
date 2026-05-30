import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  makeK8sRbacAuthorizerWithDeps,
  __testing,
  type K8sRbacDeps,
} from '../../src/auth/k8s-rbac.js';
import type { Config } from '../../src/config.js';
import type { RequestContext } from '../../src/auth/authorizer.js';

// Self-signed localhost cert/key (RSA, CN=localhost, SAN includes 127.0.0.1).
// Generated solely for exercising the real node:https transport in-process —
// it is NOT a secret and authenticates nothing.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCGxmC8ltn9U0ir
0LC/zTT1YYnToaXT1NBWWwDd7QsuJS9Vg3H8yht/85JgPMQnireCXRLcgzjASNbx
O5q/mV1qgdZQ2ebz/eGNENCd9Zc0pRmqeXNoCzY5deFS2CfCmjWlwZrPjUkdH3ws
CwUQYiYlTFsPI0Bxa79Oe1HcjeDAAI+wJtOMDDHarXckQczuqI8FtizHES0PEcbt
UyysFTOQkXR5kgef54EOVySVND9g4jk4WONJYv/Ppx5gtEKGH5rCPTwycBIQ4/dP
soAZmp28Xudkcno3xZNcKS2ojx3pJPsY8u74EsoGwL5SsPs2HJ5DeS/Xb0cwylFq
+0hkQ3vHAgMBAAECggEADs0VLUuZKmujEiYbwx9ThD9Eq6vs/Ok6QsGWbsjsRBJs
CFrPLJE67pUJVkMA0nbhgGedp/9L6ZIWSO01fs/mT8ltMqPmQUAjLSLTm7AE/bsZ
U9IoDR0YxLwKwCu3nMo4FLlrua+CgA2dIsPIYpbk1DkhJvXFdgSnQISP5kY5OzIB
HdvKP0RcPOWlF/32B8Eq8xHJIR4FGLXm0SABCYuVAEBCnI4i1oQwMOP21wVrYuCz
ynevQtx4z8fkE+ZcpJxohDBGn5zBqo4tKuFGOj/t+AsIcv+8N4K1RTlM3tNIXl1Y
Hj1P6kppmmaJtwjGWlEOd/MN401NL0Hbf5SvA5mlQQKBgQC799yWGEYmOf/z2roe
hWvZIBVevn2Z8qopPFU+QYCm81muzad58h36A/mntx8mnByXWpVyvA8Q8wFHNko4
/NGRrpnoXMSJF6aOEWEp4fSxBZzBnL62HRjnpxMSRJsQ8E8byZ6Be7OcmH0QLFLd
2SUOI08CqwxOtR36csGxTmIqmwKBgQC3jehBnJvOsHNk1GBjj5XF9zJYUPorxQlB
0P+Py7tlBS0MEZGbE7DRUSpHRBWUiYj5xjY9z8edPAq364lpzFOLSNIVVR99tf8z
C+m4pCCO0DzFYz/jJZ7XoBScGOvsGGgvVKNQSUJ9N9DD9PUE4HM4KfmYaYvVaooY
gdiDiUoARQKBgBclUE5TMuAmKDRY7K4xc7RK1RbTkhfQ388wFLcTzcnBEXwK6uKD
Q9mzf5x9WiKg+oxQpTJ5oclOgwvHzZ/y0cOEooMQWUsgVGwOC87iegUKUeEtcfZu
4tAzrI+FTyrozHT5gMElAFr6E/xX2ORkhsGU63fCpENU3hom41737fKdAoGAPkoJ
5zoeJaX7gtwPWboAOY4Jp67TNsdGvO8Pytx4W2/GObI8l0O3XVEN5+FS8XU65og9
H/zC4Ljfakqj9yM/tqSfpl2csixwzgHc7qvD4LMJ7HIh3BOIM+Q/Gjna1ePydx1h
zn0N8zBdyCH4hA8nCog0C2TF70aYVni54OlWE4ECgYAv1Gj3iQkqGw1AXKhYamlu
zh+NRzI0kW6C/aqyyY4dhPpMj6y0CZRUhI/hm7bPo9upoMDbKrqYiJQbvj9GxrTx
uBUubMrTV7G/Au8G34tEDLgybKouOjVMY/K1eFRBmHkB21C5TlBi6CaYNbB0cY0O
IrVChJOB9kuQsZCu0V381A==
-----END PRIVATE KEY-----
`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUPrAKs+gG90J0BjeSwv8r+b+VITQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDUzMDIwMjQwNVoYDzIxMjYw
NTA2MjAyNDA1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCGxmC8ltn9U0ir0LC/zTT1YYnToaXT1NBWWwDd7Qsu
JS9Vg3H8yht/85JgPMQnireCXRLcgzjASNbxO5q/mV1qgdZQ2ebz/eGNENCd9Zc0
pRmqeXNoCzY5deFS2CfCmjWlwZrPjUkdH3wsCwUQYiYlTFsPI0Bxa79Oe1HcjeDA
AI+wJtOMDDHarXckQczuqI8FtizHES0PEcbtUyysFTOQkXR5kgef54EOVySVND9g
4jk4WONJYv/Ppx5gtEKGH5rCPTwycBIQ4/dPsoAZmp28Xudkcno3xZNcKS2ojx3p
JPsY8u74EsoGwL5SsPs2HJ5DeS/Xb0cwylFq+0hkQ3vHAgMBAAGjbzBtMB0GA1Ud
DgQWBBRd/hEICtjIm4wqI0xoeuvMePbN+DAfBgNVHSMEGDAWgBRd/hEICtjIm4wq
I0xoeuvMePbN+DAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAE8ntp8FiNie9fZjg1OU9Xij+H7b2
ecPgYtVADYjPP/78+9FDR2kJlJoFjoy4/c7HxGUP0ak4FkQ2RM82k55XHC+h3fMt
nNXPxrkX3IHbuwG0CMvcrq9NatWDyIXD2seqPmMSn+KRuIM+CcUcVZjLqFATJlma
6hzHAV1pS1+aFe2Kftm642/xKfQ2CGZWsiFJanB0T1R3i1Nkw2MPRUrEF19TEcHU
MMp37aIxWXamja+dakjtCu/qfFjmJN95leuYbqJL5YhrNmLpHV2AnoSlR2u+2ra0
Xyg8GsJS2m+yuzApEOy2buTg8S6xvlvMo4v55DhF29KNZKxzwQ3gmB652A==
-----END CERTIFICATE-----
`;

/**
 * Start a local HTTPS server with `handler` and return a `makeHttpsPost`-style
 * `post(apiPath, body)` bound to it (verifying TLS against the embedded cert),
 * plus a `close()` to shut it down. Lets the timeout/oversize tests exercise
 * the REAL node:https transport, where those guards live.
 */
async function startTlsServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  postOverrides: { timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<{
  post: (apiPath: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  close: () => Promise<void>;
}> {
  const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const readFile = (path: string): string => {
    if (path.endsWith('/ca.crt')) return TEST_TLS_CERT;
    if (path.endsWith('/token')) return 'app-sa-token';
    throw new Error(`unexpected readFile: ${path}`);
  };
  const post = __testing.makeHttpsPost({
    readFile,
    base: `https://127.0.0.1:${port}`,
    ...postOverrides,
  });
  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return { post, close };
}

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

  it('does NOT share a cached SAR allow across two tokens with the same username but different groups', async () => {
    // Regression for the HIGH finding: the SAR cache must be bound to the
    // complete resolved subject (here: the caller token), not the username
    // alone. Token A (privileged group) gets an ALLOW; token B resolves to the
    // SAME username but a less-privileged group and must get its OWN SAR — it
    // must NOT inherit token A's cached ALLOW.
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
        if (apiPath === TOKEN_REVIEW_PATH) {
          // Both tokens resolve to username 'alice' but DIFFERENT groups.
          const callerToken = (body as { spec: { token: string } }).spec.token;
          const groups = callerToken === 'token-admin' ? ['admins'] : ['viewers'];
          return Promise.resolve({
            status: 201,
            body: { status: { authenticated: true, user: { username: 'alice', groups } } },
          });
        }
        if (apiPath === SAR_PATH) {
          // Apiserver authorizes by the real subject: admins group → allowed,
          // viewers group → denied.
          const groups = (body as { spec: { groups?: string[] } }).spec.groups ?? [];
          return Promise.resolve({
            status: 201,
            body: { status: { allowed: groups.includes('admins') } },
          });
        }
        throw new Error(`unexpected post: ${apiPath}`);
      },
    };
    const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);

    const admin: RequestContext = { identity: { token: 'token-admin' } };
    const viewer: RequestContext = { identity: { token: 'token-viewer' } };

    // Privileged token gets ALLOW and warms the cache.
    assert.equal(await authz.authorize(admin, 'agent_approve', 't1'), true);
    // Less-privileged token with the SAME username MUST NOT inherit the allow.
    assert.equal(
      await authz.authorize(viewer, 'agent_approve', 't1'),
      false,
      'second token (different groups) must not share the first token cached allow',
    );

    // Two distinct SARs must have been issued (one per token), proving the
    // cache key did not collide on username.
    const sars = calls.filter((c) => c.path === SAR_PATH);
    assert.equal(sars.length, 2, 'one SAR per distinct caller token, not a cache hit');
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

    it('exercises BOTH a TokenReview and a SAR create (each accepted 2xx)', async () => {
      const posted: string[] = [];
      const deps: K8sRbacDeps = {
        readFile: () => 'x',
        apiServerBase: () => 'https://10.0.0.1:443',
        post: (apiPath) => {
          posted.push(apiPath);
          return Promise.resolve({
            status: 201,
            body:
              apiPath === TOKEN_REVIEW_PATH
                ? { status: { authenticated: false } }
                : { status: { allowed: false } },
          });
        },
      };
      const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
      await authz.init!();
      assert.ok(posted.includes(TOKEN_REVIEW_PATH), 'init must create a TokenReview');
      assert.ok(posted.includes(SAR_PATH), 'init must create a SubjectAccessReview');
    });

    it('throws an actionable TokenReview/auth-delegator error when TokenReview create returns 403', async () => {
      // SAR create would succeed, but TokenReview create is forbidden. init must
      // still fail fast and name the missing TokenReview permission.
      const deps: K8sRbacDeps = {
        readFile: () => 'x',
        apiServerBase: () => 'https://10.0.0.1:443',
        post: (apiPath) =>
          apiPath === TOKEN_REVIEW_PATH
            ? Promise.resolve({ status: 403, body: { message: 'forbidden' } })
            : Promise.resolve({ status: 201, body: { status: { allowed: false } } }),
      };
      const authz = makeK8sRbacAuthorizerWithDeps(fakeConfig(), deps);
      await assert.rejects(() => authz.init!(), (err: Error) => {
        assert.match(err.message, /TokenReview/);
        assert.match(err.message, /system:auth-delegator/);
        return true;
      });
    });
  });

  describe('https transport (timeout / response size)', () => {
    it('times out → rejects and destroys the request', async () => {
      let socketClosed = false;
      // Never respond: the server holds the connection open so the client-side
      // timeout fires.
      const { post, close } = await startTlsServer(
        (req) => {
          req.socket.on('close', () => {
            socketClosed = true;
          });
        },
        { timeoutMs: 150 },
      );
      try {
        await assert.rejects(
          () => post(SAR_PATH, { spec: {} }),
          /timed out after 150ms/,
        );
        // The client destroyed the request, which closes the underlying socket;
        // give the server a tick to observe the close.
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(socketClosed, true, 'timed-out request must be destroyed');
      } finally {
        await close();
      }
    });

    it('oversized response body → rejects (fail closed)', async () => {
      // Stream far more than the (test-lowered) cap; the client must abort.
      const { post, close } = await startTlsServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          // 64 KiB of junk, well over the 1 KiB test cap.
          res.write('{"status":{"allowed":true},"pad":"');
          res.write('x'.repeat(64 * 1024));
          // Intentionally never end; the client should abort on the cap.
        },
        { maxResponseBytes: 1024 },
      );
      try {
        await assert.rejects(
          () => post(SAR_PATH, { spec: {} }),
          /exceeded 1024 bytes/,
        );
      } finally {
        await close();
      }
    });

    it('a normal small response is parsed and returned', async () => {
      const { post, close } = await startTlsServer((_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: { allowed: true } }));
      });
      try {
        const result = await post(SAR_PATH, { spec: {} });
        assert.equal(result.status, 201);
        assert.deepEqual(result.body, { status: { allowed: true } });
      } finally {
        await close();
      }
    });
  });

  describe('token hashing', () => {
    it('never exposes the raw token and is stable + distinct per token', () => {
      const a = __testing.hashToken('caller-token');
      const b = __testing.hashToken('caller-token');
      const c = __testing.hashToken('other-token');
      assert.equal(a, b, 'same token → same hash');
      assert.notEqual(a, c, 'different token → different hash');
      assert.match(a, /^[0-9a-f]{64}$/, 'sha256 hex digest');
      assert.ok(!a.includes('caller-token'), 'hash must not contain the raw token');
    });
  });
});
