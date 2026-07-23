/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Policy } from './loader.js';
import {
  evaluate,
  explainPolicy,
  type QuotaOracle,
  type ToolCallContext,
} from './evaluator.js';

const NOW = new Date('2026-06-11T12:00:00Z');

function policy(rules: Policy['rules'], defaultAction = 'prompt'): Policy {
  return {
    defaults: {
      action: defaultAction as Policy['defaults']['action'],
      requireScope: 'approve',
    },
    rules,
  };
}

const oracle = (
  m: Record<string, 'room' | 'exhausted' | 'untracked'>,
): QuotaOracle => ({
  state: (id) => m[id] ?? 'untracked',
});

describe('explainPolicy — drift guard (decision === evaluate)', () => {
  const scenarios: Array<{
    name: string;
    p: Policy;
    ctx: ToolCallContext;
    quota?: QuotaOracle;
  }> = [
    {
      name: 'clean winner',
      p: policy([{ id: 'a', match: { tool: 'bash' }, action: 'allow' }]),
      ctx: { tool: 'bash' },
    },
    {
      name: 'downgraded-to-prompt winner (no oracle, maxPerWindow)',
      p: policy([
        {
          id: 'q',
          match: { tool: 'bash' },
          action: 'allow',
          maxPerWindow: { count: 1, windowSec: 60 },
        },
      ]),
      ctx: { tool: 'bash' },
    },
    {
      name: 'no rule matches → default',
      p: policy([{ id: 'a', match: { tool: 'git' }, action: 'allow' }]),
      ctx: { tool: 'bash' },
    },
    {
      name: 'exhausted quota → skip → default',
      p: policy([
        {
          id: 'q',
          match: { tool: 'bash' },
          action: 'allow',
          maxPerWindow: { count: 1, windowSec: 60 },
        },
      ]),
      ctx: { tool: 'bash' },
      quota: oracle({ q: 'exhausted' }),
    },
    {
      name: 'room quota → allow',
      p: policy([
        {
          id: 'q',
          match: { tool: 'bash' },
          action: 'allow',
          maxPerWindow: { count: 5, windowSec: 60 },
        },
      ]),
      ctx: { tool: 'bash' },
      quota: oracle({ q: 'room' }),
    },
  ];

  for (const s of scenarios) {
    it(`decision matches evaluate(): ${s.name}`, () => {
      const exp = explainPolicy(s.p, s.ctx, NOW, s.quota);
      expect(exp.decision).toEqual(evaluate(s.p, s.ctx, NOW, s.quota));
    });
  }
});

describe('explainPolicy — trace structure', () => {
  it('walks rules in evaluation order; winner matched, later rules not-reached', () => {
    // Two rules both match bash; the more specific (higher priority) wins.
    const p = policy([
      { id: 'low', match: { tool: '*' }, action: 'deny' }, // specificity 10
      { id: 'high', match: { tool: 'bash' }, action: 'allow' }, // specificity 100
    ]);
    const { trace, decision } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace.map((t) => t.id)).toEqual(['high', 'low']); // eval order
    expect(trace[0]).toMatchObject({
      id: 'high',
      status: 'matched',
      action: 'allow',
    });
    expect(trace[1]).toMatchObject({
      id: 'low',
      status: 'not-reached',
      reason: 'earlier-rule-won',
    });
    expect(decision).toMatchObject({ action: 'allow', ruleId: 'high' });
  });

  it('winning trace entry agrees with the decision (id + action)', () => {
    const p = policy([
      { id: 'a', match: { tool: 'git' }, action: 'deny' },
      { id: 'b', match: { tool: 'bash' }, action: 'allow' },
    ]);
    const { trace, decision } = explainPolicy(p, { tool: 'bash' }, NOW);
    const winner = trace.find((t) => t.status === 'matched');
    expect(winner?.id).toBe(decision.ruleId);
    expect(winner?.action).toBe(decision.action);
  });

  it('no rule matches → all skipped, decision source default', () => {
    const p = policy([{ id: 'a', match: { tool: 'git' }, action: 'allow' }]);
    const { trace, decision } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      id: 'a',
      status: 'skipped',
      reason: 'tool-mismatch',
    });
    expect(trace.some((t) => t.status === 'matched')).toBe(false);
    expect(decision.source).toBe('default');
  });

  it('explains a pathGlob rule from --path', () => {
    const p = policy([
      {
        id: 'deny-env',
        match: { pathGlob: ['**/.env*'] },
        action: 'deny',
      },
    ]);
    const ex = explainPolicy(p, {
      tool: 'edit',
      args: {},
      paths: ['/proj/.env'],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(ex.decision.action).toBe('deny');
    expect(ex.trace.find((t) => t.id === 'deny-env')?.status).toBe('matched');
  });
});

