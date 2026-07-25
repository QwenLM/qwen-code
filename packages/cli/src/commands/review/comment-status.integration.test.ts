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

    const got = makeGitProbe(repo)('pkg/src/a.ts', base);
    expect(got.changed).toBe(true);
    expect(got.touchedByTotal).toBe(1);
    expect(fix.startsWith(got.touchedBy[0])).toBe(true);
  });

  it('scopes git to the worktree via -C regardless of the process CWD', () => {
    // The command runs from the trusted main checkout; the probe must still
    // read the worktree. Driving from an unrelated CWD proves it is `-C
    // <worktree>`, not the ambient directory, that git sees. (Also the
    // regression guard for the old CWD-relative pathspec.)
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    commitFile('pkg/src/a.ts', 'v2\n', 'fix');

    process.chdir(tmpdir());
    const got = makeGitProbe(repo)('pkg/src/a.ts', base);
    expect(got.changed).toBe(true);
    expect(got.touchedByTotal).toBe(1);
  });

  it('caps touchedBy at 10 while reporting the real total', () => {
    const base = commitFile('pkg/src/a.ts', 'v0\n', 'base');
    for (let i = 1; i <= 12; i++) {
      commitFile('pkg/src/a.ts', `v${i}\n`, `edit ${i}`);
    }

    const got = makeGitProbe(repo)('pkg/src/a.ts', base);
    expect(got.touchedBy).toHaveLength(10);
    expect(got.touchedByTotal).toBe(12);
  });

  it('degrades to unknown for a commit absent from the object store', () => {
    commitFile('pkg/src/a.ts', 'v1\n', 'base');
    const got = makeGitProbe(repo)(
      'pkg/src/a.ts',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(got.changed).toBe('unknown');
    expect(got.touchedByTotal).toBe(0);
  });

  it('degrades to unknown for a non-ancestor (force-pushed-away) commit that still resolves', () => {
    // A change lives on an orphaned branch that is a real commit but not an
    // ancestor of HEAD. `sinceSha..HEAD` would be empty and wrongly read as
    // "unchanged"; the ancestry gate must return unknown instead.
    commitFile('pkg/src/a.ts', 'v1\n', 'base');
    git('checkout', '-q', '-b', 'orphan');
    const orphan = commitFile('pkg/src/a.ts', 'ORPHAN CHANGE\n', 'orphan edit');
    git('checkout', '-q', '-');
    commitFile('pkg/src/b.ts', 'unrelated\n', 'move head forward');

    const got = makeGitProbe(repo)('pkg/src/a.ts', orphan);
    expect(got.changed).toBe('unknown');
  });

  it('takes the comment path literally, not as pathspec magic', () => {
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    commitFile('pkg/src/a.ts', 'v2\n', 'fix');
    // A DISCRIMINATING pathspec: `:(glob)pkg/**` under magic matches the
    // changed a.ts → changed:true; taken literally it is a file named
    // `:(glob)pkg/**`, which does not exist → changed:false. Asserting false
    // therefore fails if the literal prefix is ever dropped (magic would
    // return true) — unlike `:(exclude)…`, which reads false either way.
    const magic = makeGitProbe(repo)(':(glob)pkg/**', base);
    expect(magic.changed).toBe(false);
    // Control: the same file under its plain path IS seen as changed, proving
    // the false above is the literal-vs-magic distinction, not a dead probe.
    const plain = makeGitProbe(repo)('pkg/src/a.ts', base);
    expect(plain.changed).toBe(true);
  });

  it('reports unchanged for a file the range never touched', () => {
    const base = commitFile('pkg/src/a.ts', 'v1\n', 'base');
    commitFile('pkg/src/b.ts', 'other\n', 'unrelated');

    const got = makeGitProbe(repo)('pkg/src/a.ts', base);
    expect(got.changed).toBe(false);
    expect(got.touchedBy).toEqual([]);
  });
});
