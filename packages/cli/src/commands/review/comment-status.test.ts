/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildThreadStatuses,
  summarizeThreads,
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
