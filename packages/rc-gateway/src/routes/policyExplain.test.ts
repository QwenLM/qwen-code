/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildExplainContext,
  ExplainBodyError,
  createPolicyExplainRoute,
  type PolicyExplainAccess,
} from './policyExplain.js';
import type { Policy } from '../policy/loader.js';

describe('buildExplainContext', () => {
  it('maps tool/path/args/operation/scope/tag and anchors to projectRoot', () => {
    const ctx = buildExplainContext(
      {
        tool: 'write_file',
        path: '/etc/passwd',
        args: { path: '/etc/passwd', content: 'x' },
        operation: 'write',
        scope: 'owner',
        tag: 'ci',
      },
      '/work',
    );
    expect(ctx).toMatchObject({
      tool: 'write_file',
      projectRoot: '/work',
      cwd: '/work',
      paths: ['/etc/passwd'],
      operations: ['write'],
      originScope: 'owner',
      sessionTag: 'ci',
    });
    expect(ctx.args).toMatchObject({ path: '/etc/passwd' });
  });

  it('accepts operation as a comma list or array and validates each value', () => {
    expect(
      buildExplainContext({ tool: 'x', operation: 'read,write' }, '/w')
        .operations,
    ).toEqual(['read', 'write']);
    expect(
      buildExplainContext({ tool: 'x', operation: ['read', 'execute'] }, '/w')
        .operations,
    ).toEqual(['read', 'execute']);
    expect(() =>
      buildExplainContext({ tool: 'x', operation: 'fly' }, '/w'),
    ).toThrow(ExplainBodyError);
  });

  it('rejects a non-string, non-array operation instead of silently dropping it', () => {
    expect(() =>
      buildExplainContext({ tool: 'x', operation: 42 }, '/w'),
    ).toThrow(ExplainBodyError);
  });

  it('rejects an array operation containing a non-string element', () => {
    expect(() =>
      buildExplainContext({ tool: 'x', operation: ['read', 5] }, '/w'),
    ).toThrow(ExplainBodyError);
  });
});

const POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'deny-write',
      match: { tool: 'write_file' },
      action: 'deny',
      reason: 'no writes',
    },
  ],
};

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}
const access: PolicyExplainAccess = {
  policy: () => POLICY,
  projectRoot: () => '/work',
  quotaOracle: () => undefined,
};

describe('createPolicyExplainRoute', () => {
  it('200s with a decision + trace for a matched rule', async () => {
    const audited: unknown[] = [];
    const h = createPolicyExplainRoute(access, {
      audit: {
        record: async (e) => {
          audited.push(e);
        },
      },
    });
    const res = fakeRes();
    await h(
      {
        body: { tool: 'write_file', path: '/x' },
        rcClient: { id: 't1', scopes: ['owner'] },
      } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(200);
    const out = res.body as { decision: { action: string }; trace: unknown[] };
    expect(out.decision.action).toBe('deny');
    expect(Array.isArray(out.trace)).toBe(true);
    // audit row: metadata only
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'policy_explained',
      actorTokenId: 't1',
      detail: { tool: 'write_file', decision: 'deny' },
    });
    // exact detail shape: a matched deny rule contributes ONLY
    // tool/decision/ruleId — no path/args/scope/tag ever sneak in.
    const detail = (audited[0] as { detail: Record<string, unknown> }).detail;
    expect(Object.keys(detail).sort()).toEqual(['decision', 'ruleId', 'tool']);
    expect(detail).not.toHaveProperty('path');
    expect(detail).not.toHaveProperty('args');
    expect(detail).not.toHaveProperty('scope');
    expect(detail).not.toHaveProperty('tag');
    // NEVER echoes the caller path
    expect(JSON.stringify(res.body)).not.toContain('/x');
  });

  it('400s on a missing tool', async () => {
    const h = createPolicyExplainRoute(access);
    const res = fakeRes();
    await h(
      { body: {}, rcClient: { id: 't1' } } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe('invalid_tool');
  });

  it('503s when no policy is loaded', async () => {
    const h = createPolicyExplainRoute({ ...access, policy: () => undefined });
    const res = fakeRes();
    await h(
      { body: { tool: 'read_file' }, rcClient: { id: 't1' } } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('policy_unavailable');
  });

  it('400s with invalid_operation on an invalid operation enum value', async () => {
    const h = createPolicyExplainRoute(access);
    const res = fakeRes();
    await h(
      {
        body: { tool: 'write_file', operation: 'fly' },
        rcClient: { id: 't1' },
      } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe('invalid_operation');
  });

  it('500s with policy_explain_failed when access.policy() throws', async () => {
    const h = createPolicyExplainRoute({
      ...access,
      policy: () => {
        throw new Error('boom');
      },
    });
    const res = fakeRes();
    await h(
      { body: { tool: 'write_file' }, rcClient: { id: 't1' } } as never,
      res as never,
      (() => {}) as never,
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('policy_explain_failed');
  });
});
