import { describe, expect, it } from 'vitest';
import type { DaemonGitCommitDetail } from '@qwen-code/sdk/daemon';
import {
  buildCommitFallbackUnits,
  commitFallbackRange,
  prRepoFromUrl,
  prUnavailableCauseFromError,
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

  it('treats the detached-HEAD sentinel as no baseline, not HEAD..HEAD', () => {
    // The daemon records baseBranch verbatim from the branch probe, whose
    // detached-HEAD value is the literal 'HEAD' (session.ts treats it as a
    // sentinel too). HEAD..HEAD is always empty and would silently render a
    // committing session as having no loose commits; the designed
    // recent-history walk must apply instead.
    expect(commitFallbackRange(undefined, 'HEAD')).toBeUndefined();
  });

  it('refuses a base branch the daemon range whitelist would drop', () => {
    // git permits these refs, but isSafeLogRange rejects them; composing the
    // range would make the daemon run an unscoped git log instead. Return the
    // null "skip the fallback" sentinel — distinct from the undefined
    // no-baseline case, which still walks HEAD's recent history.
    expect(commitFallbackRange(undefined, 'feat@2026')).toBeNull();
    expect(commitFallbackRange(undefined, 'user#42')).toBeNull();
    expect(commitFallbackRange(undefined, '-leading')).toBeNull();
    expect(commitFallbackRange(undefined, '分支')).toBeNull();
    // The PR-head and valid base forms must keep working.
    expect(commitFallbackRange('abc1234', undefined)).toBe('abc1234..HEAD');
    expect(commitFallbackRange(undefined, 'origin/main')).toBe(
      'origin/main..HEAD',
    );
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

  it('surfaces hiddenCount when the commit detail caps its file rows', () => {
    // A 60-file commit whose detail lists only 50 rows (the route's cap) must
    // report the 10 missing files, not silently truncate.
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/f${i}.ts`,
      added: 1,
      removed: 0,
      isBinary: false,
    }));
    const details = new Map([
      ['c3', detail({ files, filesCount: 60, linesAdded: 60 })],
    ]);
    const units = buildCommitFallbackUnits([entries[0]!], details);
    expect(units[0]).toMatchObject({
      id: 'commit:c3',
      filesCount: 60,
      hiddenCount: 10,
    });
    expect(units[0]!.files).toHaveLength(50);
  });
});

describe('prRepoFromUrl', () => {
  it('extracts host/owner/repo from a GitHub PR URL', () => {
    // The host rides through to gh --repo: dropping it would resolve the slug
    // on github.com (or GH_HOST) instead of the PR's own host.
    expect(
      prRepoFromUrl('https://github.com/QwenLM/qwen-code/pull/17378'),
    ).toBe('github.com/QwenLM/qwen-code');
  });

  it('keeps an Enterprise host (and port) instead of dropping it', () => {
    expect(prRepoFromUrl('https://ghe.corp/o/r/pull/7')).toBe('ghe.corp/o/r');
    expect(prRepoFromUrl('https://ghe.corp:8443/o/r/pull/7')).toBe(
      'ghe.corp:8443/o/r',
    );
  });

  it('accepts dotted and dashed slugs', () => {
    expect(prRepoFromUrl('https://github.com/my.org/my-repo/pull/1')).toBe(
      'github.com/my.org/my-repo',
    );
  });

  it('returns undefined for non-PR or malformed URLs', () => {
    expect(prRepoFromUrl('https://github.com/o/r')).toBeUndefined();
    expect(prRepoFromUrl('https://github.com/o/r/issues/1')).toBeUndefined();
    expect(prRepoFromUrl('not a url')).toBeUndefined();
    expect(prRepoFromUrl('')).toBeUndefined();
    // A host carrying userinfo or a scheme is not a bare hostname[:port].
    expect(prRepoFromUrl('https://user@ghe.corp/o/r/pull/7')).toBeUndefined();
  });
});

describe('prUnavailableCauseFromError', () => {
  it('classifies gh-missing, old-daemon 404, and other failures distinctly', () => {
    expect(
      prUnavailableCauseFromError({
        status: 502,
        body: { code: 'github_cli_unavailable' },
      }),
    ).toBe('cli');
    expect(prUnavailableCauseFromError({ status: 404, body: {} })).toBe(
      'route',
    );
    expect(
      prUnavailableCauseFromError({
        status: 502,
        body: { code: 'github_pr_files_failed' },
      }),
    ).toBe('error');
    expect(prUnavailableCauseFromError(new Error('network'))).toBe('error');
    expect(prUnavailableCauseFromError(undefined)).toBe('error');
  });
});

describe('buildCommitFallbackUnits binary rows', () => {
  it('carries isBinary so the panel can render a marker, not +0 -0', () => {
    const entries = [
      { sha: 'c1', shortSha: 'c1', subject: 'asset', parents: [] },
    ];
    const details = new Map([
      [
        'c1',
        detail({
          files: [{ path: 'logo.png', added: 0, removed: 0, isBinary: true }],
          filesCount: 1,
        }),
      ],
    ]);
    const units = buildCommitFallbackUnits(entries, details);
    expect(units[0]!.files[0]).toMatchObject({
      path: 'logo.png',
      isBinary: true,
    });
  });
});
