// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn((_path: string): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  rmSync: vi.fn(),
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  clearReviewWorktreeLease: vi.fn(),
  refExists: vi.fn(() => true),
  releaseWorktree: vi.fn(() => ({
    existed: false,
    freed: false,
    reason: undefined,
  })),
  ghApiAll: vi.fn((_path: string): unknown[] => []),
  currentUser: vi.fn(() => 'reviewer'),
  setGhHost: vi.fn(),
  getGhHost: vi.fn((): string | undefined => undefined),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, execFileSync: mocks.execFileSync },
    execFileSync: mocks.execFileSync,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mocks.existsSync,
      readdirSync: mocks.readdirSync,
      readFileSync: mocks.readFileSync,
      rmSync: mocks.rmSync,
    },
    existsSync: mocks.existsSync,
    readdirSync: mocks.readdirSync,
    readFileSync: mocks.readFileSync,
    rmSync: mocks.rmSync,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.writeStdoutLine,
  writeStderrLine: mocks.writeStderrLine,
}));

vi.mock('../../services/review-worktree-lease.js', () => ({
  clearReviewWorktreeLease: mocks.clearReviewWorktreeLease,
}));

vi.mock('./lib/git.js', () => ({
  refExists: mocks.refExists,
  releaseWorktree: mocks.releaseWorktree,
}));

vi.mock('./lib/gh.js', () => ({
  ghApiAll: mocks.ghApiAll,
  currentUser: mocks.currentUser,
  setGhHost: mocks.setGhHost,
  getGhHost: mocks.getGhHost,
}));

vi.mock('./lib/paths.js', () => ({
  worktreePath: (prNumber: string) => `/repo/.qwen/tmp/review-pr-${prNumber}`,
  probeWorktreePath: (path: string) => `${path}-probe`,
  reviewBranch: (prNumber: string) => `qwen-review/pr-${prNumber}`,
  REVIEW_TMP_DIR: '/repo/.qwen/tmp',
  tmpFile: (target: string, suffix: string) =>
    `/repo/.qwen/tmp/qwen-review-${target}-${suffix}`,
  tmpPrefix: (target: string) => `qwen-review-${target}-`,
}));

import {
  findUnsanctionedIssueComments,
  findUnsanctionedReviews,
  runCleanup,
  type RawIssueComment,
  type RawReview,
} from './cleanup.js';

describe('runCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(false);
    mocks.refExists.mockReturnValue(true);
    mocks.releaseWorktree.mockReturnValue({
      existed: false,
      freed: false,
      reason: undefined,
    });
  });

  it('keeps the lease when branch deletion fails', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('branch is locked');
    });

    runCleanup('pr-123');

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'qwen-review/pr-123'],
      { stdio: 'pipe' },
    );
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete branch qwen-review/pr-123'),
    );
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
  });

  it('clears the lease when cleanup succeeds', () => {
    mocks.execFileSync.mockReturnValue(Buffer.from(''));

    runCleanup('pr-123');

    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalledWith(
      process.cwd(),
      'pr-123',
    );
  });
});

describe('findUnsanctionedIssueComments', () => {
  const since = '2026-07-24T08:00:00Z';
  const comment = (over: Partial<RawIssueComment> & { id: number }) =>
    ({
      user: { login: 'reviewer' },
      created_at: '2026-07-24T09:00:00Z',
      ...over,
    }) as RawIssueComment;

  it('keeps only the reviewing account inside the window, case-insensitively', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({ id: 1 }),
        comment({ id: 2, user: { login: 'Reviewer' } }),
        comment({ id: 3, user: { login: 'someone-else' } }),
        comment({ id: 4, created_at: '2026-07-24T07:59:59Z' }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([1, 2]);
    expect(got.edited).toEqual([]);
  });

  it('classifies a pre-window comment edited inside the window as an edit', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 5,
          created_at: '2026-07-24T07:00:00Z',
          updated_at: '2026-07-24T09:00:00Z',
        }),
        comment({
          id: 6,
          created_at: '2026-07-24T07:00:00Z',
          updated_at: '2026-07-24T07:00:00Z',
        }),
      ],
      'reviewer',
      since,
    );
    expect(got.edited.map((c) => c.id)).toEqual([5]);
    expect(got.posted).toEqual([]);
  });

  it('still flags a comment that merely QUOTES an automation marker mid-body', () => {
    // The filter is anchored to the body start: a hand-posted summary quoting
    // a marked bot comment (or hiding the marker mid-body) stays visible.
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 9,
          body: 'summary quoting:\n<!-- qwen-triage stage=1 -->',
        }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([9]);
  });

  it('drops comments carrying the repo automation marker — CI shares the bot account', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 7,
          body: '<!-- qwen-pr-precheck:manual-required -->\nchecks…',
        }),
        comment({ id: 8, body: 'a human sentence' }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([8]);
  });

  it('drops comments with no author or no timestamp instead of guessing', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({ id: 1, user: null }),
        comment({ id: 2, created_at: undefined }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted).toEqual([]);
    expect(got.edited).toEqual([]);
  });
});

