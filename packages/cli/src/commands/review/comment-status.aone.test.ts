/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Aone backing of `comment-status`: the handler routes an Aone target
// (an Aone `--host`, or an Aone-origin cwd) at the a1 reads instead of gh,
// maps the flat a1 comment list (parentNoteId threading, explicit
// `outdated`, NO commit anchors) into the same report contract the GitHub
// path writes, and keeps the degradation harness (an index failure is a
// warning + empty report, never a dead review).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAoneAuthenticated: vi.fn(),
  getMrAuthorAndHead: vi.fn(),
  listMrComments: vi.fn((): unknown[] => []),
  aoneWhoami: vi.fn(() => 'reviewer'),
  gitOpt: vi.fn((..._a: string[]): string | null => null),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeStdoutLine: vi.fn(),
}));

vi.mock('./lib/platform/aone-client.js', () => ({
  ensureAoneAuthenticated: mocks.ensureAoneAuthenticated,
}));

vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/aone.js')>();
  return {
    ...actual,
    getMrAuthorAndHead: mocks.getMrAuthorAndHead,
    listMrComments: mocks.listMrComments,
    aoneWhoami: mocks.aoneWhoami,
  };
});

vi.mock('./lib/git.js', () => ({
  gitOpt: mocks.gitOpt,
}));

// PARTIAL, not a replacement: only `worktreePath` is being steered, and a
// total mock silently deletes every other export — which broke this suite the
// moment the handler's import graph reached `REVIEW_TMP_DIR` through the
// worktree gate. `importOriginal` keeps the module's real surface behind the
// one value the fixtures choose.
vi.mock('./lib/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/paths.js')>()),
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

const { commentStatusCommand, aoneCommentToStatusComment } = await import(
  './comment-status.js'
);

