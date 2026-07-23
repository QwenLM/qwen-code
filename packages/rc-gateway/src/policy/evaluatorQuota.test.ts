/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { loadPolicy } from './loader.js';
import { evaluate, type QuotaOracle } from './evaluator.js';

const NOW = new Date('2026-06-09T12:00:00Z');

/** A fixed-verdict oracle. */
const oracleOf = (
  verdict: 'room' | 'exhausted' | 'untracked',
): QuotaOracle => ({ state: () => verdict });

const quotaPolicy = (extra = '') =>
  loadPolicy(`
rules:
  - id: q
    match: { tool: execute }
    action: allow
    maxPerWindow: { count: 5, windowSec: 60 }
${extra}`);

describe('evaluate with a quota oracle (cycle 43)', () => {
  it('room → the rule applies with its real action (allow), not deferred', () => {
    const d = evaluate(
      quotaPolicy(),
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('room'),
    );
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('q');
    expect(d.usedDeferredField).toBe(false);
  });

  it('exhausted → the rule does NOT match → falls through to the default', () => {
    const d = evaluate(
      quotaPolicy(),
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('exhausted'),
    );
    expect(d.action).toBe('prompt'); // policy default
    expect(d.source).toBe('default');
    expect(d.ruleId).toBeUndefined();
  });

  it('exhausted → falls through to a LOWER matching rule (its id, not null)', () => {
    const policy = loadPolicy(`
rules:
  - id: q
    match: { tool: execute }
    action: allow
    priority: 10
    maxPerWindow: { count: 5, windowSec: 60 }
  - id: lower
    match: { tool: execute }
    action: deny
    priority: 1
`);
    const d = evaluate(
      policy,
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('exhausted'),
    );
    expect(d.action).toBe('deny');
    expect(d.ruleId).toBe('lower');
  });

  it('untracked → downgrades allow to prompt', () => {
    const d = evaluate(
      quotaPolicy(),
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('untracked'),
    );
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
  });

  it('an id-less maxPerWindow rule + oracle still downgrades to prompt (untrackable)', () => {
    const policy = loadPolicy(`
rules:
  - match: { tool: execute }
    action: allow
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    const d = evaluate(
      policy,
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('room'), // oracle present, but no id → can't be tracked
    );
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
  });

  it('NO oracle → maxPerWindow still downgrades to prompt (backward compatible)', () => {
    const d = evaluate(quotaPolicy(), { tool: 'execute', args: 'ls' }, NOW);
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
  });

  it('a non-maxPerWindow rule is unaffected by the oracle', () => {
    const policy = loadPolicy(`
rules:
  - id: plain
    match: { tool: execute }
    action: allow
`);
    const d = evaluate(
      policy,
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('exhausted'),
    );
    expect(d.action).toBe('allow');
    expect(d.ruleId).toBe('plain');
  });

  it('compose: a malformed expiresAt + a room quota still downgrades to prompt', () => {
    const policy = loadPolicy(`
rules:
  - id: q
    match: { tool: execute }
    action: allow
    expiresAt: "not-a-date"
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    const d = evaluate(
      policy,
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('room'),
    );
    // room does NOT clear the unevaluable set by the malformed expiresAt.
    expect(d.action).toBe('prompt');
    expect(d.usedDeferredField).toBe(true);
  });

  it('compose: a malformed expiresAt + an EXHAUSTED quota → no-match (not prompt)', () => {
    const policy = loadPolicy(`
rules:
  - id: q
    match: { tool: execute }
    action: allow
    expiresAt: "not-a-date"
    maxPerWindow: { count: 5, windowSec: 60 }
`);
    const d = evaluate(
      policy,
      { tool: 'execute', args: 'ls' },
      NOW,
      oracleOf('exhausted'),
    );
    // exhausted wins over the unevaluable sibling → rule does not apply → default.
    expect(d.action).toBe('prompt'); // policy default, NOT a rule-caused prompt
    expect(d.source).toBe('default');
  });
});
