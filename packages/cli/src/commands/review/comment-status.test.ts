/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  csGhMock,
  csGhApiAllMock,
  csCurrentUserMock,
  csEnsureAuthenticatedMock,
  csSetGhHostMock,
  csGitOptMock,
  csWorktreePathMock,
  csWriteFileSyncMock,
  csMkdirSyncMock,
  csStdoutMock,
} = vi.hoisted(() => ({
  csGhMock: vi.fn(),
  csGhApiAllMock: vi.fn(),
  csCurrentUserMock: vi.fn(),
  csEnsureAuthenticatedMock: vi.fn(),
  csSetGhHostMock: vi.fn(),
  csGitOptMock: vi.fn(),
  csWorktreePathMock: vi.fn(),
  csWriteFileSyncMock: vi.fn(),
  csMkdirSyncMock: vi.fn(),
  csStdoutMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    gh: csGhMock,
    ghApiAll: csGhApiAllMock,
    currentUser: csCurrentUserMock,
    ensureAuthenticated: csEnsureAuthenticatedMock,
    setGhHost: csSetGhHostMock,
  };
});
vi.mock('./lib/git.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, gitOpt: csGitOptMock };
});
vi.mock('./lib/paths.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, worktreePath: csWorktreePathMock };
});
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: csStdoutMock,
  writeStderrLine: csStdoutMock,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    mkdirSync: csMkdirSyncMock,
    writeFileSync: csWriteFileSyncMock,
  };
  return { ...mock, default: mock };
});

import {
  buildThreadStatuses,
  summarizeThreads,
  commentStatusCommand,
  type CodeChangeProbe,
  type RawStatusComment,
} from './comment-status.js';

const noChange: CodeChangeProbe = () => ({
  changed: false,
  touchedBy: [],
  touchedByTotal: 0,
});

const comment = (over: Partial<RawStatusComment> & { id: number }) =>
  ({
    user: { login: 'reviewer' },
    body: 'looks odd',
    path: 'src/a.ts',
    line: 10,
    original_line: 10,
    commit_id: 'headsha',
    original_commit_id: 'oldsha',
    created_at: '2026-07-24T10:00:00Z',
    subject_type: 'line',
    ...over,
  }) as RawStatusComment;

describe('buildThreadStatuses — thread grouping', () => {
  it('groups nested reply chains under the root and sorts replies by id', () => {
    const threads = buildThreadStatuses(
      [
        comment({ id: 1 }),
        comment({ id: 3, in_reply_to_id: 2, user: { login: 'author' } }),
        comment({ id: 2, in_reply_to_id: 1 }),
      ],
      'author',
      noChange,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].rootId).toBe(1);
    expect(threads[0].replies.map((r) => r.id)).toEqual([2, 3]);
    expect(threads[0].participants).toEqual(['reviewer', 'author']);
  });

  it('drops replies whose root was deleted, same as pr-context renders', () => {
    const threads = buildThreadStatuses(
      [comment({ id: 5, in_reply_to_id: 999 })],
      'author',
      noChange,
    );
    expect(threads).toHaveLength(0);
  });

  it('marks the attribution-off posted shape as a blocker, same as pr-context', () => {
    // Parity with the context file's re-check section: a Critical posted
    // without attribution carries its severity only in the invisible
    // marker, and only the reviewing account's markers count.
    const [own] = buildThreadStatuses(
      [
        comment({
          id: 1,
          user: { login: 'qwen-code-ci-bot' },
          body: 'the guard checks the wrong variable\n\n<!-- qwen-review critical -->',
        }),
      ],
      'author',
      noChange,
      'qwen-code-ci-bot',
    );
    expect(own.isBlocker).toBe(true);

    const [planted] = buildThreadStatuses(
      [
        comment({
          id: 1,
          user: { login: 'someone-else' },
          body: '<!-- qwen-review critical -->',
        }),
      ],
      'author',
      noChange,
      'qwen-code-ci-bot',
    );
    expect(planted.isBlocker).toBe(false);
  });

  it('fails closed on an unresolved identity — a matching author is not enough', () => {
    // The marker disjunct must never fire with an empty `me` — exactly
    // the state a failed identity lookup used to swallow silently, where a
    // planted marker from a ghost or deleted author would otherwise
    // promote to a blocker.
    const [t] = buildThreadStatuses(
      [
        comment({
          id: 1,
          user: { login: 'qwen-code-ci-bot' },
          body: 'the guard checks the wrong variable\n\n<!-- qwen-review critical -->',
        }),
      ],
      'author',
      noChange,
      '',
    );
    expect(t.isBlocker).toBe(false);
  });

  it('survives a reply cycle without hanging', () => {
    const threads = buildThreadStatuses(
      [
        comment({ id: 1, in_reply_to_id: 2 }),
        comment({ id: 2, in_reply_to_id: 1 }),
      ],
      'author',
      noChange,
    );
    // Both point at each other; neither is a root. Nothing to report, but
    // the walk must terminate.
    expect(threads).toHaveLength(0);
  });

  it('sorts threads by path, then original line, then id', () => {
    const threads = buildThreadStatuses(
      [
        comment({ id: 3, path: 'src/b.ts', original_line: 1 }),
        comment({ id: 2, path: 'src/a.ts', original_line: 20 }),
        comment({ id: 1, path: 'src/a.ts', original_line: 5 }),
      ],
      'author',
      noChange,
    );
    expect(threads.map((t) => t.rootId)).toEqual([1, 2, 3]);
  });
});

