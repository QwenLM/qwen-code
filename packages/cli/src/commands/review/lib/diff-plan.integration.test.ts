/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Drives the real `git diff` capture that `fetch-pr` performs, against a real
// repository, under the git configuration a user is allowed to have. Synthetic
// fixtures cannot catch `color.diff=always` — it makes every `diff --git` line
// unrecognisable and the plan comes back empty — nor the several ways git
// decorates a path, nor `diff.ignoreSubmodules=all` hiding a changed gitlink.
//
// The fixture repository is isolated from the developer's git environment:
// system and global config are switched off, hooks and signing are disabled.
// Otherwise a global `core.hooksPath` or `commit.gpgsign` runs during the test,
// and `~/.gitconfig` silently changes what the "clean" baseline even is.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffPlan, chunksCoverDiff, parseDiff } from './diff-plan.js';

/** The exact flags `fetch-pr` pins on its capture. */
const CAPTURE_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--unified=3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
];

/** Config a user may legitimately have set, all of which corrupts the output. */
const HOSTILE_CONFIG = [
  'color.diff=always',
  'diff.mnemonicprefix=true',
  'diff.context=9',
  'diff.renames=false',
  'diff.submodule=log',
  'diff.ignoreSubmodules=all',
].flatMap((kv) => ['-c', kv]);

let repo: string;
let subRepo: string;
let env: NodeJS.ProcessEnv;

/** Run git with the developer's system and global config switched off. */
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env });

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'diff-plan-it-'));
  const emptyConfig = join(repo, '.empty-gitconfig');
  writeFileSync(emptyConfig, '');
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    // Belt and braces on platforms where the above is unsupported.
    HOME: repo,
    GIT_TERMINAL_PROMPT: '0',
  };

  const init = (dir: string) => {
    gitIn(dir, 'init', '-q', '--template=', '.');
    gitIn(dir, 'config', 'user.email', 'test@example.com');
    gitIn(dir, 'config', 'user.name', 'test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.hooksPath', join(dir, '.no-such-hooks'));
    gitIn(dir, 'config', 'core.autocrlf', 'false');
  };

  // A separate repository to point a gitlink at. No `submodule add` — that
  // needs `protocol.file.allow` and a network-ish dance; a raw gitlink in the
  // index is what a submodule bump looks like to `git diff` anyway.
  subRepo = mkdtempSync(join(tmpdir(), 'diff-plan-sub-'));
  init(subRepo);
  writeFileSync(join(subRepo, 'f'), 'a\n');
  gitIn(subRepo, 'add', '-A');
  gitIn(subRepo, 'commit', '-qm', 'one', '--no-verify');
  const sub1 = gitIn(subRepo, 'rev-parse', 'HEAD').trim();

  init(repo);
  mkdirSync(join(repo, 'd'), { recursive: true });
  writeFileSync(join(repo, 'plain.ts'), 'a\n');
  writeFileSync(join(repo, 'sub中文.ts'), 'a\n'); // non-ASCII: git C-quotes it
  writeFileSync(join(repo, 'img with space.png'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo, 'mode file.sh'), 'x\n');
  writeFileSync(join(repo, 'd', 'old.ts'), 'q\n');
  // A SQL comment: deleting it emits `--- old comment`, which looks like a
  // `---` metadata header.
  writeFileSync(join(repo, 'q.sql'), '-- old comment\nSELECT 1;\n');
  git('add', '-A');
  git('update-index', '--add', '--cacheinfo', `160000,${sub1},sub`);
  git('commit', '-qm', 'init', '--no-verify');

  writeFileSync(join(repo, 'plain.ts'), 'a\nb\n');
  writeFileSync(join(repo, 'sub中文.ts'), 'a\nb\n');
  writeFileSync(join(repo, 'img with space.png'), Buffer.from([0, 9, 9]));
  writeFileSync(join(repo, 'q.sql'), 'SELECT 2;\n');
  // Adding a line whose content starts with `++ ` emits `+++ plus line`.
  writeFileSync(join(repo, 'plus.txt'), '++ plus line\n');
  git('mv', join('d', 'old.ts'), join('d', 'new name.ts'));
  git('add', '-A');
  // Index-native mode change: `chmod` is a no-op on Windows, and git's
  // `core.fileMode` may be false there anyway.
  git('update-index', '--chmod=+x', 'mode file.sh');

  // Bump the gitlink, the way a submodule update appears in a diff. `git add
  // -A` has just removed it from the index — the directory is not in the
  // worktree — so it has to be re-added, not merely updated.
  writeFileSync(join(subRepo, 'f'), 'a\nb\n');
  gitIn(subRepo, 'commit', '-qam', 'two', '--no-verify');
  const sub2 = gitIn(subRepo, 'rev-parse', 'HEAD').trim();
  git('update-index', '--add', '--cacheinfo', `160000,${sub2},sub`);
});

