/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runStatus } from './status.js';
import {
  autofixPrPaths,
  writeGateCursor,
  writeState,
  type AutofixPrState,
} from './state.js';

const HEAD = 'a'.repeat(40);

describe('runStatus', () => {
  let repo: string;
  let savedCwd: string;
  let savedSession: string | undefined;

  const write = (pr: number, patch: Partial<AutofixPrState> = {}) => {
    const paths = autofixPrPaths(repo, pr);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    writeState(paths.statePath, {
      version: 1,
      sessionId: 'session-a',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: pr,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: `feat-${pr}`,
      baseRefName: 'main',
      branch: paths.branch,
      worktreePath: '/moved/away',
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      ...patch,
    });
    return paths;
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-status-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists nothing in a clone that never watched a PR', () => {
    expect(runStatus({})).toEqual({
      now: expect.any(String),
      watches: [],
    });
  });

  it('lists every watch from its files, whichever session owns it', () => {
    const item = {
      sha: HEAD,
      at: '2026-10-25T01:00:00.000Z',
      text: 'IC_9: a design call',
    };
    const seven = write(7, {
      preparedAt: '2026-10-01T00:00:00.000Z',
      pushCount: 3,
      watch: { every: 5, reply: false, instructions: 'keep the API' },
      needsHuman: [item],
    });
    write(12, { sessionId: 'session-b' });
    mkdirSync(seven.worktreePath, { recursive: true });
    // The last check is when the watch's own gate marked one, the last
    // round the prepared snapshot's time.
    writeGateCursor(seven.gatePath, {
      version: 1,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      viewer: 'me',
      prAuthor: 'me',
      headSha: HEAD,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: null,
      reportedTruncated: [],
    });
    const checked = new Date('2026-10-01T02:00:00.000Z');
    // The watch's own gate marks every check it made.
    writeFileSync(seven.checkedPath, '');
    utimesSync(seven.checkedPath, checked, checked);
    writeFileSync(seven.snapshotPath, '{}\n');
    const round = new Date('2026-10-01T01:30:00.000Z');
    utimesSync(seven.snapshotPath, round, round);

    const { watches } = runStatus({});
    expect(watches).toEqual([
      {
        pr: 7,
        repo: 'o/r',
        host: 'github.com',
        url: 'https://github.com/o/r/pull/7',
        headRefName: 'feat-7',
        pushTarget: 'origin',
        headSha: HEAD,
        pushes: 3,
        maxPushes: 10,
        session: 'session-a',
        preparedAt: '2026-10-01T00:00:00.000Z',
        thisSession: true,
        lastCheck: checked.toISOString(),
        checkedRecently: false,
        lastRound: round.toISOString(),
        stopped: null,
        watch: { every: 5, reply: false, instructions: 'keep the API' },
        ended: null,
        needsHuman: [item],
        worktreePath: seven.worktreePath,
        worktreeExists: true,
        // A plain directory, with no gitfile: not a git directory to trust.
        gitTrusted: false,
        // A plain directory: git cannot tell what it holds.
        worktreeWork: expect.stringMatching(/not a git worktree/),
        fix: null,
      },
      expect.objectContaining({
        pr: 12,
        session: 'session-b',
        preparedAt: null,
        thisSession: false,
        pushes: 0,
        lastCheck: null,
        lastRound: null,
        watch: null,
        needsHuman: [],
        worktreeExists: false,
        worktreeWork: null,
      }),
    ]);
    expect(runStatus({ pr: 12 }).watches.map(({ pr }) => pr)).toEqual([12]);
    // A quick ownership check skips the one git scan.
    expect(runStatus({ pr: 7, work: false }).watches[0]!.worktreeWork).toBe(
      null,
    );
  });

  it("shows a background fix's attempt, and whether its session still refreshes it", () => {
    const paths = write(7, {
      watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
    });
    expect(runStatus({ work: false }).watches[0]!.fix).toBeNull();
    const startedAt = new Date().toISOString();
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 'feedc0ffee12',
        head: HEAD,
        startedAt,
      }),
    );
    expect(runStatus({ work: false }).watches[0]!.fix).toEqual({
      attempt: '0123456789ab',
      startedAt,
      fresh: true,
    });
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    expect(runStatus({ work: false }).watches[0]!.fix).toEqual({
      attempt: '0123456789ab',
      startedAt,
      fresh: false,
    });
    writeFileSync(paths.fixPath, 'not json');
    expect(runStatus({ work: false }).watches[0]!.fix).toEqual({
      attempt: null,
      startedAt: null,
      fresh: false,
    });
  });

  it('dates the last round by the snapshot a claimed attempt took, when it is the latest', () => {
    const paths = write(7);
    const round = new Date('2026-10-01T01:30:00.000Z');
    const claimed = join(
      dirname(paths.statePath),
      'autofix-pr-7-fix-snapshot.json',
    );
    writeFileSync(claimed, '{}\n');
    utimesSync(claimed, round, round);
    expect(runStatus({ work: false }).watches[0]!.lastRound).toBe(
      round.toISOString(),
    );
    const later = new Date('2026-10-01T02:30:00.000Z');
    writeFileSync(paths.snapshotPath, '{}\n');
    utimesSync(paths.snapshotPath, later, later);
    expect(runStatus({ work: false }).watches[0]!.lastRound).toBe(
      later.toISOString(),
    );
  });

  it("says whether a gate checked within two of the watch's intervals", () => {
    const paths = write(7, {
      watch: { every: 5, reply: true, instructions: '' },
    });
    writeGateCursor(paths.gatePath, {
      version: 1,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      viewer: 'me',
      prAuthor: 'me',
      headSha: HEAD,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: null,
      reportedTruncated: [],
    });
    writeFileSync(paths.checkedPath, '');
    const at = (minutesAgo: number) => {
      const time = new Date(Date.now() - minutesAgo * 60_000);
      utimesSync(paths.checkedPath, time, time);
      return runStatus({}).watches[0]!.checkedRecently;
    };
    expect(at(9)).toBe(true);
    expect(at(11)).toBe(false);
  });

  // FIFOs are POSIX only.
  it.skipIf(process.platform === 'win32')(
    'never blocks on a state file or cursor that is not a regular file',
    () => {
      const paths = write(7);
      rmSync(paths.gatePath, { force: true });
      execFileSync('mkfifo', [paths.gatePath]);
      const eight = autofixPrPaths(repo, 8).statePath;
      execFileSync('mkfifo', [eight]);
      const outcome = runStatus({});
      expect(
        outcome.watches.map(({ pr, lastCheck }) => ({ pr, lastCheck })),
      ).toEqual([{ pr: 7, lastCheck: null }]);
      expect(outcome.unreadable).toEqual([
        {
          pr: 8,
          error: expect.stringMatching(
            /not a regular file; `qwen autofix-pr cleanup 8 --force` discards it/,
          ),
        },
      ]);
    },
  );

  it("takes nothing from a cursor older than the watch, a former watch's", () => {
    const paths = write(7, { preparedAt: '2026-10-20T00:00:00.000Z' });
    writeGateCursor(paths.gatePath, {
      version: 1,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      viewer: 'me',
      prAuthor: 'me',
      headSha: HEAD,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: 'closed',
      reportedTruncated: [],
    });
    // Closed then, before the PR was reopened and watched again.
    const then = new Date('2026-10-19T00:00:00.000Z');
    utimesSync(paths.gatePath, then, then);
    expect(runStatus({}).watches[0]).toMatchObject({ stopped: null });
    const later = new Date('2026-10-21T00:00:00.000Z');
    utimesSync(paths.gatePath, later, later);
    expect(runStatus({}).watches[0]).toMatchObject({ stopped: 'closed' });
  });

  it('says a watch cleanup ended while keeping its worktree', () => {
    const ended = { at: '2026-10-25T00:00:00.000Z', reason: 'kept' };
    write(7, { ended });
    expect(runStatus({}).watches[0]).toMatchObject({ ended, watch: null });
  });

  it('says a watch the gate saw end was not cleaned up', () => {
    const paths = write(7);
    writeGateCursor(paths.gatePath, {
      version: 1,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      viewer: 'me',
      prAuthor: 'me',
      headSha: HEAD,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: 'merged',
      reportedTruncated: [],
    });
    expect(runStatus({}).watches[0]).toMatchObject({ stopped: 'merged' });
  });

  it("takes nothing from a cursor of another repository's PR of that number, or one it cannot read", () => {
    const paths = write(7);
    writeGateCursor(paths.gatePath, {
      version: 1,
      host: 'github.com',
      owner: 'fork',
      repo: 'r',
      prNumber: 7,
      viewer: 'me',
      prAuthor: 'me',
      headSha: HEAD,
      reportedCommentIds: [],
      reportedChecks: [],
      conflictSha: null,
      stopped: 'merged',
      reportedTruncated: [],
    });
    expect(runStatus({}).watches[0]).toMatchObject({
      stopped: null,
      lastCheck: null,
    });
    writeFileSync(paths.gatePath, '{"version":2}');
    expect(runStatus({}).watches[0]).toMatchObject({ pr: 7, stopped: null });
  });

  it('reads only the files the helpers name, each of its own PR', () => {
    write(7);
    const eight = write(8);
    const zero = join(dirname(eight.statePath), 'autofix-pr-007-state.json');
    writeFileSync(zero, '{}');
    writeState(eight.statePath, {
      ...JSON.parse(readFileSync(autofixPrPaths(repo, 7).statePath, 'utf8')),
    });
    const outcome = runStatus({});
    expect(outcome.watches.map(({ pr }) => pr)).toEqual([7]);
    expect(outcome.unreadable).toEqual([
      { pr: 8, error: expect.stringMatching(/is the state of PR #7/) },
    ]);
  });

  it('reports a state file it cannot read and lists the others', () => {
    write(7);
    const bad = write(8);
    writeFileSync(bad.statePath, '{"version":1,"remote":"--upload-pack=x"}');
    const outcome = runStatus({});
    expect(outcome.watches.map(({ pr }) => pr)).toEqual([7]);
    expect(outcome.unreadable).toEqual([
      { pr: 8, error: expect.stringMatching(/has an invalid remote/) },
    ]);
  });
});
