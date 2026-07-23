/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { loadPolicy } from './loader.js';
import { evaluate } from './evaluator.js';
import type { Policy } from './loader.js';

describe('evaluate', () => {
  it('allow rule matches its ctx; non-matching arg falls through to default prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: allow-tests
    match:
      tool: bash
      argsGlob: "npm test*"
    action: allow
`);
    const hit = evaluate(policy, { tool: 'bash', args: 'npm test' });
    expect(hit.action).toBe('allow');
    expect(hit.ruleId).toBe('allow-tests');
    expect(hit.usedDeferredField).toBe(false);

    const miss = evaluate(policy, { tool: 'bash', args: 'npm publish' });
    expect(miss.action).toBe('prompt');
    expect(miss.ruleId).toBeUndefined();
    expect(miss.requireScope).toBe('approve');
  });

  it('deny rule matches and carries its reason', () => {
    const policy = loadPolicy(`
rules:
  - id: no-force-push
    match:
      argsGlob: "git push --force*"
    action: deny
    reason: "force push forbidden"
`);
    const d = evaluate(policy, {
      tool: 'bash',
      args: 'git push --force origin',
    });
    expect(d.action).toBe('deny');
    expect(d.reason).toBe('force push forbidden');
  });

  it('prompt rule carries requireScope', () => {
    const policy = loadPolicy(`
rules:
  - id: owner-only
    match:
      tool: rm
    action: prompt
    requireScope: owner
`);
    const d = evaluate(policy, { tool: 'rm', args: '-rf /' });
    expect(d.action).toBe('prompt');
    expect(d.requireScope).toBe('owner');
  });

  it('specificity: explicit-tool allow beats a tool:* prompt when both match', () => {
    const policy = loadPolicy(`
rules:
  - id: catch-all
    match:
      tool: "*"
    action: prompt
  - id: bash-allow
    match:
      tool: bash
    action: allow
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('bash-allow');
  });

  it('priority overrides specificity', () => {
    const policy = loadPolicy(`
rules:
  - id: low-specific
    match:
      tool: bash
    action: allow
  - id: high-priority-broad
    match:
      tool: "*"
    action: deny
    priority: 100
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('high-priority-broad');
  });

  it('pathGlob matches a path argument', () => {
    const policy = loadPolicy(`
rules:
  - id: auth-edits
    match:
      tool: edit_file
      pathGlob: "src/auth/**"
    action: deny
`);
    const hit = evaluate(policy, {
      tool: 'edit_file',
      args: { path: 'src/auth/login.ts' },
      paths: ['/proj/src/auth/login.ts'],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(hit.action).toBe('deny');

    const miss = evaluate(policy, {
      tool: 'edit_file',
      args: { path: 'src/util/x.ts' },
      paths: ['/proj/src/util/x.ts'],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(miss.action).toBe('prompt');
  });

  it('pathGlob present but no candidate path → no match', () => {
    const policy = loadPolicy(`
rules:
  - id: needs-path
    match:
      tool: edit_file
      pathGlob: "src/**"
    action: allow
`);
    const d = evaluate(policy, { tool: 'edit_file', args: 'no path here' });
    expect(d.action).toBe('prompt');
    expect(d.ruleId).toBeUndefined();
  });

  it('SAFETY: a matched allow rule using a deferred field is downgraded to prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: daytime-allow
    match:
      tool: bash
      timeOfDay: "09:00-17:00"
    action: allow
    requireScope: owner
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
    expect(d.ruleId).toBe('daytime-allow');
    expect(d.requireScope).toBe('owner');
  });

  it('a deny rule with a future expiresAt now applies (no longer downgraded)', () => {
    const policy = loadPolicy(`
rules:
  - id: temp-deny
    match:
      tool: bash
    action: deny
    expiresAt: "2030-01-01T00:00:00Z"
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('deny');
    expect(d.usedDeferredField).toBe(false);
    expect(d.ruleId).toBe('temp-deny');
  });

  it('an expired allow rule is skipped and falls through to default', () => {
    const policy = loadPolicy(`
rules:
  - id: expired-allow
    match:
      tool: bash
    action: allow
    expiresAt: "2020-01-01T00:00:00Z"
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('prompt');
    expect(d.ruleId).toBeUndefined();
    expect(d.usedDeferredField).toBe(false);
  });

  it('a not-yet-expired allow rule applies as allow', () => {
    const policy = loadPolicy(`
rules:
  - id: future-allow
    match:
      tool: bash
    action: allow
    expiresAt: "2026-06-09T13:00:00Z"
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('allow');
    expect(d.usedDeferredField).toBe(false);
    expect(d.ruleId).toBe('future-allow');
  });

  it('a well-formed allow IN the timeOfDay window applies as allow (not prompt)', () => {
    const policy = loadPolicy(`
rules:
  - id: daytime-allow
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: UTC
    action: allow
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('allow');
    expect(d.usedDeferredField).toBe(false);
    expect(d.ruleId).toBe('daytime-allow');
  });

  it('a well-formed allow OUT of the timeOfDay window is skipped, falls through', () => {
    const policy = loadPolicy(`
rules:
  - id: daytime-allow
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: UTC
    action: allow
  - id: catch-all
    match:
      tool: bash
    action: deny
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T20:00:00Z'),
    );
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('catch-all');
  });

  it('a prompt rule OUT of its timeOfDay window is skipped (does not prompt out of window)', () => {
    const policy = loadPolicy(`
rules:
  - id: night-prompt
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: UTC
    action: prompt
    requireScope: owner
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T20:00:00Z'),
    );
    // Falls through to default prompt (requireScope 'approve'), NOT the owner
    // rule — the out-of-window rule does not match at all.
    expect(d.action).toBe('prompt');
    expect(d.ruleId).toBeUndefined();
    expect(d.requireScope).toBe('approve');
  });

  it('SAFETY: a malformed timeOfDay (bad timezone) on an allow rule downgrades to prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: bad-tz
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: Not/AReal_Zone
    action: allow
    requireScope: owner
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
    expect(d.ruleId).toBe('bad-tz');
    expect(d.requireScope).toBe('owner');
  });

  it('SAFETY: a malformed expiresAt downgrades to prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: bad-expiry
    match:
      tool: bash
    action: allow
    expiresAt: "not-a-date"
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
    expect(d.ruleId).toBe('bad-expiry');
  });

  it('a maxPerWindow rule with NO quota oracle still downgrades allow→prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: quota-allow
    match:
      tool: bash
    action: allow
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    // evaluate() called WITHOUT a quota oracle → maxPerWindow is unevaluable →
    // prompt (the backward-compatible default preserved for every non-enforcer caller).
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
    expect(d.ruleId).toBe('quota-allow');
  });

  it('a rule that is BOTH expired (well-formed) AND has a malformed timeOfDay is skipped (no-match wins)', () => {
    const policy = loadPolicy(`
rules:
  - id: dead-and-malformed
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: Not/AReal_Zone
    action: allow
    expiresAt: "2020-01-01T00:00:00Z"
  - id: fallthrough
    match:
      tool: bash
    action: deny
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T12:00:00Z'),
    );
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('fallthrough');
  });

  it('a rule with malformed expiresAt AND out-of-window timeOfDay is skipped (no-match wins over unevaluable)', () => {
    const policy = loadPolicy(`
rules:
  - id: malformed-expiry-out-of-window
    match:
      tool: bash
      timeOfDay:
        from: "09:00"
        to: "17:00"
        timezone: UTC
    action: allow
    expiresAt: "not-a-date"
  - id: fallthrough
    match:
      tool: bash
    action: deny
`);
    const d = evaluate(
      policy,
      { tool: 'bash', args: 'ls' },
      new Date('2026-06-09T20:00:00Z'),
    );
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('fallthrough');
  });

  it('SAFETY: a deferred field with a FALSY value still downgrades (presence, not truthiness)', () => {
    // Regression: `expiresAt: 0` (and bare `maxPerWindow:` → null) are falsy but
    // PRESENT — they must still force the allow→prompt downgrade. A `||`-based
    // truthiness gate would wrongly auto-allow `rm -rf /` here.
    const policy = loadPolicy(`
rules:
  - id: falsy-expiry
    match:
      tool: bash
    action: allow
    expiresAt: 0
`);
    const d = evaluate(policy, { tool: 'bash', args: 'rm -rf /' });
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
    expect(d.ruleId).toBe('falsy-expiry');
  });

  it('SAFETY: a falsy timeOfDay value still downgrades', () => {
    const policy = loadPolicy(`
rules:
  - id: falsy-time
    match:
      tool: bash
      timeOfDay: ""
    action: allow
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
  });

  it('originScope and sessionTag match exactly', () => {
    const policy = loadPolicy(`
rules:
  - id: scoped
    match:
      originScope: ci
      sessionTag: nightly
    action: allow
`);
    const hit = evaluate(policy, {
      tool: 'bash',
      args: 'ls',
      originScope: 'ci',
      sessionTag: 'nightly',
    });
    expect(hit.action).toBe('allow');

    const miss = evaluate(policy, {
      tool: 'bash',
      args: 'ls',
      originScope: 'ci',
      sessionTag: 'other',
    });
    expect(miss.action).toBe('prompt');
  });

  it('empty policy → default prompt', () => {
    const empty: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [],
    };
    const d = evaluate(empty, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(false);
  });

  it("source is 'policy' when a rule matches and 'default' when none does", () => {
    const policy = loadPolicy(`
rules:
  - id: allow-tests
    match: { tool: bash, argsGlob: "npm test*" }
    action: allow
`);
    expect(evaluate(policy, { tool: 'bash', args: 'npm test' }).source).toBe(
      'policy',
    );
    // No rule matches → the default action, sourced as 'default'.
    expect(evaluate(policy, { tool: 'bash', args: 'npm publish' }).source).toBe(
      'default',
    );
  });

  it("source is 'policy' for a matched id-less rule (which ruleId alone cannot distinguish from default)", () => {
    const policy = loadPolicy(`
rules:
  - match: { tool: bash }
    action: allow
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBeUndefined(); // id-less rule
    expect(d.source).toBe('policy'); // …yet clearly rule-sourced
  });

  it("source is 'policy' for a rule downgraded to prompt by an unevaluable condition", () => {
    const policy = loadPolicy(`
rules:
  - id: quota-rule
    match: { tool: bash }
    action: allow
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('prompt'); // downgraded (maxPerWindow still deferred)
    expect(d.usedDeferredField).toBe(true);
    expect(d.source).toBe('policy'); // a rule was the cause
  });

  const denyEnv: Policy = {
    defaults: { action: 'prompt' as const },
    rules: [
      {
        id: 'deny-env',
        match: { pathGlob: ['**/.env*'] },
        action: 'deny' as const,
      },
    ],
  };

  it('matches pathGlob against ctx.paths (not args scraping)', () => {
    const d = evaluate(denyEnv, {
      tool: 'edit',
      args: {},
      paths: ['/proj/.env'],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('deny-env');
  });

  it.each(['/proj/./.env', '/proj/sub/../.env'])(
    'normalizes equivalent path spellings (traversal cannot bypass): %s',
    (p) => {
      const d = evaluate(denyEnv, {
        tool: 'edit',
        args: {},
        paths: [p],
        projectRoot: '/proj',
        cwd: '/proj',
      });
      expect(d.action).toBe('deny');
    },
  );

  it('still reports no-path-candidates when a pathGlob rule has no paths', () => {
    const d = evaluate(denyEnv, {
      tool: 'edit',
      args: {},
      paths: [],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(d.action).toBe('prompt'); // falls through to the default
    expect(d.source).toBe('default');
  });
});