afterAll(() => {
  // `diff.submodule=log` — exercised by the negative control — walks into the
  // submodule, so it must outlive the tests.
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (subRepo) rmSync(subRepo, { recursive: true, force: true });
});

/** Capture exactly as `fetch-pr` does, but under hostile config. */
const capture = () =>
  execFileSync(
    'git',
    [...HOSTILE_CONFIG, 'diff', '--cached', ...CAPTURE_FLAGS],
    { cwd: repo, maxBuffer: 1 << 28, env },
  ).toString('utf8');

describe('real git capture', () => {
  it('parses every file, and gets every path right', () => {
    const { files } = parseDiff(capture());
    expect(files.map((f) => f.path).sort()).toEqual([
      'd/new name.ts', // rename, with a space
      'img with space.png', // binary, with a space, no ---/+++ to fall back on
      'mode file.sh', // mode-only, with a space
      'plain.ts',
      'plus.txt', // its payload line looks like a `+++` header
      'q.sql', // its payload line looks like a `---` header
      'sub', // a gitlink `diff.ignoreSubmodules=all` would have hidden
      'sub中文.ts', // C-quoted octal escapes
    ]);
  });

  it('counts payload lines that impersonate metadata headers', () => {
    const { files } = parseDiff(capture());
    const plus = files.find((f) => f.path === 'plus.txt')!;
    const sql = files.find((f) => f.path === 'q.sql')!;
    expect(plus.addedLines).toBe(1); // `+++ plus line`
    expect(sql.removedLines).toBe(2); // `--- old comment` and `-SELECT 1;`
  });

  it('keeps a changed gitlink visible and parseable', () => {
    // `diff.submodule=log` replaces the whole section with prose; the pinned
    // `--submodule=short` keeps the `-Subproject commit ...` hunk form.
    const raw = capture();
    expect(raw).toContain('Subproject commit');
    expect(raw).not.toContain('Submodule sub ');
    const sub = parseDiff(raw).files.find((f) => f.path === 'sub')!;
    expect(sub.hunks).toHaveLength(1);
    expect(sub.addedLines).toBe(1);
  });

  it('marks the binary file and leaves it hunkless', () => {
    const bin = parseDiff(capture()).files.find((f) => f.binary)!;
    expect(bin.path).toBe('img with space.png');
    expect(bin.hunks).toEqual([]);
  });

  it('reports added ranges that exclude context lines', () => {
    const plain = parseDiff(capture()).files.find(
      (f) => f.path === 'plain.ts',
    )!;
    // `a` is context, `b` is the one added line at new-side line 2.
    expect(plain.hunks[0].newStart).toBe(1);
    expect(plain.hunks[0].newEnd).toBe(2);
    expect(plain.addedRanges).toEqual([{ start: 2, end: 2 }]);
  });

  it('produces a plan that tiles the whole diff', () => {
    const raw = capture();
    const plan = buildDiffPlan(raw, 400);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const rebuilt = plan.chunks
      .flatMap((c) => lines.slice(c.startLine - 1, c.endLine))
      .join('\n');
    expect(rebuilt).toBe(lines.join('\n'));
  });

  it('without the pinned flags, the same config yields an unparseable diff', () => {
    // The control that makes the flags worth having: `color.diff=always` wraps
    // every `diff --git` line in ANSI escapes, so not one file is recognised
    // and the plan would silently cover nothing.
    const naive = execFileSync('git', [...HOSTILE_CONFIG, 'diff', '--cached'], {
      cwd: repo,
      maxBuffer: 1 << 28,
      env,
    }).toString('utf8');
    expect(naive.length).toBeGreaterThan(0);
    expect(parseDiff(naive).files).toHaveLength(0);
    expect(parseDiff(capture()).files.length).toBeGreaterThan(0);
  });
});
