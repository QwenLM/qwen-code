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
    });
    expect(hit.action).toBe('deny');

    const miss = evaluate(policy, {
      tool: 'edit_file',
      args: { path: 'src/util/x.ts' },
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

  it('SAFETY: a matched deny rule with expiresAt is downgraded to prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: temp-deny
    match:
      tool: bash
    action: deny
    expiresAt: "2030-01-01"
`);
    const d = evaluate(policy, { tool: 'bash', args: 'ls' });
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
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
});
