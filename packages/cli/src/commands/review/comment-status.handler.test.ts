/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Command-level tests: the pure core (comment-status.test.ts) and the real
// git probe (comment-status.integration.test.ts) are covered elsewhere; this
// file pins the handler wiring — the two head samples, the drift field and
// its warning, and that the report is written — with gh/git/fs mocked. A
// regression that reversed the drift comparison or dropped the warning would
// otherwise leave every other test green while live anchors were silently
// paired with stale worktree facts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  gh: vi.fn(),
  ghApiAll: vi.fn((_p: string): unknown[] => []),
  ensureAuthenticated: vi.fn(),
  setGhHost: vi.fn(),
  gitOpt: vi.fn((..._a: string[]): string | null => null),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeStdoutLine: vi.fn(),
}));

vi.mock('./lib/gh.js', () => ({
  gh: mocks.gh,
  ghApiAll: mocks.ghApiAll,
  ensureAuthenticated: mocks.ensureAuthenticated,
  setGhHost: mocks.setGhHost,
}));

vi.mock('./lib/git.js', () => ({
  gitOpt: mocks.gitOpt,
}));

vi.mock('./lib/paths.js', () => ({
  worktreePath: (n: string | number) => `/repo/.qwen/tmp/review-pr-${n}`,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: mocks.writeFileSync,
      mkdirSync: mocks.mkdirSync,
    },
    writeFileSync: mocks.writeFileSync,
    mkdirSync: mocks.mkdirSync,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.writeStdoutLine,
}));

const { commentStatusCommand } = await import('./comment-status.js');

async function run() {
  const handler = commentStatusCommand.handler;
  if (!handler) throw new Error('handler missing');
  await handler({
    _: [],
    $0: 'qwen',
    pr_number: '7632',
    owner_repo: 'o/r',
    out: '/repo/.qwen/tmp/qwen-review-pr-7632-comment-status.json',
  } as unknown as Parameters<typeof handler>[0]);
}

function reportWritten() {
  const call = mocks.writeFileSync.mock.calls.find(([p]) =>
    String(p).endsWith('comment-status.json'),
  );
  if (!call) throw new Error('report not written');
  return JSON.parse(String(call[1]));
}

function warnings() {
  return mocks.writeStdoutLine.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith('warning:'));
}

// gh('pr','view',…) is called for author+head, then again for the second
// head sample. This drives both from one queue.
function queueHeads(before: string, after: string, author = 'octocat') {
  let n = 0;
  mocks.gh.mockImplementation((..._args: string[]) => {
    n += 1;
    return n === 1
      ? JSON.stringify({ author: { login: author }, headRefOid: before })
      : JSON.stringify({ headRefOid: after });
  });
}

describe('comment-status handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ghApiAll.mockReturnValue([]);
    // Worktree HEAD matches the (stable) live head by default: no drift.
    mocks.gitOpt.mockImplementation((...args: string[]) =>
      args.includes('rev-parse') ? 'headA' : null,
    );
  });

  it('reports no drift and writes the report when heads all agree', async () => {
    queueHeads('headA', 'headA');
    await run();
    const report = reportWritten();
    expect(report.headDrift).toBe(false);
    expect(report.headMovedDuringFetch).toBe(false);
    expect(report.liveHeadSha).toBe('headA');
    expect(warnings()).toEqual([]);
  });

  it('flags drift and warns when the worktree lags the live head', async () => {
    queueHeads('headB', 'headB'); // live head B, worktree still at headA
    await run();
    const report = reportWritten();
    expect(report.headDrift).toBe(true);
    expect(report.headMovedDuringFetch).toBe(false);
    expect(warnings().join('\n')).toContain('worktree HEAD');
  });

  it('flags a push that raced the comments fetch, recording both samples', async () => {
    // Worktree happens to match the post-fetch head, but the head MOVED
    // during the fetch — anchor facts may be mixed across commits.
    mocks.gitOpt.mockImplementation((...args: string[]) =>
      args.includes('rev-parse') ? 'headB' : null,
    );
    queueHeads('headA', 'headB');
    await run();
    const report = reportWritten();
    expect(report.headMovedDuringFetch).toBe(true);
    expect(report.headDrift).toBe(true);
    expect(report.liveHeadBefore).toBe('headA');
    expect(report.liveHeadSha).toBe('headB');
    expect(warnings().join('\n')).toContain('moved during the comments fetch');
  });

  it('does not mark threads staleWorktree when the head raced but the worktree matches the final head', async () => {
    // Worktree is at headB (the final live head); the head merely moved
    // mid-fetch. The checkout is NOT superseded, so staleWorktree must stay
    // false even though headDrift/headMovedDuringFetch are true.
    mocks.gitOpt.mockImplementation((...args: string[]) =>
      args.includes('rev-parse') ? 'headB' : null,
    );
    // One thread so we can inspect its code facts.
    mocks.ghApiAll.mockReturnValue([
      {
        id: 1,
        user: { login: 'r' },
        path: 'a.ts',
        line: 1,
        original_commit_id: 's',
      },
    ]);
    queueHeads('headA', 'headB');
    await run();
    const report = reportWritten();
    expect(report.headMovedDuringFetch).toBe(true);
    expect(report.threads[0].code.staleWorktree).toBe(false);
  });

  it('warns and flags worktreeMissing when the worktree is absent', async () => {
    // gitOpt returns null for everything (no worktree): every thread's code
    // facts are unknown, which must not pass silently.
    mocks.gitOpt.mockReturnValue(null);
    mocks.ghApiAll.mockReturnValue([
      {
        id: 1,
        user: { login: 'r' },
        path: 'a.ts',
        line: 1,
        original_commit_id: 's',
      },
    ]);
    queueHeads('headA', 'headA');
    await run();
    const report = reportWritten();
    expect(report.worktreeMissing).toBe(true);
    expect(report.threads[0].code.changedSinceComment).toBe('unknown');
    expect(warnings().join('\n')).toContain('no worktree at');
  });
});
