import { describe, expect, it } from 'vitest';
import type { DaemonGitCommitDetail } from '@qwen-code/sdk/daemon';
import {
  buildCommitFallbackUnits,
  commitFallbackRange,
} from './change-overview';

function detail(
  overrides: Partial<DaemonGitCommitDetail> = {},
): DaemonGitCommitDetail {
  return {
    v: 1,
    workspaceCwd: '/work',
    available: true,
    files: [{ path: 'a.ts', added: 3, removed: 1, isBinary: false }],
    filesCount: 1,
    linesAdded: 3,
    linesRemoved: 1,
    ...overrides,
  };
}

describe('commitFallbackRange', () => {
  it('scopes to commits after the latest bound PR head', () => {
    expect(commitFallbackRange('abc1234', 'origin/main')).toBe('abc1234..HEAD');
  });

  it('falls back to the base branch when there is no bound PR', () => {
    expect(commitFallbackRange(undefined, 'origin/main')).toBe(
      'origin/main..HEAD',
    );
  });

  it('returns undefined when neither a PR head nor a base branch is known', () => {
    expect(commitFallbackRange(undefined, undefined)).toBeUndefined();
  });
});

describe('buildCommitFallbackUnits', () => {
  const entries = [
    { sha: 'c3', shortSha: 'c3', subject: 'third', parents: ['c2'] },
    { sha: 'c2', shortSha: 'c2', subject: 'second', parents: ['c1'] },
    { sha: 'c1', shortSha: 'c1', subject: 'first', parents: [] },
  ];

  it('maps entries with detail into commit units', () => {
    const details = new Map([
      ['c3', detail()],
      ['c2', detail({ linesAdded: 5, linesRemoved: 0 })],
    ]);
    const units = buildCommitFallbackUnits(entries, details);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      kind: 'commit',
      id: 'commit:c3',
      sha: 'c3',
      subject: 'third',
      additions: 3,
      deletions: 1,
      files: [{ path: 'a.ts', additions: 3, deletions: 1 }],
    });
    expect(units[1]).toMatchObject({ id: 'commit:c2', additions: 5 });
  });

  it('skips merge commits', () => {
    const mergeEntries = [
      { sha: 'm1', shortSha: 'm1', subject: 'merge', parents: ['a', 'b'] },
      ...entries,
    ];
    const details = new Map([
      ['m1', detail()],
      ['c3', detail()],
    ]);
    const units = buildCommitFallbackUnits(mergeEntries, details);
    expect(units.map((unit) => unit.id)).toEqual(['commit:c3']);
  });

  it('skips commits whose detail is missing or unavailable', () => {
    const details = new Map([
      ['c3', detail({ available: false })],
      ['c2', detail()],
    ]);
    const units = buildCommitFallbackUnits(entries, details);
    expect(units.map((unit) => unit.id)).toEqual(['commit:c2']);
  });

  it('returns an empty list when there are no entries', () => {
    expect(buildCommitFallbackUnits([], new Map())).toEqual([]);
  });
});
