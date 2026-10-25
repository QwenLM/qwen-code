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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSchedule } from './schedule.js';
import {
  autofixPrPaths,
  readState,
  writeState,
  type AutofixPrState,
} from './state.js';

const HEAD = 'a'.repeat(40);
const GATE =
  '"${QWEN_CODE_CLI:-qwen}" autofix-pr snapshot 7 --gate --repo o/r --host github.com --session session-a';

describe('runSchedule', () => {
  let repo: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;

  const state = () => readState(paths.statePath)!;
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
      ...patch,
    });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-schedule-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    paths = autofixPrPaths(repo, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    write();
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

  it('records the task and prints it as cron_create takes it', () => {
    expect(runSchedule({ pr: 7 })).toEqual({
      cron: '*/2 * * * *',
      recurring: true,
      gate: GATE,
      prompt: 'Run /autofix-pr tick o/r#7',
      every: 2,
      reply: true,
      instructions: '',
    });
    expect(state().watch).toEqual({ every: 2, reply: true, instructions: '' });
  });

  it("puts --no-reply and the user's instructions, on one line, into the prompt", () => {
    writeFileSync(
      paths.instructionsPath,
      'do not touch\n  the public\u0085API\u2028\n',
      'utf8',
    );
    const task = runSchedule({
      pr: 7,
      every: 60,
      noReply: true,
      instructions: true,
    });
    expect(task).toMatchObject({
      cron: '0 * * * *',
      prompt:
        'Run /autofix-pr tick o/r#7 --no-reply -- do not touch the public API',
    });
    expect(state().watch).toEqual({
      every: 60,
      reply: false,
      instructions: 'do not touch the public API',
    });
  });

  it('prints the recorded task again for the session that took the watch over', () => {
    runSchedule({ pr: 7, every: 5, noReply: true });
    write({
      sessionId: 'session-b',
      watch: { every: 5, reply: false, instructions: '' },
    });
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(runSchedule({ pr: 7, again: true })).toMatchObject({
      cron: '*/5 * * * *',
      gate: GATE.replace('session-a', 'session-b'),
      prompt: 'Run /autofix-pr tick o/r#7 --no-reply',
    });
  });

  it('refuses what it cannot make a task of, recording nothing', () => {
    expect(() => runSchedule({ pr: 7, every: 3 })).toThrow(
      /--every must be one of 1, 2, 5, 10, 15, 30, 60/,
    );
    expect(() => runSchedule({ pr: 7, again: true })).toThrow(
      /no scheduled task recorded/,
    );
    expect(() => runSchedule({ pr: 7, again: true, every: 5 })).toThrow(
      /--again prints the task recorded already/,
    );
    expect(() => runSchedule({ pr: 7, instructions: true })).toThrow(
      /no instructions file/,
    );
    writeFileSync(paths.instructionsPath, 'x'.repeat(2001), 'utf8');
    expect(() => runSchedule({ pr: 7, instructions: true })).toThrow(
      /at most 2000/,
    );
    for (const id of ['a b', '--help']) {
      write({ sessionId: id });
      process.env['QWEN_CODE_SESSION_ID'] = id;
      expect(() => runSchedule({ pr: 7 })).toThrow(
        /cannot be named in a command/,
      );
    }
    write({ sessionId: '' });
    process.env['QWEN_CODE_SESSION_ID'] = '';
    expect(() => runSchedule({ pr: 7 })).toThrow(/outside a Qwen Code session/);
    expect(state().watch).toBeUndefined();
  });

  it("refuses another session's watch", () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runSchedule({ pr: 7 })).toThrow(/watched by another session/);
    expect(state().watch).toBeUndefined();
  });
});