async function run(args?: Record<string, unknown>) {
  const handler = commentStatusCommand.handler;
  if (!handler) throw new Error('handler missing');
  await handler({
    _: [],
    $0: 'qwen',
    pr_number: '29295886',
    owner_repo: 'maxcompute/odps_src',
    out: '/repo/.qwen/tmp/qwen-review-pr-29295886-comment-status.json',
    host: 'gitlab.alibaba-inc.com',
    ...args,
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

describe('comment-status handler (Aone backing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history only — without this, the throwing
    // auth stub installed by the degradation test below leaks into every
    // later test that exercises the authenticated path.
    mocks.ensureAoneAuthenticated.mockReset();
    mocks.listMrComments.mockReturnValue([]);
    mocks.getMrAuthorAndHead.mockReturnValue({
      author: 'mr-author',
      headSha: 'headA',
    });
    mocks.aoneWhoami.mockReturnValue('reviewer');
    // Worktree present, HEAD matching the (stable) live head: no drift.
    mocks.gitOpt.mockImplementation((...args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'true';
      if (args.includes('rev-parse')) return 'headA';
      return null;
    });
  });

  it('routes an Aone --host at the a1 reads and writes the report', async () => {
    await run();
    const report = reportWritten();
    expect(report.prNumber).toBe('29295886');
    expect(report.prAuthor).toBe('mr-author');
    expect(report.liveHeadSha).toBe('headA');
    expect(report.headDrift).toBe(false);
    expect(mocks.listMrComments).toHaveBeenCalledWith(
      29295886,
      'maxcompute/odps_src',
    );
  });

  it('groups a1 replies under their parentNoteId root', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 10,
        note: '**[Critical]** null deref',
        path: 'a.ts',
        line: 4,
        author: { username: 'reviewer' },
      },
      {
        id: 11,
        note: 'fixed in the amend',
        parentNoteId: 10,
        author: { username: 'mr-author' },
      },
    ]);
    await run();
    const report = reportWritten();
    expect(report.inlineComments).toBe(2);
    expect(report.summary.threads).toBe(1);
    const thread = report.threads[0];
    expect(thread.rootId).toBe(10);
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].author).toBe('mr-author');
    expect(thread.authorReplied).toBe(true);
  });

  it('maps a1 `outdated` onto the report outdated flag (line semantics)', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 20,
        note: 'stale anchor',
        path: 'a.ts',
        line: 4,
        outdated: true,
        author: { username: 'someone' },
      },
      {
        id: 21,
        note: 'live anchor',
        path: 'b.ts',
        line: 7,
        outdated: false,
        author: { username: 'someone' },
      },
    ]);
    await run();
    const report = reportWritten();
    const thread = (id: number) =>
      report.threads.find((t: { rootId: number }) => t.rootId === id);
    expect(thread(20).anchor.outdated).toBe(true);
    expect(thread(20).anchor.line).toBeNull();
    expect(thread(21).anchor.outdated).toBe(false);
    expect(thread(21).anchor.line).toBe(7);
    // The live shape (path + line, not outdated) is line-scoped — every
    // posted line-anchored Aone finding rides this branch.
    expect(thread(21).anchor.isFileLevel).toBe(false);
    expect(report.summary.outdated).toBe(1);
  });

  it('treats pathless a1 comments (global/summary) as file-level, never outdated', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 30,
        note: 'an MR-level summary comment',
        author: { username: 'someone' },
      },
      {
        // The platform flag on a pathless comment must not fabricate a
        // rewrite — there is no path to be outdated against.
        id: 31,
        note: 'an MR-level summary the platform calls outdated',
        outdated: true,
        author: { username: 'someone' },
      },
    ]);
    await run();
    const report = reportWritten();
    const thread = (id: number) =>
      report.threads.find((t: { rootId: number }) => t.rootId === id);
    expect(thread(30).anchor.isFileLevel).toBe(true);
    expect(thread(30).anchor.outdated).toBe(false);
    expect(thread(31).anchor.isFileLevel).toBe(true);
    expect(thread(31).anchor.outdated).toBe(false);
  });

  it('degrades code facts to unknown — a1 comments carry no commit anchor', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 40,
        note: 'a finding',
        path: 'a.ts',
        line: 4,
        author: { username: 'someone' },
      },
    ]);
    await run();
    const report = reportWritten();
    expect(report.threads[0].code.changedSinceComment).toBe('unknown');
    expect(report.threads[0].code.touchedBy).toEqual([]);
    // The git probe was never handed a SHA to test ancestry against.
    const logCalls = mocks.gitOpt.mock.calls.filter((c) => c.includes('log'));
    expect(logCalls).toEqual([]);
  });

  it('flags a worktree that lags the live head', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 50,
        note: 'a finding',
        path: 'a.ts',
        line: 4,
        author: { username: 'someone' },
      },
    ]);
    mocks.getMrAuthorAndHead.mockReturnValue({
      author: 'mr-author',
      headSha: 'headB',
    });
    await run();
    const report = reportWritten();
    expect(report.headDrift).toBe(true);
    expect(report.threads[0].code.staleWorktree).toBe(true);
    expect(warnings().join('\n')).toContain('worktree HEAD');
  });

  it('flags a head that moved during the comments fetch', async () => {
    mocks.gitOpt.mockImplementation((...args: string[]) =>
      args.includes('rev-parse') ? 'headB' : null,
    );
    mocks.getMrAuthorAndHead
      .mockReturnValueOnce({ author: 'mr-author', headSha: 'headA' })
      .mockReturnValueOnce({ author: 'mr-author', headSha: 'headB' });
    await run();
    const report = reportWritten();
    expect(report.headMovedDuringFetch).toBe(true);
    expect(report.liveHeadBefore).toBe('headA');
    expect(report.liveHeadSha).toBe('headB');
  });

  it('keeps the comments when the second head sample fails', async () => {
    mocks.listMrComments.mockReturnValue([
      { id: 60, note: 'a finding', path: 'a.ts', line: 4 },
    ]);
    mocks.getMrAuthorAndHead
      .mockReturnValueOnce({ author: 'mr-author', headSha: 'headA' })
      .mockImplementationOnce(() => {
        throw new Error('Command failed: a1 repo mr view — network gone');
      });
    await run();
    const report = reportWritten();
    expect(report.error).toBeUndefined();
    expect(report.inlineComments).toBe(1);
    expect(report.liveHeadSha).toBe('headA');
    expect(report.headMovedDuringFetch).toBe(false);
  });

  it('fails closed when whoami is unavailable and a root carries a critical marker', async () => {
    mocks.aoneWhoami.mockImplementation(() => {
      throw new Error('Command failed: a1 auth whoami');
    });
    // A marker-carrying root needs a real marker string; build one via the
    // same constant the writer uses.
    const { commentMarker } = await import('./lib/review-footer.js');
    mocks.listMrComments.mockReturnValue([
      {
        id: 70,
        note: `a finding\n\n${commentMarker('critical')}`,
        path: 'a.ts',
        line: 4,
        author: { username: 'reviewer' },
      },
    ]);
    await run();
    const report = reportWritten();
    expect(report.error).toContain('cannot determine the reviewing account');
    expect(warnings().join('\n')).toContain('comment-status failed');
  });

  it('reuses the gate account when whoami fails after the auth gate', async () => {
    // The gate already answered whoami; a transient a1 outage AFTER it must
    // not re-run the lookup inside the identity gate and discard a fully
    // fetched index over a query whose answer was already in hand.
    mocks.ensureAoneAuthenticated.mockReturnValue('reviewer');
    mocks.aoneWhoami.mockImplementation(() => {
      throw new Error('Command failed: a1 auth whoami — connection reset');
    });
    const { commentMarker } = await import('./lib/review-footer.js');
    mocks.listMrComments.mockReturnValue([
      {
        id: 70,
        note: `a finding\n\n${commentMarker('critical')}`,
        path: 'a.ts',
        line: 4,
        author: { username: 'reviewer' },
      },
    ]);
    await run();
    const report = reportWritten();
    expect(report.error).toBeUndefined();
    expect(report.inlineComments).toBe(1);
    expect(report.threads[0].isBlocker).toBe(true);
    expect(mocks.aoneWhoami).not.toHaveBeenCalled();
  });

  it('degrades to an empty report when a1 auth fails', async () => {
    mocks.ensureAoneAuthenticated.mockImplementation(() => {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    });
    await expect(run()).resolves.toBeUndefined();
    const report = reportWritten();
    expect(report.error).toContain('a1 CLI not found');
    expect(report.threads).toEqual([]);
    expect(report.prAuthor).toBeNull();
    expect(report.headDrift).toBe(false);
    expect(warnings().join('\n')).toContain('comment-status failed');
  });

  it('rejects a non-integer MR id (caller error, not runtime degradation)', async () => {
    await expect(run({ pr_number: 'not-a-number' })).rejects.toThrow(
      /positive integer/,
    );
  });

  it('rejects pr_number tokens that coerce to a DIFFERENT MR id', async () => {
    // Number() alone accepts these, so the runner would query one MR while
    // the worktree path and the report carry the caller's label — the
    // exact label/content divergence fetch-pr's /^[1-9]\d*$/ grammar
    // refuses (its validation comment names the '1e3' case).
    for (const token of ['012', '1e3', '0x1f', ' 12', '12.0']) {
      await expect(run({ pr_number: token })).rejects.toThrow(
        /positive integer/,
      );
    }
  });

  it('rejects an owner_repo with no slash', async () => {
    await expect(run({ owner_repo: 'ownerrepo' })).rejects.toThrow(
      /owner\/repo/,
    );
  });
});

