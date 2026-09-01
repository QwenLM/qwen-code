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
  it('matches any bound PR number with and without #', () => {
    const s = session({
      prs: [
        { number: 9500, url: 'https://github.com/o/r/pull/9500' },
        { number: 9517, url: 'https://github.com/o/r/pull/9517' },
      ],
    });
    expect(sessionMatchesGitQuery(s, '9517')).toBe(true);
    expect(sessionMatchesGitQuery(s, '#9517')).toBe(true);
    // Older bindings match too — stacked PRs stay findable.
    expect(sessionMatchesGitQuery(s, '9500')).toBe(true);
    expect(sessionMatchesGitQuery(s, '#9500')).toBe(true);
  });

  it('matches the number of an issue a bound PR closes', () => {
    const s = session({
      prs: [
        {
          number: 9517,
          url: 'https://github.com/o/r/pull/9517',
          issues: [{ number: 7, url: 'https://github.com/o/r/issues/7' }],
        },
      ],
    });
    expect(sessionMatchesGitQuery(s, '7')).toBe(true);
    expect(sessionMatchesGitQuery(s, '#7')).toBe(true);
    expect(sessionMatchesGitQuery(s, '70')).toBe(false);
  });

  it('does not partially match the PR number', () => {
    const s = session({
      prs: [{ number: 9517, url: 'https://github.com/o/r/pull/9517' }],
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
