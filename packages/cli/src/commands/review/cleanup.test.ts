// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn((): string => {
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
  ghApiAll: vi.fn((): unknown[] => []),
  currentUser: vi.fn(() => 'reviewer'),
  setGhHost: vi.fn(),
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
  runCleanup,
  type RawIssueComment,
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

  it('does not resolve the current user when the window has no comments at all', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([]);

    runCleanup('pr-123');

    expect(mocks.currentUser).not.toHaveBeenCalled();
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
