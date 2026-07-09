/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Drives the real `git diff` capture that `fetch-pr` performs, against a real
// repository, under the git configuration a user is allowed to have. Synthetic
// fixtures cannot catch `color.diff=always` — it makes every `diff --git` line
// unrecognisable and the plan comes back empty — nor the several ways git
// decorates a path.

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
];

/** Config a user may legitimately have set, all of which corrupts the output. */
const HOSTILE_CONFIG = [
  '-c',
  'color.diff=always',
  '-c',
  'diff.mnemonicprefix=true',
  '-c',
  'diff.context=9',
  '-c',
  'diff.renames=false',
];

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'diff-plan-it-'));
  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

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
  git('commit', '-qm', 'init');

  writeFileSync(join(repo, 'plain.ts'), 'a\nb\n');
  writeFileSync(join(repo, 'sub中文.ts'), 'a\nb\n');
  writeFileSync(join(repo, 'img with space.png'), Buffer.from([0, 9, 9]));
  execFileSync('chmod', ['+x', join(repo, 'mode file.sh')]);
  writeFileSync(join(repo, 'q.sql'), 'SELECT 2;\n');
  // Adding a line whose content starts with `++ ` emits `+++ plus line`.
  writeFileSync(join(repo, 'plus.txt'), '++ plus line\n');
  git('mv', join('d', 'old.ts'), join('d', 'new name.ts'));
  git('add', '-A');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

/** Capture exactly as `fetch-pr` does, but under hostile config. */
const capture = () =>
  execFileSync(
    'git',
    [...HOSTILE_CONFIG, 'diff', '--cached', ...CAPTURE_FLAGS],
    { cwd: repo, maxBuffer: 1 << 28 },
  ).toString('utf8');

describe('real git capture', () => {
  it('parses every file, and gets every path right', () => {
    const { files } = parseDiff(capture());
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'd/new name.ts', // rename, with a space
      'img with space.png', // binary, with a space, no ---/+++ to fall back on
      'mode file.sh', // mode-only, with a space
      'plain.ts',
      'plus.txt', // its payload line looks like a `+++` header
      'q.sql', // its payload line looks like a `---` header
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

  it('marks the binary file and leaves it hunkless', () => {
    const bin = parseDiff(capture()).files.find((f) => f.binary)!;
    expect(bin.path).toBe('img with space.png');
    expect(bin.hunks).toEqual([]);
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
    // and the plan silently covers nothing.
    const naive = execFileSync('git', [...HOSTILE_CONFIG, 'diff', '--cached'], {
      cwd: repo,
      maxBuffer: 1 << 28,
    }).toString('utf8');
    expect(naive.length).toBeGreaterThan(0);
    expect(parseDiff(naive).files).toHaveLength(0);
    expect(parseDiff(capture()).files.length).toBeGreaterThan(0);
  });
});
