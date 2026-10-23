/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  autofixPrPaths,
  historyPath,
  isBranchName,
  keepHistory,
  readHistory,
  withWatchLock,
  type AutofixPrState,
} from './state.js';

describe('isBranchName', () => {
  it('accepts what git accepts as a branch name', () => {
    for (const name of ['feat', 'feat/x-1', 'user/fix_2', 'v1.2']) {
      expect(isBranchName(name)).toBe(true);
    }
  });

  it('refuses refspec syntax, options and what git refuses', () => {
    for (const name of [
      'feat:refs/heads/release',
      'refs/heads/*',
      '-x',
      'a..b',
      'a@{1}',
      '@',
      'a//b',
      'a/',
      'a.',
      '.a',
      'a/.b',
      'a.lock',
      'a b',
      'a\\b',
      'a~1',
      'a^',
      'a?',
      'a[1]',
      'a\u0001',
    ]) {
      expect({ name, ok: isBranchName(name) }).toEqual({ name, ok: false });
    }
  });
});

describe('withWatchLock', () => {
  let dir: string;
  let paths: ReturnType<typeof autofixPrPaths>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autofix-lock-'));
    paths = autofixPrPaths(dir, 7);
    mkdirSync(dirname(paths.lockPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const plant = (token: Record<string, unknown>) =>
    writeFileSync(paths.lockPath, JSON.stringify(token));
  const ns = (() => {
    try {
      return readlinkSync('/proc/self/ns/pid');
    } catch {
      return null;
    }
  })();

  it('runs one helper at a time and removes only its own lock', () => {
    const inner = withWatchLock(paths, 7, () => {
      expect(() => withWatchLock(paths, 7, () => 'second')).toThrow(
        /another autofix-pr helper is working on PR #7/,
      );
      return 'first';
    });
    expect(inner).toBe('first');
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(readdirSync(dirname(paths.lockPath))).toEqual([]);
  });

  it('takes over a lock whose holder is gone, judging its pid only in its own namespace', () => {
    // A dead pid in this namespace.
    plant({ pid: 2 ** 22 + 1, ns, at: Date.now(), id: 'x' });
    expect(withWatchLock(paths, 7, () => 'ran')).toBe('ran');
    // A pid of another namespace (a sandboxed command) means nothing here:
    // a fresh lock from there is held, even if the pid is free here.
    plant({ pid: 2 ** 22 + 1, ns: 'pid:[1]', at: Date.now(), id: 'x' });
    expect(() => withWatchLock(paths, 7, () => 'ran')).toThrow(
      /another autofix-pr helper/,
    );
    // Until it is older than any helper runs.
    plant({ pid: 1, ns: 'pid:[1]', at: Date.now() - 16 * 60_000, id: 'x' });
    expect(withWatchLock(paths, 7, () => 'ran')).toBe('ran');
  });

  it('leaves a lock alone that is no longer its own', () => {
    withWatchLock(paths, 7, () => {
      // Taken over meanwhile (it looked stale to another helper).
      plant({ pid: 1, ns: 'pid:[1]', at: Date.now(), id: 'other' });
    });
    expect(JSON.parse(readFileSync(paths.lockPath, 'utf8'))).toMatchObject({
      id: 'other',
    });
  });

  it('replaces a symlink planted as the lock, and refuses a directory', () => {
    const target = join(dir, 'target');
    writeFileSync(target, 'keep');
    symlinkSync(target, paths.lockPath);
    expect(withWatchLock(paths, 7, () => 'ran')).toBe('ran');
    expect(readFileSync(target, 'utf8')).toBe('keep');
    mkdirSync(paths.lockPath);
    expect(() => withWatchLock(paths, 7, () => 'ran')).toThrow(
      /is not a lock file/,
    );
  });
});

describe('history', () => {
  it('keeps the history of each repository apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-history-'));
    try {
      const paths = autofixPrPaths(dir, 7);
      mkdirSync(dirname(paths.statePath), { recursive: true });
      const watch = (owner: string, ids: string[]) =>
        ({
          version: 1,
          sessionId: '',
          host: 'github.com',
          owner,
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
          lastKnownHeadSha: 'a'.repeat(40),
          pushedShas: [],
          handledCommentIds: ids,
          postedCommentIds: [],
          handledConflictSha: 'a'.repeat(40),
        }) as AutofixPrState;
      const upstream = keepHistory(paths, watch('upstream', ['U1']));
      const fork = keepHistory(paths, watch('fork', ['F1']));
      expect(upstream).not.toBe(fork);
      expect(readHistory(upstream)).toMatchObject({
        handledCommentIds: ['U1'],
        handledConflictSha: 'a'.repeat(40),
      });
      expect(readHistory(fork)).toMatchObject({ handledCommentIds: ['F1'] });
      // Spellings of one repository share a file.
      expect(
        historyPath(paths, {
          host: 'GitHub.com',
          owner: 'UPSTREAM',
          repo: 'R',
        }),
      ).toBe(upstream);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