describe('findUnsanctionedReviews', () => {
  const since = '2026-07-24T08:00:00Z';
  const review = (over: Partial<RawReview> & { id: number }) =>
    ({
      user: { login: 'reviewer' },
      state: 'COMMENTED',
      submitted_at: '2026-07-24T09:00:00Z',
      ...over,
    }) as RawReview;

  it('flags in-window reviews by the account that the receipt does not vouch for', () => {
    const got = findUnsanctionedReviews(
      [
        review({ id: 1 }),
        review({ id: 2, user: { login: 'someone-else' } }),
        review({ id: 3, submitted_at: '2026-07-24T07:00:00Z' }),
      ],
      'reviewer',
      since,
      new Set(),
    );
    expect(got.map((r) => r.id)).toEqual([1]);
  });

  it('excludes every receipt-vouched review id, not just the last', () => {
    // Two sanctioned submits in one window (drift restart) — both ids are on
    // the receipt, and NEITHER may be flagged.
    const got = findUnsanctionedReviews(
      [review({ id: 1 }), review({ id: 2 }), review({ id: 3 })],
      'reviewer',
      since,
      new Set([2, 3]),
    );
    expect(got.map((r) => r.id)).toEqual([1]);
  });
});

describe('runCleanup — bypass-write audit', () => {
  const fetchReport = JSON.stringify({
    prNumber: '123',
    ownerRepo: 'acme/widgets',
    fetchedAt: '2026-07-24T08:00:00Z',
    host: 'ghe.example.com',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mocks.currentUser.mockReturnValue('reviewer');
    mocks.ghApiAll.mockReturnValue([]);
  });

  it('flags reviewer issue comments posted inside the window', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([
      {
        id: 42,
        user: { login: 'reviewer' },
        created_at: '2026-07-24T09:02:32Z',
        html_url: 'https://ghe.example.com/acme/widgets/pull/123#c42',
      },
      {
        id: 43,
        user: { login: 'pr-author' },
        created_at: '2026-07-24T09:03:00Z',
      },
    ]);

    runCleanup('pr-123');

    expect(mocks.readFileSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch.json',
      'utf8',
    );
    expect(mocks.setGhHost).toHaveBeenCalledWith('ghe.example.com');
    expect(mocks.ghApiAll).toHaveBeenCalledWith(
      expect.stringContaining('repos/acme/widgets/issues/123/comments'),
    );
    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 42');
    expect(warnings.join('\n')).not.toContain('comment 43');
    expect(warnings.join('\n')).toContain('qwen review submit');
  });

  it('stays silent when the window is clean', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([
      {
        id: 7,
        user: { login: 'pr-author' },
        created_at: '2026-07-24T09:00:00Z',
      },
    ]);

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings).toEqual([]);
  });

  it('skips the audit without gh calls when the fetch report is absent or pre-fetchedAt, and names the skip', () => {
    runCleanup('pr-123'); // report missing (readFileSync throws)
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ prNumber: '123', ownerRepo: 'acme/widgets' }),
    );
    runCleanup('pr-123'); // old report without fetchedAt

    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    expect(mocks.setGhHost).not.toHaveBeenCalled();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.some((l) => l.includes('no fetch report'))).toBe(true);
    expect(notes.some((l) => l.includes('no fetchedAt'))).toBe(true);
  });

  it('skips when the fetch report names a different PR than the cleanup target', () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '999',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
      }),
    );

    runCleanup('pr-123');

    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.some((l) => l.includes('for PR 999'))).toBe(true);
  });

  it('clears any prior Enterprise host for a github.com report (host: null)', () => {
    // setGhHost(undefined) is what un-routes gh after an Enterprise review in
    // the same process; only the Enterprise fixture was asserted before.
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
        host: null,
      }),
    );
    mocks.ghApiAll.mockReturnValue([
      {
        id: 9,
        user: { login: 'reviewer' },
        created_at: '2026-07-24T09:00:00Z',
      },
    ]);

    runCleanup('pr-123');

    expect(mocks.setGhHost).toHaveBeenCalledWith(undefined);
    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 9');
  });

  it('restores the prior gh host after the audit instead of leaking the override', () => {
    // A host set before cleanup ran must be back in place afterwards — the
    // audit's Enterprise override is scoped to the audit block.
    mocks.getGhHost.mockReturnValue('prior.example.com');
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
        host: 'ghe.example.com',
      }),
    );
    mocks.ghApiAll.mockReturnValue([]);

    runCleanup('pr-123');

    // Override applied, then the prior host restored (the last call).
    expect(mocks.setGhHost).toHaveBeenCalledWith('ghe.example.com');
    expect(mocks.setGhHost).toHaveBeenLastCalledWith('prior.example.com');
  });

  it('does not resolve the current user when the window has no comments at all', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([]);

    runCleanup('pr-123');

    expect(mocks.currentUser).not.toHaveBeenCalled();
  });

  it('reaches back past the recorded opening by the clock-skew allowance', () => {
    // fetchedAt 08:00:00 → boundary 07:58:00; a comment at 07:58:30 predates
    // the recorded opening but only by less than the allowance, so a fast
    // local clock cannot hide it.
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 11,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T07:58:30Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 11');
    expect(
      String(
        mocks.ghApiAll.mock.calls.find(([p]) =>
          String(p).includes('/issues/'),
        )![0],
      ),
    ).toContain(encodeURIComponent('2026-07-24T07:58:00.000Z'));
  });

  it('audits from auditSince when drift restarts pushed fetchedAt forward', () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T10:00:00Z',
        auditSince: '2026-07-24T08:00:00Z',
        host: null,
      }),
    );
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 12,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T08:30:00Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 12');
  });

  it('renders the edited-comment warning with id, timestamp and URL through runCleanup', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 21,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T06:00:00Z',
              updated_at: '2026-07-24T09:10:00Z',
              html_url: 'https://ghe.example.com/acme/widgets/pull/123#c21',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain(
      'edited comment 21 at 2026-07-24T09:10:00Z — https://ghe.example.com/acme/widgets/pull/123#c21',
    );
  });

  it('flags an in-window review with no receipt, and spares the receipt-vouched one', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('submit-receipt.json')) {
        return JSON.stringify({ reviewId: 500 });
      }
      return fetchReport;
    });
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/reviews')
        ? [
            {
              id: 500,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:00:00Z',
            },
            {
              id: 501,
              user: { login: 'reviewer' },
              state: 'APPROVED',
              submitted_at: '2026-07-24T09:05:00Z',
              html_url: 'https://ghe.example.com/acme/widgets/pull/123#r501',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('review 501 (APPROVED)');
    expect(warnings.join('\n')).toContain('no submit receipt vouches for it');
    expect(warnings.join('\n')).not.toContain('review 500');
    // The footer leads with the benign explanation — a same-account write is
    // usually external (you, a bot, or a concurrent workflow under the same
    // login) — names the account, and qualifies the bypass claim instead of
    // asserting a gate bypass outright. A concurrent same-account write on an
    // observe-only run must not read as "you bypassed the submit gate".
    expect(warnings.join('\n')).toContain('likely cause is benign');
    // Pin the interpolation SHAPE `(${me})`, not the bare word — the header
    // also says "reviewing account", so `toContain('reviewer')` would stay
    // green even if the account name were dropped from the footer.
    expect(warnings.join('\n')).toContain('(reviewer)');
    expect(warnings.join('\n')).toMatch(/real bypass of that gate only if/);
    // The relay instruction is the sentence that actually moves the warning to
    // a human — the rest of the audit is inert without it, so pin it here.
    expect(warnings.join('\n')).toContain('Relay this warning verbatim');
  });

  it('spares every review in a multi-id receipt (two sanctioned submits in one window)', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('submit-receipt.json')) {
        return JSON.stringify({ reviewIds: [500, 502] });
      }
      return fetchReport;
    });
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/reviews')
        ? [
            {
              id: 500,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:00:00Z',
            },
            {
              id: 502,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:05:00Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    // Both are receipt-vouched → no bypass warning at all.
    expect(warnings.join('\n')).not.toContain('review 500');
    expect(warnings.join('\n')).not.toContain('review 502');
  });

  it('names each malformed-report shape and never reaches GitHub', () => {
    const cases: Array<[string, string]> = [
      ['not json at all {', 'not valid JSON'],
      [
        JSON.stringify({ fetchedAt: '2026-07-24T08:00:00Z' }),
        'missing prNumber/ownerRepo',
      ],
      [
        JSON.stringify({
          prNumber: '123',
          ownerRepo: 'evil repo/../../x',
          fetchedAt: '2026-07-24T08:00:00Z',
        }),
        'not owner/repo-shaped',
      ],
    ];
    for (const [raw, expected] of cases) {
      vi.clearAllMocks();
      mocks.readFileSync.mockReturnValue(raw);
      runCleanup('pr-123');
      expect(mocks.ghApiAll).not.toHaveBeenCalled();
      const notes = mocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('note: bypass audit skipped'));
      expect(notes.join('\n')).toContain(expected);
    }
  });

  it('distinguishes an unreadable report from an absent one', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('cannot read fetch report (EACCES)');
    expect(notes.join('\n')).not.toContain('no fetch report');
  });

  it('surfaces the first non-empty stderr line when gh fails, not the generic wrapper', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: gh api …'), {
        stderr: '\ngh: Not authenticated. Run gh auth login.\n',
      });
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('gh: Not authenticated');
  });

  it('never fails the cleanup when the audit itself fails', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });

    expect(() => runCleanup('pr-123')).not.toThrow();
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalled();
  });
});