describe('buildThreadStatuses — anchor status', () => {
  it('marks a line comment with null line as outdated', () => {
    const [t] = buildThreadStatuses(
      [comment({ id: 1, line: null })],
      'author',
      noChange,
    );
    expect(t.anchor.outdated).toBe(true);
    expect(t.anchor.originalLine).toBe(10);
  });

  it('never marks a file-level comment as outdated', () => {
    const [t] = buildThreadStatuses(
      [
        comment({
          id: 1,
          line: null,
          original_line: null,
          subject_type: 'file',
        }),
      ],
      'author',
      noChange,
    );
    expect(t.anchor.outdated).toBe(false);
    expect(t.anchor.isFileLevel).toBe(true);
  });

  it('anchors code drift to original_commit_id, falling back to commit_id', () => {
    const seen: Array<string | undefined> = [];
    const probe: CodeChangeProbe = (_path, since) => {
      seen.push(since);
      return { changed: 'unknown', touchedBy: [], touchedByTotal: 0 };
    };
    buildThreadStatuses(
      [
        comment({ id: 1 }),
        comment({ id: 2, original_commit_id: undefined }),
        comment({ id: 3, original_commit_id: undefined, commit_id: undefined }),
      ],
      'author',
      probe,
    );
    expect(seen).toEqual(['oldsha', 'headsha', undefined]);
  });
});

describe('buildThreadStatuses — signals', () => {
  it('flags a blocker body and threads the probe result through', () => {
    const probe: CodeChangeProbe = () => ({
      changed: true,
      touchedBy: ['abc1234', 'def5678'],
      touchedByTotal: 12,
    });
    const [t] = buildThreadStatuses(
      [comment({ id: 1, body: '🔴 Finding 1 — poll loop wedges (blocker)' })],
      'author',
      probe,
    );
    expect(t.isBlocker).toBe(true);
    expect(t.code).toEqual({
      changedSinceComment: true,
      touchedBy: ['abc1234', 'def5678'],
      touchedByTotal: 12,
      staleWorktree: false,
    });
  });

  it('does not flag a negated blocker mention', () => {
    // The body must contain a phrase carriesBlockerSignal actually MATCHES so
    // the negation branch is exercised: "blocking" hits /\bblocking\b/, and
    // the leading "No " must suppress it. (The bare plural "blockers" matches
    // no pattern at all, which would test nothing.)
    const [negated] = buildThreadStatuses(
      [comment({ id: 1, body: 'No blocking issues here, just a nit.' })],
      'author',
      noChange,
    );
    expect(negated.isBlocker).toBe(false);
    // Control: the same signal un-negated IS flagged, proving the false above
    // is the negation logic and not a pattern that never fired.
    const [asserted] = buildThreadStatuses(
      [comment({ id: 2, body: 'This is a blocking defect.' })],
      'author',
      noChange,
    );
    expect(asserted.isBlocker).toBe(true);
  });

  it('never reports authorReplied for a ghost author matching a ghost replier', () => {
    // A deleted PR-author account and a deleted reply account both fall back
    // to '' — without the guard they match each other.
    const [t] = buildThreadStatuses(
      [comment({ id: 1 }), comment({ id: 2, in_reply_to_id: 1, user: null })],
      '',
      noChange,
    );
    expect(t.authorReplied).toBe(false);
  });

  it('detects a PR-author reply case-insensitively', () => {
    const threads = buildThreadStatuses(
      [
        comment({ id: 1 }),
        comment({ id: 2, in_reply_to_id: 1, user: { login: 'OrbitZore' } }),
        comment({ id: 3 }),
      ],
      'orbitzore',
      noChange,
    );
    const byRoot = new Map(threads.map((t) => [t.rootId, t]));
    expect(byRoot.get(1)!.authorReplied).toBe(true);
    expect(byRoot.get(3)!.authorReplied).toBe(false);
  });
});

