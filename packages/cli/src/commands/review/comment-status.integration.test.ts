/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git`. The pure core is covered by comment-status.test.ts with an
// injected probe; this file covers the probe itself — the memo, the
// missing-commit gate, the cap, and above all the CWD assumption: the probe
// once resolved its pathspec against the CURRENT directory, so running from a
// subdirectory of the worktree returned empty output with exit 0 and every
// thread read as "untouched since the comment". A mocked child_process would
// have passed that bug happily.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGitProbe } from './comment-status.js';

let repo: string;
let savedCwd: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commitFile(path: string, content: string, message: string): string {
  writeFileSync(join(repo, path), content);
  git('add', path);
  git(
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=T',
    'commit',
    '-qm',
    message,
  );
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'comment-status-probe-'));
  savedCwd = process.cwd();
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, 'pkg', 'src'), { recursive: true });
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('makeGitProbe (real git)', () => {
  it('reports the touching commits from the repo root', () => {
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    const fix = commitFile('pkg/src/a.ts', 'v2\n', 'fix');

    process.chdir(repo);
    const got = makeGitProbe()('pkg/src/a.ts', base);
    expect(got.changed).toBe(true);
    expect(got.touchedByTotal).toBe(1);
    expect(fix.startsWith(got.touchedBy[0])).toBe(true);
  });

  it('resolves the repo-relative path even when run from a subdirectory', () => {
    // The regression: without `:(top)` the pathspec resolves against the
    // subdirectory, git log returns nothing with exit 0, and the report
    // claims the file is untouched.
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    commitFile('pkg/src/a.ts', 'v2\n', 'fix');

    process.chdir(join(repo, 'pkg', 'src'));
    const got = makeGitProbe()('pkg/src/a.ts', base);
    expect(got.changed).toBe(true);
    expect(got.touchedByTotal).toBe(1);
  });

  it('caps touchedBy at 10 while reporting the real total', () => {
    const base = commitFile('pkg/src/a.ts', 'v0\n', 'base');
    for (let i = 1; i <= 12; i++) {
      commitFile('pkg/src/a.ts', `v${i}\n`, `edit ${i}`);
    }

    process.chdir(repo);
    const got = makeGitProbe()('pkg/src/a.ts', base);
    expect(got.touchedBy).toHaveLength(10);
    expect(got.touchedByTotal).toBe(12);
  });

  it('degrades to unknown for a commit absent from the object store', () => {
    commitFile('pkg/src/a.ts', 'v1\n', 'base');
    process.chdir(repo);
    const got = makeGitProbe()(
      'pkg/src/a.ts',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(got.changed).toBe('unknown');
    expect(got.touchedByTotal).toBe(0);
  });

  it('reports unchanged for a file the range never touched', () => {
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    commitFile('pkg/src/b.ts', 'other\n', 'unrelated');

    process.chdir(repo);
    const got = makeGitProbe()('pkg/src/a.ts', base);
    expect(got.changed).toBe(false);
    expect(got.touchedBy).toEqual([]);
  });
});