describe('aoneCommentToStatusComment (a1 → GitHub-shaped input)', () => {
  it('falls back to `body` when `note` is absent (shape-drift tolerance)', () => {
    const mapped = aoneCommentToStatusComment({
      id: 1,
      body: 'the comment text',
      path: 'a.ts',
      line: 4,
      author: { username: 'someone' },
    });
    expect(mapped.body).toBe('the comment text');
  });

  it('prefers `note` over `body` when BOTH keys are present', () => {
    // Twin of the presubmit mapper pin: an inverted `c.body ?? c.note`
    // reads '' when a1 serializes the tolerated empty body as `body: ''`
    // (`??` does not coalesce empty strings), blanking the recognition
    // signals the thread classification keys on.
    const mapped = aoneCommentToStatusComment({
      id: 5,
      note: '**[Critical]** both keys',
      body: '',
      path: 'a.ts',
      line: 42,
      author: { username: 'someone' },
    });
    expect(mapped.body).toBe('**[Critical]** both keys');
  });

  it('a path-bearing, line-less, NON-outdated comment is file-level, not outdated', () => {
    // The core derives `outdated` from a null line on non-file-level
    // threads; riding `line` here would fabricate a rewrite the platform
    // never reported.
    const mapped = aoneCommentToStatusComment({
      id: 2,
      note: 'a file-scoped discussion',
      path: 'a.ts',
      author: { username: 'someone' },
    });
    expect(mapped.subject_type).toBe('file');
  });

  it('an OUTDATED comment stays line-scoped so the core computes outdated', () => {
    const mapped = aoneCommentToStatusComment({
      id: 3,
      note: 'an anchored finding',
      path: 'a.ts',
      line: 4,
      outdated: true,
      author: { username: 'someone' },
    });
    expect(mapped.subject_type).toBe('line');
    expect(mapped.line).toBeNull();
    expect(mapped.original_line).toBe(4);
  });
});