describe('explainPolicy — skipped reason tokens', () => {
  const cases: Array<{
    name: string;
    rule: Policy['rules'][number];
    ctx: ToolCallContext;
    reason: string;
  }> = [
    {
      name: 'tool',
      rule: { match: { tool: 'git' }, action: 'allow' },
      ctx: { tool: 'bash' },
      reason: 'tool-mismatch',
    },
    {
      name: 'args',
      rule: { match: { tool: 'bash', argsGlob: '*deploy*' }, action: 'allow' },
      ctx: { tool: 'bash', args: 'npm test' },
      reason: 'args-mismatch',
    },
    {
      name: 'no-path-candidates',
      rule: { match: { tool: 'read', pathGlob: '*.env' }, action: 'deny' },
      ctx: { tool: 'read', args: 'a string with no path field' },
      reason: 'no-path-candidates',
    },
    {
      name: 'path-mismatch',
      rule: { match: { tool: 'read', pathGlob: '*.env' }, action: 'deny' },
      ctx: {
        tool: 'read',
        args: { path: '/src/app.ts' },
        paths: ['/src/app.ts'],
        projectRoot: '/src',
        cwd: '/src',
      },
      reason: 'path-mismatch',
    },
    {
      name: 'origin-scope',
      rule: { match: { tool: 'bash', originScope: 'owner' }, action: 'allow' },
      ctx: { tool: 'bash', originScope: 'guest' },
      reason: 'origin-scope-mismatch',
    },
    {
      name: 'session-tag',
      rule: { match: { tool: 'bash', sessionTag: 'prod' }, action: 'allow' },
      ctx: { tool: 'bash', sessionTag: 'dev' },
      reason: 'session-tag-mismatch',
    },
  ];
  for (const c of cases) {
    it(`reports ${c.reason}`, () => {
      const { trace } = explainPolicy(policy([c.rule]), c.ctx, NOW);
      expect(trace[0]).toMatchObject({ status: 'skipped', reason: c.reason });
    });
  }
});

describe('explainPolicy — condition reasons', () => {
  it('expired → skipped/expired', () => {
    const p = policy([
      {
        id: 'a',
        match: { tool: 'bash' },
        action: 'allow',
        expiresAt: '2020-01-01T00:00:00Z',
      },
    ]);
    const { trace, decision } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace[0]).toMatchObject({ status: 'skipped', reason: 'expired' });
    expect(decision.source).toBe('default');
  });

  it('outside-time-window → skipped/outside-time-window', () => {
    // NOW is 12:00 UTC; window 01:00–02:00 UTC excludes it.
    const p = policy([
      {
        id: 'a',
        match: {
          tool: 'bash',
          timeOfDay: { from: '01:00', to: '02:00', timezone: 'UTC' },
        },
        action: 'allow',
      },
    ]);
    const { trace } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace[0]).toMatchObject({
      status: 'skipped',
      reason: 'outside-time-window',
    });
  });

  it('quota-exhausted (with oracle) → skipped/quota-exhausted', () => {
    const p = policy([
      {
        id: 'q',
        match: { tool: 'bash' },
        action: 'allow',
        maxPerWindow: { count: 1, windowSec: 60 },
      },
    ]);
    const { trace } = explainPolicy(
      p,
      { tool: 'bash' },
      NOW,
      oracle({ q: 'exhausted' }),
    );
    expect(trace[0]).toMatchObject({
      status: 'skipped',
      reason: 'quota-exhausted',
    });
  });

  it('maxPerWindow with NO oracle → matched, prompt, downgraded, quota-not-evaluated', () => {
    const p = policy([
      {
        id: 'q',
        match: { tool: 'bash' },
        action: 'allow',
        maxPerWindow: { count: 1, windowSec: 60 },
      },
    ]);
    const { trace, decision } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace[0]).toMatchObject({
      status: 'matched',
      action: 'prompt',
      downgraded: true,
      reason: 'quota-not-evaluated',
      quotaNotEvaluated: true,
    });
    expect(decision.action).toBe('prompt');
    expect(decision.usedDeferredField).toBe(true);
  });

  it('malformed expiresAt → matched, downgraded, malformed-expiresAt', () => {
    const p = policy([
      {
        id: 'a',
        match: { tool: 'bash' },
        action: 'allow',
        expiresAt: 'not-a-date',
      },
    ]);
    const { trace } = explainPolicy(p, { tool: 'bash' }, NOW);
    expect(trace[0]).toMatchObject({
      status: 'matched',
      action: 'prompt',
      downgraded: true,
      reason: 'malformed-expiresAt',
    });
  });

  it('room quota (with oracle) → matched/allow (not downgraded)', () => {
    const p = policy([
      {
        id: 'q',
        match: { tool: 'bash' },
        action: 'allow',
        maxPerWindow: { count: 5, windowSec: 60 },
      },
    ]);
    const { trace } = explainPolicy(
      p,
      { tool: 'bash' },
      NOW,
      oracle({ q: 'room' }),
    );
    expect(trace[0]).toMatchObject({
      status: 'matched',
      action: 'allow',
      reason: 'matched',
    });
    expect(trace[0].downgraded).toBe(false);
    // The quota WAS consulted (oracle, room) → no dry-run caveat flag.
    expect(trace[0].quotaNotEvaluated).toBeUndefined();
  });
});
