import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAccess,
  initAccessControl,
  registerToolPermission,
  resetForTests,
  validateOverrides,
} from '../src/access-control.js';

describe('access-control', () => {
  beforeEach(() => {
    resetForTests();
  });

  describe('level → permission-class mapping', () => {
    it('read_only allows only "read"', async () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('r1', 'read');
      registerToolPermission('q1', 'agent_queue');
      registerToolPermission('a1', 'agent_approve');
      registerToolPermission('s1', 'graphman_safe');
      registerToolPermission('d1', 'graphman_destructive');

      assert.equal((await checkAccess('r1')).allowed, true);
      assert.equal((await checkAccess('q1')).allowed, false);
      assert.equal((await checkAccess('a1')).allowed, false);
      assert.equal((await checkAccess('s1')).allowed, false);
      assert.equal((await checkAccess('d1')).allowed, false);
    });

    it('read_write allows read + agent_queue + graphman_safe', async () => {
      initAccessControl({
        level: 'read_write',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('r1', 'read');
      registerToolPermission('q1', 'agent_queue');
      registerToolPermission('a1', 'agent_approve');
      registerToolPermission('s1', 'graphman_safe');
      registerToolPermission('d1', 'graphman_destructive');

      assert.equal((await checkAccess('r1')).allowed, true);
      assert.equal((await checkAccess('q1')).allowed, true);
      assert.equal((await checkAccess('a1')).allowed, false);
      assert.equal((await checkAccess('s1')).allowed, true);
      assert.equal((await checkAccess('d1')).allowed, false);
    });

    it('read_write_destructive adds graphman_destructive', async () => {
      initAccessControl({
        level: 'read_write_destructive',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('r1', 'read');
      registerToolPermission('q1', 'agent_queue');
      registerToolPermission('a1', 'agent_approve');
      registerToolPermission('s1', 'graphman_safe');
      registerToolPermission('d1', 'graphman_destructive');

      assert.equal((await checkAccess('r1')).allowed, true);
      assert.equal((await checkAccess('q1')).allowed, true);
      assert.equal((await checkAccess('a1')).allowed, false);
      assert.equal((await checkAccess('s1')).allowed, true);
      assert.equal((await checkAccess('d1')).allowed, true);
    });

    it('full allows everything (incl. agent_approve)', async () => {
      initAccessControl({
        level: 'full',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('r1', 'read');
      registerToolPermission('q1', 'agent_queue');
      registerToolPermission('a1', 'agent_approve');
      registerToolPermission('s1', 'graphman_safe');
      registerToolPermission('d1', 'graphman_destructive');

      assert.equal((await checkAccess('r1')).allowed, true);
      assert.equal((await checkAccess('q1')).allowed, true);
      assert.equal((await checkAccess('a1')).allowed, true);
      assert.equal((await checkAccess('s1')).allowed, true);
      assert.equal((await checkAccess('d1')).allowed, true);
    });
  });

  describe('resolution order', () => {
    it('deny override beats permClass + allow + level', async () => {
      initAccessControl({
        level: 'full',
        allow: new Set(['tool_x']),
        deny: new Set(['tool_x']),
      });
      registerToolPermission('tool_x', 'read');
      const res = await checkAccess('tool_x');
      assert.equal(res.allowed, false);
      assert.ok(res.reason?.includes('explicitly denied'));
    });

    it('unregistered tools are denied regardless of allow override', async () => {
      initAccessControl({
        level: 'full',
        allow: new Set(['unknown_tool']),
        deny: new Set(),
      });
      const res = await checkAccess('unknown_tool');
      assert.equal(res.allowed, false);
      assert.ok(res.reason?.includes('no registered permission class'));
      assert.equal(res.permissionClass, undefined);
    });

    it('allow override grants access when level would forbid', async () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(['destructive_tool']),
        deny: new Set(),
      });
      registerToolPermission('destructive_tool', 'graphman_destructive');
      const res = await checkAccess('destructive_tool');
      assert.equal(res.allowed, true);
      assert.equal(res.permissionClass, 'graphman_destructive');
    });

    it('level grants access without allow override when class is in scope', async () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('read_tool', 'read');
      const res = await checkAccess('read_tool');
      assert.equal(res.allowed, true);
      assert.equal(res.permissionClass, 'read');
    });

    it('level denies when class is out of scope and no allow override', async () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('queue_tool', 'agent_queue');
      const res = await checkAccess('queue_tool');
      assert.equal(res.allowed, false);
      assert.ok(res.reason?.includes('agent_queue'));
      // The grant step now lives in the authorizer; the wrapper's deny reason
      // no longer names the level, only the ungranted permission class.
      assert.ok(res.reason?.includes('does not grant'));
    });

    it('tool name lookup is case-sensitive (whitespace does not match)', async () => {
      initAccessControl({
        level: 'full',
        allow: new Set(),
        deny: new Set(),
      });
      registerToolPermission('exact_name', 'read');
      // A lookup with trailing whitespace is NOT the same registered tool.
      const res = await checkAccess('exact_name ');
      assert.equal(res.allowed, false);
      assert.ok(res.reason?.includes('no registered permission class'));
    });
  });

  describe('validateOverrides', () => {
    it('returns unknown allow/deny names not registered as tools', () => {
      initAccessControl({
        level: 'read_only',
        allow: new Set(['known_a', 'ghost_a']),
        deny: new Set(['ghost_d']),
      });
      registerToolPermission('known_a', 'read');
      const v = validateOverrides();
      assert.deepEqual(v.unknownAllow.sort(), ['ghost_a']);
      assert.deepEqual(v.unknownDeny.sort(), ['ghost_d']);
    });
  });

  it('checkAccess throws when not initialized', async () => {
    // resetForTests was called by beforeEach hook above. checkAccess is async,
    // so the "not initialized" guard surfaces as a rejected promise.
    await assert.rejects(() => checkAccess('anything'), /not initialized/);
  });
});
