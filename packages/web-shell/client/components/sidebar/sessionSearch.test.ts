/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  mergeSessionContentHits,
  sessionMatchesGitQuery,
  sessionMatchesSource,
} from './sessionSearch';

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

describe('sessionMatchesSource', () => {
  it('scopes the channel tab to channel-source sessions', () => {
    expect(
      sessionMatchesSource(session({ sourceType: 'channel' }), 'channel'),
    ).toBe(true);
    expect(sessionMatchesSource(session({}), 'channel')).toBe(false);
    expect(
      sessionMatchesSource(session({ sourceType: 'default' }), 'channel'),
    ).toBe(false);
  });

  it('scopes the default tab to unattributed and default-source sessions', () => {
    expect(sessionMatchesSource(session({}), 'default')).toBe(true);
    expect(
      sessionMatchesSource(session({ sourceType: 'default' }), 'default'),
    ).toBe(true);
    expect(
      sessionMatchesSource(session({ sourceType: 'channel' }), 'default'),
    ).toBe(false);
  });

  it('lists everything without an active filter', () => {
    expect(
      sessionMatchesSource(session({ sourceType: 'channel' }), undefined),
    ).toBe(true);
    expect(sessionMatchesSource(session({}), undefined)).toBe(true);
  });
});

describe('mergeSessionContentHits', () => {
  function hit(
    sessionId: string,
    overrides: Partial<DaemonSessionSummary> = {},
  ): { session: DaemonSessionSummary; snippet: string } {
    return {
      session: session({ sessionId, ...overrides }),
      snippet: `hit for ${sessionId}`,
    };
  }

  it('returns the local matches unchanged when there are no hits', () => {
    const local = [session({ sessionId: 'a' })];
    expect(mergeSessionContentHits([], local, new Map(), undefined)).toEqual(
      local,
    );
  });

  it('appends ghost hits after local matches in server order', () => {
    const hits = new Map([
      ['g1', hit('g1')],
      ['g2', hit('g2')],
    ]);
    const merged = mergeSessionContentHits(
      [],
      [session({ sessionId: 'a' })],
      hits,
      undefined,
    );
    expect(merged.map((s) => s.sessionId)).toEqual(['a', 'g1', 'g2']);
  });

  it('keeps the catalog entry for a hit the loaded catalog carries', () => {
    const catalogEntry = session({
      sessionId: 's1',
      displayName: 'live catalog name',
      isPinned: true,
    });
    const merged = mergeSessionContentHits(
      [catalogEntry],
      [],
      new Map([['s1', hit('s1', { displayName: 'stale search name' })]]),
      undefined,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(catalogEntry);
  });

  it('renders a session matched by both paths exactly once', () => {
    const catalogEntry = session({ sessionId: 's1', displayName: 'qdrant' });
    const local = [catalogEntry];
    const merged = mergeSessionContentHits(
      [catalogEntry],
      local,
      new Map([['s1', hit('s1')]]),
      undefined,
    );
    expect(merged).toHaveLength(1);
  });

  it('drops ghost hits outside the source scope but keeps scoped ones', () => {
    const hits = new Map([
      ['def', hit('def')],
      ['chan', hit('chan', { sourceType: 'channel' })],
    ]);
    const merged = mergeSessionContentHits([], [], hits, 'channel');
    expect(merged.map((s) => s.sessionId)).toEqual(['chan']);
  });

  it('applies the mapSession overlay to ghost hits', () => {
    const merged = mergeSessionContentHits(
      [],
      [],
      new Map([['g1', hit('g1')]]),
      undefined,
      (s) => ({ ...s, isPinned: true }),
    );
    expect(merged[0]?.isPinned).toBe(true);
  });
});