describe('buildThreadStatuses — own pathless summary', () => {
  it('does not promote a pathless own-account summary to a blocker', () => {
    // Aone posts the review body as a pathless global comment, and compose
    // renders body-listed Criticals with the literal **[Critical]** prefix.
    // carriesBlockerSignal's ungated channel would promote it — but a
    // pathless thread never goes outdated and gives Step 6 no location to
    // re-read, so the re-check can never rule it fixed: the pipeline would
    // manufacture a permanent blocker every round. Pathless roots authored
    // by the reviewing account must stay out of blocker promotion.
    const [summary] = buildThreadStatuses(
      [
        comment({
          id: 500,
          user: { login: 'qwen-code-ci-bot' },
          body: '**[Critical]** R1-1: the guard dereferences null',
          path: undefined,
          line: null,
          subject_type: 'file',
        }),
      ],
      'author',
      noChange,
      'qwen-code-ci-bot',
    );
    expect(summary.isBlocker).toBe(false);
    expect(summary.path).toBe('');
  });

  it('still promotes a pathless blocker from a different account', () => {
    // The exclusion targets the pipeline's own summary only; a human's
    // pathless blocker is a genuine concern and keeps its promotion.
    const [human] = buildThreadStatuses(
      [
        comment({
          id: 1,
          user: { login: 'a-human' },
          body: 'This is a blocking defect.',
          path: undefined,
          line: null,
          subject_type: 'file',
        }),
      ],
      'author',
      noChange,
      'qwen-code-ci-bot',
    );
    expect(human.isBlocker).toBe(true);
  });
});

describe('summarizeThreads', () => {
  it('counts each status dimension once per thread', () => {
    const probe: CodeChangeProbe = (path) =>
      path === 'src/changed.ts'
        ? { changed: true, touchedBy: ['abc1234'], touchedByTotal: 1 }
        : { changed: 'unknown', touchedBy: [], touchedByTotal: 0 };
    const threads = buildThreadStatuses(
      [
        comment({ id: 1, path: 'src/changed.ts', body: 'this is a blocker' }),
        comment({ id: 2, in_reply_to_id: 1, user: { login: 'author' } }),
        comment({ id: 3, path: 'src/other.ts', line: null }),
      ],
      'author',
      probe,
    );
    expect(summarizeThreads(threads)).toEqual({
      threads: 2,
      outdated: 1,
      blockers: 1,
      changedSinceComment: 1,
      changeUnknown: 1,
      withReplies: 1,
      authorReplied: 1,
    });
  });
});

describe('commentStatusCommand handler — identity fail-closed', () => {
  // The same gate pr-context applies, probed at the handler level: both
  // unknown-identity shapes — a thrown lookup AND an empty login — must
  // degrade the report to an \`error\` a consumer sees, never a
  // complete-looking index that silently undercounts blockers.
  const MARKER_COMMENT = {
    id: 1,
    user: { login: 'review-bot' },
    path: 'a.ts',
    line: 3,
    body: 'the guard checks the wrong variable\n\n<!-- qwen-review critical -->',
    commit_id: 'headsha',
    original_commit_id: 'headsha',
  };

  const runHandler = (): Promise<void> =>
    Promise.resolve(
      commentStatusCommand.handler({
        pr_number: '42',
        owner_repo: 'o/r',
        out: '/tmp/comment-status/report.json',
      } as never) as void,
    );

  const writtenReport = () =>
    JSON.parse(csWriteFileSyncMock.mock.calls[0]?.[1] as string) as {
      error?: string;
      summary?: { blockers: number };
    };

  beforeEach(() => {
    csGhMock.mockClear();
    csGhMock.mockReturnValue(
      JSON.stringify({ author: { login: 'author' }, headRefOid: 'headsha' }),
    );
    csGhApiAllMock.mockClear();
    csGhApiAllMock.mockReturnValue([MARKER_COMMENT]);
    csCurrentUserMock.mockClear();
    csCurrentUserMock.mockReturnValue('review-bot');
    csGitOptMock.mockClear();
    csGitOptMock.mockReturnValue(null);
    csWorktreePathMock.mockClear();
    csWorktreePathMock.mockReturnValue('/tmp/no-such-worktree');
    csWriteFileSyncMock.mockClear();
    csStdoutMock.mockClear();
  });

  it('refuses the report when the login is EMPTY while a critical marker is posted', async () => {
    // Exit-0-with-empty-output is a stubbed or proxied gh, not a
    // confirmed identity: with `me = ''` the marker disjunct never fires
    // and the blocker index undercounts while reading as complete.
    csCurrentUserMock.mockReturnValue('');
    await runHandler();
    expect(writtenReport().error).toMatch(
      /cannot determine the reviewing account/,
    );
  });

  it('refuses the report when the lookup throws while a critical marker is posted', async () => {
    csCurrentUserMock.mockImplementation(() => {
      throw new Error('network down');
    });
    await runHandler();
    expect(writtenReport().error).toMatch(
      /cannot determine the reviewing account/,
    );
  });

  it('proceeds best-effort when the login is empty and no marker is posted', async () => {
    csGhApiAllMock.mockReturnValue([
      { ...MARKER_COMMENT, body: 'plain prose' },
    ]);
    csCurrentUserMock.mockReturnValue('');
    await runHandler();
    expect(writtenReport().error).toBeUndefined();
  });

  it('counts the marker as a blocker when identity resolves', async () => {
    await runHandler();
    const report = writtenReport();
    expect(report.error).toBeUndefined();
    expect(report.summary?.blockers).toBe(1);
  });
});
