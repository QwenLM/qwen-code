/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
import {
  assertNoFixInFlight,
  clearAbandonedFix,
  FIX_FRESH_MS,
  FIX_MAX_AGE_MS,
  FIX_SNAPSHOT_MAX_AGE_MS,
  fixInFlight,
  fixSnapshotPath,
  runFixEnd,
  runFixStart,
} from './fix.js';
import { autofixPrPaths, writeState, type AutofixPrState } from './state.js';
import { runCiLog } from './ci-log.js';
import { runCleanup } from './cleanup.js';
import { runPrepare } from './prepare.js';
import { runPush } from './push.js';
import { runReply } from './reply.js';
import { runRerun } from './rerun.js';
import { runSchedule } from './schedule.js';
import { runSnapshot } from './snapshot.js';
import { runSync } from './sync.js';

const HEAD = 'a'.repeat(40);
const ATTEMPT = '0123456789ab';

describe('fix-start and fix-end', () => {
  let repo: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;

  const write = (patch: Partial<AutofixPrState> = {}) =>
    writeState(paths.statePath, {
      version: 1,
      sessionId: 'session-a',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: paths.branch,
      worktreePath: paths.worktreePath,
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      authorCanPush: true,
      watch: {
        every: 2,
        reply: false,
        instructions: 'keep the API',
        task: 'feedc0ffee12',
      },
      ...patch,
    });

  /** The marker as the session last refreshed it, `ago` ms back. */
  const age = (ago: number, path = paths.fixPath) => {
    const at = (Date.now() - ago) / 1000;
    utimesSync(path, at, at);
  };
  /** The round's prepared snapshot, as `snapshot` writes it. */
  const round = (snapshot: object = { action: 'fix', headSha: HEAD }) =>
    writeFileSync(paths.snapshotPath, JSON.stringify(snapshot));

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-fix-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    paths = autofixPrPaths(repo, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    write();
    round();
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

  it('opens an attempt on the watch task and head, and claims it once', () => {
    const opened = runFixStart({ pr: 7, attempt: ATTEMPT });
    expect(opened).toMatchObject({
      attempt: ATTEMPT,
      task: 'feedc0ffee12',
      head: HEAD,
      marker: paths.fixPath,
    });
    expect(fixInFlight(paths)?.attempt).toBe(ATTEMPT);
    expect(() => assertNoFixInFlight(paths, 7)).toThrow(
      /a fix agent is working in PR #7's worktree \(attempt 0123456789ab/,
    );
    expect(
      runFixEnd({ pr: 7, attempt: ATTEMPT, task: 'feedc0ffee12' }),
    ).toEqual({
      attempt: ATTEMPT,
      head: HEAD,
      startedAt: opened.startedAt,
      snapshot: fixSnapshotPath(paths, 7),
      brief: join(dirname(paths.statePath), 'autofix-pr-7-brief.md'),
    });
    expect(existsSync(paths.fixPath)).toBe(false);
    // The round's snapshot, taken: no later attempt starts from it.
    expect(existsSync(paths.snapshotPath)).toBe(false);
    expect(JSON.parse(readFileSync(fixSnapshotPath(paths, 7), 'utf8'))).toEqual(
      { action: 'fix', headSha: HEAD },
    );
    expect(() => runFixStart({ pr: 7, attempt: 'ba9876543210' })).toThrow(
      /no round of PR #7 has a fix to start/,
    );
    expect(() => runFixEnd({ pr: 7, attempt: ATTEMPT })).toThrow(
      /attempt 0123456789ab of PR #7's fix is not in flight/,
    );
  });

  it('refuses a second attempt while one is fresh, and replaces a stale one', () => {
    runFixStart({ pr: 7, attempt: ATTEMPT });
    expect(() => runFixStart({ pr: 7, attempt: 'ba9876543210' })).toThrow(
      /attempt 0123456789ab of PR #7's fix is still in flight/,
    );
    age(FIX_FRESH_MS + 1000);
    expect(runFixStart({ pr: 7, attempt: 'ba9876543210' }).attempt).toBe(
      'ba9876543210',
    );
  });

  it('claims only its own attempt, under the task that drives the watch', () => {
    runFixStart({ pr: 7, attempt: ATTEMPT });
    expect(() => runFixEnd({ pr: 7, attempt: 'ba9876543210' })).toThrow(
      /not in flight/,
    );
    expect(() =>
      runFixEnd({ pr: 7, attempt: ATTEMPT, task: 'aaaaaaaaaaaa' }),
    ).toThrow(/task aaaaaaaaaaaa no longer drives/);
    expect(fixInFlight(paths)?.attempt).toBe(ATTEMPT);
    // A late claim of the same attempt still holds: nothing replaced it.
    age(FIX_FRESH_MS + 1000);
    expect(runFixEnd({ pr: 7, attempt: ATTEMPT }).attempt).toBe(ATTEMPT);
  });

  it("refuses another session's watch, an ended one, and one with no task", () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /watched by another session/,
    );
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    write({ ended: { at: new Date().toISOString(), reason: 'stopped' } });
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /watch was stopped/,
    );
    write({ watch: undefined });
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /has no scheduled task/,
    );
    expect(existsSync(paths.fixPath)).toBe(false);
  });

  it("starts only from a round's recent snapshot to fix at the watch's head", () => {
    for (const snapshot of [
      { action: 'wait', headSha: HEAD },
      { action: 'fix', headSha: 'b'.repeat(40) },
    ]) {
      round(snapshot);
      expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
        /no round of PR #7 has a fix to start/,
      );
    }
    round();
    age(FIX_SNAPSHOT_MAX_AGE_MS + 1000, paths.snapshotPath);
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /no round of PR #7 has a fix to start/,
    );
    writeFileSync(paths.snapshotPath, 'not json');
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /no round of PR #7 has a fix to start/,
    );
    rmSync(paths.snapshotPath);
    expect(() => runFixStart({ pr: 7, attempt: ATTEMPT })).toThrow(
      /no round of PR #7 has a fix to start/,
    );
    expect(existsSync(paths.fixPath)).toBe(false);
    round();
    expect(runFixStart({ pr: 7, attempt: ATTEMPT }).attempt).toBe(ATTEMPT);
  });

  it('takes only an id the session makes', () => {
    for (const attempt of ['', '--force', '0123456789AB', 'x'.repeat(12)]) {
      expect(() => runFixStart({ pr: 7, attempt })).toThrow(/--attempt/);
      expect(() => runFixEnd({ pr: 7, attempt })).toThrow(/--attempt/);
    }
  });

  it('is fresh only while the session refreshes it and within the time an attempt lives', () => {
    runFixStart({ pr: 7, attempt: ATTEMPT });
    age(FIX_FRESH_MS - 5000);
    expect(fixInFlight(paths)).not.toBeNull();
    age(FIX_FRESH_MS + 1000);
    expect(fixInFlight(paths)).toBeNull();
    // Refreshed past the time any attempt lives: not the session's.
    const marker = JSON.parse(readFileSync(paths.fixPath, 'utf8'));
    const old = new Date(Date.now() - FIX_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(paths.fixPath, JSON.stringify({ ...marker, startedAt: old }));
    expect(fixInFlight(paths)).toBeNull();
    // Started, or refreshed, ahead of this clock: never fresh.
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    writeFileSync(
      paths.fixPath,
      JSON.stringify({ ...marker, startedAt: ahead }),
    );
    expect(fixInFlight(paths)).toBeNull();
    writeFileSync(paths.fixPath, JSON.stringify(marker));
    expect(fixInFlight(paths)).not.toBeNull();
    age(-10 * 60_000);
    expect(fixInFlight(paths)).toBeNull();
  });

  it('removes only a marker its session left behind', () => {
    expect(clearAbandonedFix(paths)).toBeNull();
    const opened = runFixStart({ pr: 7, attempt: ATTEMPT });
    expect(clearAbandonedFix(paths)).toBeNull();
    expect(existsSync(paths.fixPath)).toBe(true);
    age(FIX_FRESH_MS + 1000);
    expect(clearAbandonedFix(paths)).toEqual({ startedAt: opened.startedAt });
    expect(existsSync(paths.fixPath)).toBe(false);
    // With its round's snapshot: no later attempt starts from it.
    expect(existsSync(paths.snapshotPath)).toBe(false);
    // A file that is no attempt, or a directory under the name.
    writeFileSync(paths.fixPath, 'not json');
    expect(fixInFlight(paths)).toBeNull();
    expect(clearAbandonedFix(paths)).toEqual({ startedAt: null });
    mkdirSync(join(paths.fixPath, 'x'), { recursive: true });
    expect(clearAbandonedFix(paths)).toEqual({ startedAt: null });
    expect(existsSync(paths.fixPath)).toBe(false);
  });

  it('keeps every helper that acts on the worktree or the PR off while it is fresh', () => {
    runFixStart({ pr: 7, attempt: ATTEMPT });
    const plan = join(dirname(paths.statePath), 'autofix-pr-7-plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        replies: [],
        summary: null,
        handled: [],
        handledChecks: [],
        handledConflict: false,
        needsHuman: [],
      }),
    );
    const helpers: Array<[string, () => unknown]> = [
      ['sync', () => runSync(7)],
      ['sync --discard', () => runSync(7, true)],
      ['snapshot', () => runSnapshot({ pr: 7, gate: false })],
      ['ci-log', () => runCiLog(7, 99, 200)],
      ['push', () => runPush(7)],
      ['reply', () => runReply({ pr: 7, planPath: plan, post: false })],
      ['rerun', () => runRerun(7, 99)],
      ['schedule', () => runSchedule({ pr: 7, again: true })],
      ['cleanup', () => runCleanup(7, false)],
      ['cleanup --force', () => runCleanup(7, true)],
      ['prepare', () => runPrepare({ pr: 7, repo: 'o/r' })],
    ];
    const refusals = helpers.map(([name, run]) => {
      try {
        run();
        return `${name}: ran`;
      } catch (err) {
        return `${name}: ${(err as Error).message.split(' (')[0]}`;
      }
    });
    expect(refusals).toEqual(
      helpers.map(
        ([name]) => `${name}: a fix agent is working in PR #7's worktree`,
      ),
    );
    expect(existsSync(paths.statePath)).toBe(true);
    expect(fixInFlight(paths)?.attempt).toBe(ATTEMPT);
  });
});
