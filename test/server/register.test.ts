/**
 * Tests for the access-control gating of MCP resources and prompts
 * (src/server/register.ts).
 *
 * Security finding: only TOOLS were gated through `checkAccess`; resource
 * reads and prompt gets executed their handlers unconditionally. Under the
 * HTTP + k8s-rbac profile that is an unauthenticated read surface. The fix
 * mirrors the tool path: `registerIndexerResource` / `registerIndexerPrompt`
 * register a permission class (default `'read'`) and run `checkAccess` before
 * invoking the user handler. Because `ReadResourceResult` / `GetPromptResult`
 * have no `isError` channel, denial is signalled by THROWING — the SDK turns a
 * thrown handler error into a JSON-RPC error response.
 *
 * Strategy mirrors test/tools/agent-tools.test.ts: a fake McpServer captures
 * the SDK callback registered for each resource/prompt; we then invoke that
 * captured callback directly and assert (a) the spy handler does NOT run when
 * the active authorizer denies `read`, and the callback throws with the deny
 * reason, and (b) the spy handler DOES run when `read` is granted.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerIndexerResource,
  registerIndexerPrompt,
} from '../../src/server/register.js';
import {
  initAccessControl,
  initAccessControlWith,
  resetForTests,
} from '../../src/access-control.js';
import type { Authorizer } from '../../src/auth/authorizer.js';

// ---------------------------------------------------------------------------
// Fake McpServer capturing the SDK callbacks for resources and prompts.
// ---------------------------------------------------------------------------

interface FakeServer {
  resourceCbs: Map<string, (...args: unknown[]) => unknown>;
  promptCbs: Map<string, (...args: unknown[]) => unknown>;
  registerResource: (
    name: string,
    uri: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => void;
  registerPrompt: (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => void;
}

function makeFakeServer(): FakeServer {
  const resourceCbs = new Map<string, (...args: unknown[]) => unknown>();
  const promptCbs = new Map<string, (...args: unknown[]) => unknown>();
  return {
    resourceCbs,
    promptCbs,
    registerResource(name, _uri, _config, cb) {
      resourceCbs.set(name, cb);
    },
    registerPrompt(name, _config, cb) {
      promptCbs.set(name, cb);
    },
  };
}

const fakeExtra = { signal: new AbortController().signal, authInfo: undefined };

/** An authorizer that grants nothing — denies every permission class. */
const denyAllAuthorizer: Authorizer = {
  authorize: () => Promise.resolve(false),
};

describe('register: resource/prompt access-control gating', () => {
  beforeEach(() => {
    resetForTests();
  });

  describe('resources', () => {
    it('does NOT run the handler when read is denied (throws)', async () => {
      // deny-all authorizer with empty deny set: `read` is refused, so the
      // resource read must be denied before the handler runs.
      initAccessControlWith(denyAllAuthorizer, { deny: new Set() });

      let ran = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = makeFakeServer() as any;
      registerIndexerResource(server, {
        name: 'fake-resource',
        uri: 'indexer://fake',
        description: 'fake',
        handler: () => {
          ran = true;
          return { contents: [] };
        },
      });

      const cb = server.resourceCbs.get('fake-resource');
      assert.ok(cb, 'resource callback was registered');
      await assert.rejects(
        () => cb(new URL('indexer://fake'), fakeExtra),
        /does not grant|denied/,
      );
      assert.equal(ran, false, 'handler must not run when read is denied');
    });

    it('runs the handler when read is granted', async () => {
      // read_only level grants the `read` class.
      initAccessControl({
        level: 'read_only',
        allow: new Set(),
        deny: new Set(),
      });

      let ran = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = makeFakeServer() as any;
      registerIndexerResource(server, {
        name: 'fake-resource',
        uri: 'indexer://fake',
        description: 'fake',
        handler: () => {
          ran = true;
          return { contents: [] };
        },
      });

      const cb = server.resourceCbs.get('fake-resource');
      const result = await cb(new URL('indexer://fake'), fakeExtra);
      assert.equal(ran, true, 'handler must run when read is granted');
      assert.deepEqual(result, { contents: [] });
    });
  });

  describe('prompts', () => {
    it('does NOT run the handler when read is denied (throws)', async () => {
      initAccessControlWith(denyAllAuthorizer, { deny: new Set() });

      let ran = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = makeFakeServer() as any;
      registerIndexerPrompt(server, {
        name: 'fake_prompt',
        description: 'fake',
        handler: () => {
          ran = true;
          return { messages: [] };
        },
      });

      const cb = server.promptCbs.get('fake_prompt');
      assert.ok(cb, 'prompt callback was registered');
      await assert.rejects(
        () => cb(fakeExtra),
        /does not grant|denied/,
      );
      assert.equal(ran, false, 'handler must not run when read is denied');
    });

    it('runs the handler when read is granted', async () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(),
        deny: new Set(),
      });

      let ran = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = makeFakeServer() as any;
      registerIndexerPrompt(server, {
        name: 'fake_prompt',
        description: 'fake',
        handler: () => {
          ran = true;
          return { messages: [] };
        },
      });

      const cb = server.promptCbs.get('fake_prompt');
      const result = await cb(fakeExtra);
      assert.equal(ran, true, 'handler must run when read is granted');
      assert.deepEqual(result, { messages: [] });
    });
  });
});
