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
    expect(runStatus({})).toEqual({ watches: [] });
  });

  it('lists every watch from its files, whichever session owns it', () => {
    const item = {
      sha: HEAD,
      at: '2026-10-25T01:00:00.000Z',
      text: 'IC_9: a design call',
    };
    const seven = write(7, {
      pushCount: 3,
      watch: { every: 5, reply: false, instructions: 'keep the API' },
      needsHuman: [item],
    });
    write(12, { sessionId: 'session-b' });
    mkdirSync(seven.worktreePath, { recursive: true });
    // The last check is the gate cursor's time, the last round the
    // prepared snapshot's.
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
    const checked = new Date('2026-10-25T02:00:00.000Z');
    utimesSync(seven.gatePath, checked, checked);
    writeFileSync(seven.snapshotPath, '{}\n');
    const round = new Date('2026-10-25T01:30:00.000Z');
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
        thisSession: true,
        lastCheck: checked.toISOString(),
        lastRound: round.toISOString(),
        stopped: null,
        watch: { every: 5, reply: false, instructions: 'keep the API' },
        needsHuman: [item],
        worktreePath: seven.worktreePath,
        worktreeExists: true,
      },
      expect.objectContaining({
        pr: 12,
        session: 'session-b',
        thisSession: false,
        pushes: 0,
        lastCheck: null,
        lastRound: null,
        watch: null,
        needsHuman: [],
        worktreeExists: false,
      }),
    ]);
    expect(runStatus({ pr: 12 }).watches.map(({ pr }) => pr)).toEqual([12]);
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
