/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { sessionMatchesGitQuery } from './sessionSearch';

function session(
  overrides: Partial<DaemonSessionSummary>,
): DaemonSessionSummary {
  return {
    sessionId: 's-1',
    workspaceCwd: '/repo',
    ...overrides,
  };
}

describe('sessionMatchesGitQuery', () => {
  it('matches the PR number with and without #', () => {
    const s = session({
      pr: { number: 9517, url: 'https://github.com/o/r/pull/9517' },
    });
    expect(sessionMatchesGitQuery(s, '9517')).toBe(true);
    expect(sessionMatchesGitQuery(s, '#9517')).toBe(true);
  });

  it('does not partially match the PR number', () => {
    const s = session({
      pr: { number: 9517, url: 'https://github.com/o/r/pull/9517' },
    });
    expect(sessionMatchesGitQuery(s, '951')).toBe(false);
  });

  it('matches branch name and worktree branch/slug', () => {
    expect(
      sessionMatchesGitQuery(
        session({ branch: { name: 'feat-x', baseBranch: 'main' } }),
        'feat-x',
      ),
    ).toBe(true);
    expect(
      sessionMatchesGitQuery(
        session({
          worktree: { slug: 'pr-9517', path: '/wt', branch: 'fix-ci' },
        }),
        'fix-ci',
      ),
    ).toBe(true);
    expect(
      sessionMatchesGitQuery(
        session({
          worktree: { slug: 'pr-9517', path: '/wt', branch: 'fix-ci' },
        }),
        'pr-9517',
      ),
    ).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(sessionMatchesGitQuery(session({}), 'anything')).toBe(false);
  });
});
