/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  withAddedRule,
  withoutDeletedRule,
  withoutDeletedRuleInScopes,
} from './permission-rule-label.js';

describe('withoutDeletedRule', () => {
  it('removes the entry that trims to the row', () => {
    expect(withoutDeletedRule(['  Bash(git *)  '], 'Bash(git *)')).toEqual([]);
  });

  it('returns null when no entry trims to the row', () => {
    expect(withoutDeletedRule(['Bash(git *)'], 'Bash(docker *)')).toBeNull();
  });

  it('removes one entry, not every entry that trims to the row', () => {
    // A padded entry written by hand and an exact one added later can both be
    // stored and both list as the same trimmed row. One delete removes the row
    // it was asked for.
    expect(
      withoutDeletedRule([' Bash(git *) ', 'Bash(git *)'], 'Bash(git *)'),
    ).toEqual(['Bash(git *)']);
  });

  it('keeps non-string entries instead of calling a method on them', () => {
    // Settings loading does not validate element types, and `parseRules` drops
    // falsy entries, so a `null` can sit in the stored list while the session
    // runs normally.
    expect(
      withoutDeletedRule([' Bash(git *) ', null] as unknown[], 'Bash(git *)'),
    ).toEqual([null]);
  });
});

describe('withAddedRule', () => {
  it('appends a rule that is not stored yet', () => {
    expect(withAddedRule(['Bash(docker *)'], 'Bash(git *)')).toEqual([
      'Bash(docker *)',
      'Bash(git *)',
    ]);
  });

  it('does not append a second copy over a padded stored entry', () => {
    // An exact compare would miss `'  Bash(git *)  '` and append a duplicate
    // that the next start lists as the same row twice.
    expect(withAddedRule(['  Bash(git *)  '], 'Bash(git *)')).toBeNull();
  });

  it('treats a non-string entry as not matching', () => {
    expect(withAddedRule([null] as unknown[], 'Bash(git *)')).toEqual([
      null,
      'Bash(git *)',
    ]);
  });
});

describe('withoutDeletedRuleInScopes', () => {
  const scopes = ['user', 'workspace'] as const;
  const rulesFor =
    (byScope: Record<string, unknown[] | undefined>) =>
    (scope: (typeof scopes)[number]) =>
      byScope[scope];

  it('picks the workspace scope when the user scope does not hold the rule', () => {
    expect(
      withoutDeletedRuleInScopes(
        scopes,
        rulesFor({ user: undefined, workspace: ['Bash(git *)'] }),
        'Bash(git *)',
      ),
    ).toEqual({ scope: 'workspace', rules: [] });
  });

  it('prefers the user scope when both hold the rule', () => {
    expect(
      withoutDeletedRuleInScopes(
        scopes,
        rulesFor({ user: ['Bash(git *)'], workspace: ['Bash(git *)'] }),
        'Bash(git *)',
      ),
    ).toEqual({ scope: 'user', rules: [] });
  });

  it('returns null when neither scope holds the rule', () => {
    expect(
      withoutDeletedRuleInScopes(
        scopes,
        rulesFor({ user: ['Bash(docker *)'], workspace: undefined }),
        'Bash(git *)',
      ),
    ).toBeNull();
  });
});
