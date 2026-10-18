/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  fetchGitDiffHunksForFile,
  fetchGitLog,
  fetchGitCommitDetail,
  getGitWorkingTreeStatus,
  MAX_DIFF_SIZE_BYTES,
  MAX_FILES,
  MAX_LINES_PER_FILE,
  parseDeletedFromNameStatus,
  parseGitDiff,
  parseGitNumstat,
  parseShortstat,
  parseStatusBranchLine,
  parseStatusEntries,
  resolveGitDir,
} from './gitDiff.js';
import { UNVERIFIABLE_IDENTITY_CODE } from './no-follow-open.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-test-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

const rmDir = (dir: string) => fs.rm(dir, { recursive: true, force: true });
const ZERO_SHA = '0000000000000000000000000000000000000000\n';

type Files = Record<string, string | Buffer>;

async function write(dir: string, files: Files): Promise<void> {
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), data);
  }
}

/** Writes `files`, then stages everything and commits. */
async function commit(dir: string, files: Files, msg = 'init'): Promise<void> {
  await write(dir, files);
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', msg);
}

async function headSha(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
  });
  return stdout.trim();
}

async function addWorktree(dir: string): Promise<string> {
  const wtPath = path.join(dir, 'wt');
  await git(dir, 'worktree', 'add', '-q', wtPath, '-b', 'side');
  return wtPath;
}

/** Runs `fn` in a fresh temp dir that is not a git repo, then removes it. */
async function inPlainDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-plain-'));
  try {
    await fn(dir);
  } finally {
    await rmDir(dir);
  }
}

let repo: string;

/** A fresh `repo` per test in this describe, optionally seeded by a commit. */
function useFreshRepo(seed?: Files): void {
  beforeEach(async () => {
    repo = await makeRepo();
    if (seed) await commit(repo, seed);
  });
  afterEach(() => rmDir(repo));
}

/** fetchGitDiff result that must be non-null. */
async function diffOf(cwd: string) {
  const result = await fetchGitDiff(cwd);
  expect(result).not.toBeNull();
  return result!;
}

/** fetchGitDiffHunksForFile result that must be non-null. */
async function hunksFor(cwd: string, file: string, oldPath?: string) {
  const result = await fetchGitDiffHunksForFile(cwd, file, oldPath);
  expect(result).not.toBeNull();
  return result!;
}

const untrackedEntry = (added: number, isBinary = false) => ({
  added,
  removed: 0,
  isBinary,
  isUntracked: true,
  truncated: false,
});

describe('parseGitNumstat', () => {
  it('parses added/removed counts and file totals (NUL-delimited -z format)', () => {
    const out = '3\t1\tsrc/a.ts\0' + '10\t0\tsrc/b.ts\0' + '0\t5\tsrc/c.ts\0';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats).toEqual({
      filesCount: 3,
      linesAdded: 13,
      linesRemoved: 6,
    });
    expect(perFileStats.get('src/a.ts')).toEqual({
      added: 3,
      removed: 1,
      isBinary: false,
    });
    expect(perFileStats.size).toBe(3);
  });

  it('treats `-` counts as binary with zero line deltas', () => {
    const out = '-\t-\timg/logo.png\0';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats.filesCount).toBe(1);
    expect(stats.linesAdded).toBe(0);
    expect(stats.linesRemoved).toBe(0);
    expect(perFileStats.get('img/logo.png')).toEqual({
      added: 0,
      removed: 0,
      isBinary: true,
    });
  });

  it('keeps accurate totals but caps per-file entries at MAX_FILES', () => {
    const tokens: string[] = [];
    const totalFiles = MAX_FILES + 5;
    for (let i = 0; i < totalFiles; i++) {
      tokens.push(`1\t0\tfile${i}.ts`);
    }
    const { stats, perFileStats } = parseGitNumstat(tokens.join('\0') + '\0');
    expect(stats.filesCount).toBe(totalFiles);
    expect(stats.linesAdded).toBe(totalFiles);
    expect(perFileStats.size).toBe(MAX_FILES);
  });

  it('ignores malformed rows without crashing', () => {
    const out = 'garbage-token\0' + '2\t1\tsrc/a.ts\0';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats.filesCount).toBe(1);
    expect(perFileStats.has('src/a.ts')).toBe(true);
  });

  it('preserves literal tabs in tracked filenames via the -z wire format', () => {
    // -z emits the raw path, no C-quoting; `split('\t')` would mis-attribute
    // characters after the first tab, so the parser slices by index.
    const out = '1\t2\tweird\tname.ts\0';
    const { perFileStats } = parseGitNumstat(out);
    expect(perFileStats.has('weird\tname.ts')).toBe(true);
    expect(perFileStats.get('weird\tname.ts')).toEqual({
      added: 1,
      removed: 2,
      isBinary: false,
    });
  });

  it('combines rename-pair tokens into a single entry keyed by the new path', () => {
    // `-z` rename format: `<a>\t<b>\t\0<old>\0<new>\0`.
    const out = '0\t0\t\0' + 'src/old.ts\0' + 'src/new.ts\0';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats.filesCount).toBe(1);
    // Keyed by the new path so the single-file endpoint can address it; the
    // old path is carried for display.
    expect(perFileStats.has('src/new.ts')).toBe(true);
    expect(perFileStats.get('src/new.ts')?.oldPath).toBe('src/old.ts');
  });
});

describe('parseDeletedFromNameStatus', () => {
  it('extracts D-status paths and ignores M/A entries', () => {
    const out = 'D\0gone.txt\0M\0kept.txt\0A\0added.txt\0D\0also-gone.txt\0';
    expect(parseDeletedFromNameStatus(out)).toEqual(
      new Set(['gone.txt', 'also-gone.txt']),
    );
  });

  it('skips both halves of rename and copy entries', () => {
    // Renames/copies span three tokens: `R<score>\0<old>\0<new>\0`. Neither
    // path is "deleted" in the user sense: the file lives on under the new
    // name.
    const out =
      'R100\0old.txt\0new.txt\0' + 'C75\0src.txt\0copy.txt\0' + 'D\0gone.txt\0';
    expect(parseDeletedFromNameStatus(out)).toEqual(new Set(['gone.txt']));
  });

  it('preserves NUL-safe paths (tabs, non-ASCII)', () => {
    // -z keeps raw bytes — same guarantee as the numstat path.
    const out = 'D\0tab\there.txt\0D\0日本語.txt\0';
    expect(parseDeletedFromNameStatus(out)).toEqual(
      new Set(['tab\there.txt', '日本語.txt']),
    );
  });

  it('handles empty input', () => {
    expect(parseDeletedFromNameStatus('')).toEqual(new Set());
  });
});

describe('parseShortstat', () => {
  it('parses the full form', () => {
    expect(
      parseShortstat(' 3 files changed, 42 insertions(+), 7 deletions(-)'),
    ).toEqual({ filesCount: 3, linesAdded: 42, linesRemoved: 7 });
  });

  it('parses additions-only and deletions-only forms', () => {
    expect(parseShortstat(' 1 file changed, 5 insertions(+)')).toEqual({
      filesCount: 1,
      linesAdded: 5,
      linesRemoved: 0,
    });
    expect(parseShortstat(' 2 files changed, 3 deletions(-)')).toEqual({
      filesCount: 2,
      linesAdded: 0,
      linesRemoved: 3,
    });
  });

  it('returns null on garbage input', () => {
    expect(parseShortstat('not a shortstat')).toBeNull();
  });
});

describe('parseGitDiff', () => {
  const sampleDiff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-removed
+added
+added two
 line three
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+hello
+world
`;

  it('produces structured hunks for each file', () => {
    const result = parseGitDiff(sampleDiff);
    expect([...result.keys()]).toEqual(['src/a.ts', 'src/b.ts']);

    const aHunks = result.get('src/a.ts')!;
    expect(aHunks).toHaveLength(1);
    expect(aHunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
    });
    expect(aHunks[0].lines).toEqual([
      ' line one',
      '-removed',
      '+added',
      '+added two',
      ' line three',
    ]);

    const bHunks = result.get('src/b.ts')!;
    expect(bHunks[0].lines).toEqual(['+hello', '+world']);
  });

  it('preserves the "\\ No newline at end of file" marker', () => {
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-line
\\ No newline at end of file
+line
`;
    const result = parseGitDiff(diff);
    expect(result.get('f.txt')![0].lines).toEqual([
      '-line',
      '\\ No newline at end of file',
      '+line',
    ]);
  });

  it('skips a stray no-newline marker before any hunk header without throwing', () => {
    // A malformed/truncated diff can carry a `\` line before any `@@`; the
    // pre-hunk guard skips it instead of throwing on a null currentHunk
    // (which would lose every subsequent file's hunks).
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
\\ No newline at end of file
@@ -1 +1 @@
-line
+line
`;
    const result = parseGitDiff(diff);
    expect(result.get('f.txt')![0].lines).toEqual(['-line', '+line']);
  });

  it('returns empty map on empty input', () => {
    expect(parseGitDiff('').size).toBe(0);
    expect(parseGitDiff('   \n').size).toBe(0);
  });

  const n = MAX_LINES_PER_FILE + 50;
  const bigDiff = `diff --git a/big.ts b/big.ts
index 1111111..2222222 100644
--- a/big.ts
+++ b/big.ts
@@ -1,${n} +1,${n} @@
${Array.from({ length: n }, (_, i) => ` line${i}`).join('\n')}
`;

  it('caps per-file lines at MAX_LINES_PER_FILE', () => {
    const hunk = parseGitDiff(bigDiff).get('big.ts')![0];
    expect(hunk.lines.length).toBe(MAX_LINES_PER_FILE);
  });

  it('records the capped file in the provided truncatedPaths set', () => {
    const truncatedPaths = new Set<string>();
    parseGitDiff(bigDiff, truncatedPaths);
    // The caller keys its `truncated` flag off this set, so it must name the
    // file that actually lost lines to the cap.
    expect(truncatedPaths.has('big.ts')).toBe(true);
  });
});

describe('fetchGitDiff', () => {
  useFreshRepo();

  it('returns null when not in a git repo', () =>
    inPlainDir(async (plain) => {
      expect(await fetchGitDiff(plain)).toBeNull();
    }));

  it('captures tracked modifications and counts lines in untracked text files', async () => {
    await commit(repo, { 'tracked.txt': 'one\ntwo\nthree\n' });
    await write(repo, {
      'tracked.txt': 'one\ntwo\nthree\nfour\n',
      'new.txt': 'brand new\nsecond\n',
    });

    const result = await diffOf(repo);
    expect(result.stats.filesCount).toBe(2);
    // Tracked: +1 from adding `four`. Untracked `new.txt`: 2 lines.
    expect(result.stats.linesAdded).toBe(3);
    expect(result.perFileStats.get('tracked.txt')?.added).toBe(1);
    expect(result.perFileStats.get('new.txt')).toEqual(untrackedEntry(2));
  });

  it('marks oversized untracked text files as truncated', async () => {
    await commit(repo, { 'seed.txt': 'x\n' });
    // 1.5 MB (15,000 × 100-byte lines) exceeds UNTRACKED_READ_CAP_BYTES
    // (1 MB), so the counter sees only part of it. The flag lets the UI mark
    // `+N` as a lower bound instead of silently under-reporting.
    const totalLines = 15_000;
    await write(repo, {
      'big.log': ('a'.repeat(99) + '\n').repeat(totalLines),
    });

    const entry = (await diffOf(repo)).perFileStats.get('big.log');
    expect(entry?.isUntracked).toBe(true);
    expect(entry?.isBinary).toBe(false);
    expect(entry?.truncated).toBe(true);
    // At most UNTRACKED_READ_CAP_BYTES / 100 = 10,000 lines were counted.
    expect(entry?.added).toBeGreaterThan(0);
    expect(entry!.added).toBeLessThan(totalLines);
  });

  it('flags untracked binary files without counting lines', async () => {
    await commit(repo, { 'seed.txt': 'x\n' });
    // A NUL byte in the first few bytes is git's own binary heuristic.
    await write(repo, { 'blob.bin': Buffer.from([0x89, 0x00, 0xff, 0x10]) });

    const result = await diffOf(repo);
    expect(result.perFileStats.get('blob.bin')).toEqual(
      untrackedEntry(0, true),
    );
    // Binary bytes must not contaminate the linesAdded total.
    expect(result.stats.linesAdded).toBe(0);
  });

  it('returns zero stats on a clean working tree', async () => {
    await commit(repo, { 'a.txt': 'hello\n' });

    const result = await diffOf(repo);
    expect(result.stats).toEqual({
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    expect(result.perFileStats.size).toBe(0);
  });

  it('returns null during a transient merge state', async () => {
    await commit(repo, { 'a.txt': 'hello\n' });
    // Fake a merge in progress by writing MERGE_HEAD.
    await write(repo, { '.git/MERGE_HEAD': ZERO_SHA });
    expect(await fetchGitDiff(repo)).toBeNull();
    expect((await fetchGitDiffHunks(repo)).size).toBe(0);
  });
});

describe('fetchGitDiffHunks', () => {
  useFreshRepo();

  it('returns hunks for modified tracked files', async () => {
    await commit(repo, { 'a.txt': 'one\ntwo\nthree\n' });
    await write(repo, { 'a.txt': 'one\nTWO\nthree\n' });
    const fileHunks = (await fetchGitDiffHunks(repo)).get('a.txt');
    expect(fileHunks).toBeDefined();
    const lines = fileHunks![0].lines;
    expect(lines.some((l: string) => l.startsWith('-two'))).toBe(true);
    expect(lines.some((l: string) => l.startsWith('+TWO'))).toBe(true);
  });

  it('preserves content lines that start with --- / +++ / index', async () => {
    await commit(repo, {
      'notes.md': 'keep\n---a/foo\n+++b/bar\nindex deadbeef\nkeep2\n',
    });
    // Remove every diff-lookalike line; they must still round-trip through
    // parseGitDiff even though their prefixes match file-header sentinels.
    await write(repo, { 'notes.md': 'keep\nkeep2\n' });
    const fileHunks = (await fetchGitDiffHunks(repo)).get('notes.md');
    expect(fileHunks).toBeDefined();
    const removed = fileHunks!.flatMap((h) =>
      h.lines.filter((l: string) => l.startsWith('-')),
    );
    expect(removed).toEqual(
      expect.arrayContaining(['----a/foo', '-+++b/bar', '-index deadbeef']),
    );
  });

  it('keys hunks by the real path for files with tabs in the name (C-quoted in diff output)', async () => {
    // Git C-quotes tabs/newlines/quotes (`+++ "b/tab\there.txt"`) even with
    // `core.quotepath=false`. Without the unquote step in `extractFilePath`,
    // fetchGitDiffHunks would silently drop the file's hunks.
    const weirdName = 'tab\there.txt';
    try {
      await write(repo, { [weirdName]: 'x\n' });
    } catch {
      return; // Filesystem refused tab in name (e.g. Windows NTFS).
    }
    await commit(repo, {});
    await write(repo, { [weirdName]: 'y\n' });

    const hunks = await fetchGitDiffHunks(repo);
    expect([...hunks.keys()]).toEqual([weirdName]);
    const lines = hunks.get(weirdName)![0].lines;
    expect(lines.some((l) => l.startsWith('-x'))).toBe(true);
    expect(lines.some((l) => l.startsWith('+y'))).toBe(true);
  });

  it('keys hunks by the real path for files whose name contains " b/"', async () => {
    await fs.mkdir(path.join(repo, 'a b'), { recursive: true });
    await commit(repo, { 'a b/c.txt': 'x\n' });
    await write(repo, { 'a b/c.txt': 'y\n' });

    const hunks = await fetchGitDiffHunks(repo);
    // `diff --git a/a b/c.txt b/a b/c.txt` is ambiguous to split; the parser
    // must anchor on `+++ b/<path>\t` instead.
    expect([...hunks.keys()]).toEqual(['a b/c.txt']);
  });

  it('handles multi-hunk diffs', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
    await commit(repo, { 'big.txt': lines.join('\n') + '\n' });
    lines[2] = 'CHANGED_EARLY';
    lines[35] = 'CHANGED_LATE';
    await write(repo, { 'big.txt': lines.join('\n') + '\n' });

    const fileHunks = (await fetchGitDiffHunks(repo)).get('big.txt');
    expect(fileHunks).toBeDefined();
    expect(fileHunks!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fetchGitDiffHunksForFile', () => {
  useFreshRepo();

  it('returns hunks for a modified tracked file', async () => {
    await commit(repo, { 'a.txt': 'one\ntwo\nthree\n' });
    await write(repo, { 'a.txt': 'one\nTWO\nthree\n' });

    const result = await hunksFor(repo, 'a.txt');
    expect(result.truncated).toBe(false);
    expect(result.hunks[0].lines.some((l) => l === '-two')).toBe(true);
    expect(result.hunks[0].lines.some((l) => l === '+TWO')).toBe(true);
  });

  it('scopes the diff to the requested file only', async () => {
    await commit(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await write(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });

    const result = await fetchGitDiffHunksForFile(repo, 'a.txt');
    expect(result!.hunks[0].lines.some((l) => l === '+A')).toBe(true);
    // b.txt's change must not leak into a.txt's hunks.
    expect(result!.hunks[0].lines.some((l) => l === '+B')).toBe(false);
  });

  it('returns null for an unchanged tracked file', async () => {
    await commit(repo, { 'a.txt': 'a\n' });
    expect(await fetchGitDiffHunksForFile(repo, 'a.txt')).toBeNull();
  });

  it('returns null during a transient merge state', async () => {
    await commit(repo, { 'a.txt': 'one\n' });
    // Fake a merge in progress; the single-file endpoint must decline just
    // like fetchGitDiff/fetchGitDiffHunks do.
    await write(repo, { 'a.txt': 'TWO\n', '.git/MERGE_HEAD': ZERO_SHA });
    expect(await fetchGitDiffHunksForFile(repo, 'a.txt')).toBeNull();
  });

  it('diffs a renamed file old→new when oldPath is provided', async () => {
    await commit(repo, { 'old.txt': 'one\ntwo\nthree\n' });
    // Rename old.txt → new.txt and edit one line.
    await fs.rm(path.join(repo, 'old.txt'));
    await write(repo, { 'new.txt': 'one\nTWO\nthree\n' });
    await git(repo, 'add', '-A');

    // With the pre-rename path, rename detection yields the actual edit
    // (-two/+TWO with one/three as context) instead of new.txt as fully added.
    const result = await hunksFor(repo, 'new.txt', 'old.txt');
    const lines = result.hunks.flatMap((h) => h.lines);
    expect(lines).toContain('-two');
    expect(lines).toContain('+TWO');
    expect(lines).toContain(' one');
    expect(lines).not.toContain('+one');
  });

  it('synthesizes an all-added hunk for an untracked file', async () => {
    await commit(repo, { 'a.txt': 'a\n' });
    await write(repo, { 'new.txt': 'x\ny\n' });

    const result = await hunksFor(repo, 'new.txt');
    expect(result.truncated).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
    });
    expect(result.hunks[0].lines).toEqual(['+x', '+y']);
  });

  const overCap = () =>
    Array.from({ length: MAX_LINES_PER_FILE + 5 }, (_, i) => `line-${i}`).join(
      '\n',
    ) + '\n';

  it('reports truncation for an untracked file past the line cap', async () => {
    await commit(repo, { 'a.txt': 'a\n' });
    await write(repo, { 'big.txt': overCap() });

    const result = await hunksFor(repo, 'big.txt');
    expect(result.truncated).toBe(true);
    expect(result.hunks[0].lines).toHaveLength(MAX_LINES_PER_FILE);
    // The capped window is the file's head, all-added.
    expect(result.hunks[0].lines[0]).toBe('+line-0');
  });

  it('reports truncation for a tracked diff past the parser line cap', async () => {
    await commit(repo, { 'a.txt': 'seed\n' });
    await write(repo, { 'a.txt': overCap() });

    const result = await hunksFor(repo, 'a.txt');
    expect(result.truncated).toBe(true);
    const total = result.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBe(MAX_LINES_PER_FILE);
  });

  it('returns null for a binary untracked file', async () => {
    await commit(repo, { 'a.txt': 'a\n' });
    await write(repo, { 'blob.bin': Buffer.from([0, 1, 2, 3]) });
    expect(await fetchGitDiffHunksForFile(repo, 'blob.bin')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'returns null for an untracked FIFO without hanging',
    async () => {
      // `ls-files --others` can list a FIFO; open() on it blocks forever
      // waiting on a writer. synthesizeUntrackedHunk must lstat-gate so
      // expanding it in the diff dialog can't hang the daemon's event loop.
      await commit(repo, { 'a.txt': 'a\n' });
      await execFileAsync('mkfifo', [path.join(repo, 'pipe')]);
      expect(await fetchGitDiffHunksForFile(repo, 'pipe')).toBeNull();
    },
  );

  it('returns null for an ignored file', async () => {
    await commit(repo, { 'a.txt': 'a\n', '.gitignore': 'ignored.log\n' });
    await write(repo, { 'ignored.log': 'secret\n' });
    expect(await fetchGitDiffHunksForFile(repo, 'ignored.log')).toBeNull();
  });

  it('rejects unsafe relative paths (traversal / empty)', async () => {
    expect(await fetchGitDiffHunksForFile(repo, '../outside.txt')).toBeNull();
    expect(await fetchGitDiffHunksForFile(repo, 'a/../../b.txt')).toBeNull();
    expect(await fetchGitDiffHunksForFile(repo, '')).toBeNull();
  });

  it('accepts an absolute path inside the repo and rejects one outside it', async () => {
    await commit(repo, { 'a.txt': 'one\ntwo\n' });
    await write(repo, { 'a.txt': 'one\nTWO\n' });

    const result = await hunksFor(repo, path.join(repo, 'a.txt'));
    expect(result.hunks[0].lines.some((l) => l === '+TWO')).toBe(true);

    // An absolute path outside the git root is rejected.
    const outside = path.join(os.tmpdir(), 'elsewhere.txt');
    expect(await fetchGitDiffHunksForFile(repo, outside)).toBeNull();
  });

  it('accepts a literal `..foo` filename at the root (not a traversal)', async () => {
    // `..foo` is not a `..` segment; the absolute-path normalization must
    // allow it (a bare startsWith('..') wrongly rejected it, so the diff
    // viewer could not render such a file).
    await commit(repo, { '..foo': 'one\ntwo\n' });
    await write(repo, { '..foo': 'one\nTWO\n' });

    const result = await hunksFor(repo, path.join(repo, '..foo'));
    expect(result.hunks[0].lines.some((l) => l === '+TWO')).toBe(true);
  });

  it('returns null outside a git repo', () =>
    inPlainDir(async (plain) => {
      expect(await fetchGitDiffHunksForFile(plain, 'a.txt')).toBeNull();
    }));
});

/** One `-x`/`+y` hunk for a C-quoted path. */
const quotedDiff = (name: string, index = '1111111..2222222') =>
  `diff --git "a/${name}" "b/${name}"
index ${index} 100644
--- "a/${name}"
+++ "b/${name}"
@@ -1 +1 @@
-x
+y
`;

describe('parseGitDiff C-quoted path support', () => {
  it('decodes `+++ "b/..."` headers for files with tabs in the name', () => {
    // Reproduces wenshao Critical (PR #3491 line 615): without C-quote
    // decoding, `extractFilePath` rejects the quoted +++ line and the
    // hunks are silently dropped.
    const diff = `diff --git "a/tab\\there.txt" "b/tab\\there.txt"
index 1111111..2222222 100644
--- "a/tab\\there.txt"
+++ "b/tab\\there.txt"
@@ -1 +1,2 @@
 a
+b
`;
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['tab\there.txt']);
    expect(result.get('tab\there.txt')![0].lines).toEqual([' a', '+b']);
  });

  it('decodes octal escapes in quoted paths (legacy quotepath=true output)', () => {
    // Even with `core.quotepath=false` on our git invocations, callers could
    // feed us output from another command. \346\226\207 is UTF-8 for `文`.
    const result = parseGitDiff(quotedDiff('\\346\\226\\207.txt'));
    expect([...result.keys()]).toEqual(['文.txt']);
  });

  it('preserves non-BMP code points in quoted paths instead of splitting surrogates', () => {
    // Reproduces wenshao Critical (PR #3491 line 504): the previous walker
    // advanced one UTF-16 code unit at a time, so a non-BMP codepoint (🚀,
    // U+1F680) next to a forced-quoting byte (here a TAB) decoded as two lone
    // surrogates → two replacement characters, corrupting the hunk key.
    const result = parseGitDiff(quotedDiff('\\t🚀.txt'));
    expect([...result.keys()]).toEqual(['\t🚀.txt']);
  });

  it('decodes the remaining C-style escapes (\\a, \\b, \\f, \\v)', () => {
    // Reproduces wenshao Critical (PR #3491 line 552): the previous switch
    // dropped the leading backslash for these escapes, turning `\a` / `\b` /
    // `\f` / `\v` into plain `a` / `b` / `f` / `v`, so the hunk key did not
    // match the real on-disk filename.
    const diff =
      quotedDiff('bell\\afile.txt') +
      quotedDiff('back\\bspace.txt', '3333333..4444444') +
      quotedDiff('form\\ffeed.txt', '5555555..6666666') +
      quotedDiff('vert\\vtab.txt', '7777777..8888888');
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual([
      'bell\x07file.txt',
      'back\x08space.txt',
      'form\x0cfeed.txt',
      'vert\x0btab.txt',
    ]);
  });
});

describe('parseGitDiff path disambiguation', () => {
  it('keys hunks by the real path when the filename contains " b/"', () => {
    // `a b/c.txt` produces `diff --git a/a b/c.txt b/a b/c.txt`, which is
    // ambiguous to split on ` b/`. Git appends a TAB on the `---`/`+++` lines
    // when the path contains whitespace — that's the unambiguous anchor.
    const diff = `diff --git a/a b/c.txt b/a b/c.txt
index 111..222 100644
--- a/a b/c.txt\t
+++ b/a b/c.txt\t
@@ -1 +1 @@
-x
+y
`;
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['a b/c.txt']);
    expect(result.get('a b/c.txt')![0].lines).toEqual(['-x', '+y']);
  });

  it('uses `rename to` for renames, ignoring the ambiguous header', () => {
    const diff = `diff --git a/old name.txt b/renamed name.txt
similarity index 100%
rename from old name.txt
rename to renamed name.txt
`;
    // No hunks, so nothing to key, but the extractor must not confuse paths.
    // The block is dropped for lack of `@@` lines, the existing behavior for
    // mode-only / rename-only changes.
    const result = parseGitDiff(diff);
    expect(result.size).toBe(0);
  });

  it('falls back to `--- a/<path>` when the file was deleted', () => {
    const diff = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 111..000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
    expect([...parseGitDiff(diff).keys()]).toEqual(['gone.txt']);
  });

  it('uses `+++ b/<path>` for newly-created files', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 000..111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hi
`;
    expect([...parseGitDiff(diff).keys()]).toEqual(['new.txt']);
  });
});

describe('parseGitDiff edge cases', () => {
  it('drops file blocks that have no `@@` hunk header', () => {
    const noHunk = `diff --git a/foo.ts b/foo.ts
old mode 100644
new mode 100755
`;
    expect(parseGitDiff(noHunk).size).toBe(0);
  });

  it('stops collecting once MAX_FILES files have been parsed', () => {
    const blocks: string[] = [];
    for (let i = 0; i < MAX_FILES + 5; i++) {
      blocks.push(
        `diff --git a/f${i}.ts b/f${i}.ts
--- a/f${i}.ts
+++ b/f${i}.ts
@@ -1,1 +1,1 @@
-x
+y
`,
      );
    }
    const result = parseGitDiff(blocks.join(''));
    expect(result.size).toBe(MAX_FILES);
  });
});

describe('parseGitDiff size/line caps', () => {
  it('skips files whose raw diff exceeds MAX_DIFF_SIZE_BYTES', () => {
    const header = `diff --git a/small.ts b/small.ts
--- a/small.ts
+++ b/small.ts
@@ -1,1 +1,1 @@
-a
+b
`;
    const bigBody = 'x'.repeat(MAX_DIFF_SIZE_BYTES + 10);
    const bigDiff = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,1 +1,1 @@
-${bigBody}
+b
`;
    const result = parseGitDiff(header + bigDiff);
    expect(result.has('small.ts')).toBe(true);
    expect(result.has('big.ts')).toBe(false);
  });
});

describe('resolveGitDir', () => {
  useFreshRepo();

  it('returns the .git directory for a regular repo', async () => {
    const resolved = await resolveGitDir(repo);
    expect(resolved).toBe(path.join(repo, '.git'));
  });

  it('follows the gitdir pointer for linked worktrees', async () => {
    await commit(repo, { 'a.txt': 'hi\n' });
    const wtPath = await addWorktree(repo);

    const resolved = await resolveGitDir(wtPath);
    expect(resolved).not.toBeNull();
    // Git writes the linked-worktree pointer with forward slashes even on
    // Windows (`gitdir: C:/.../main/.git/worktrees/wt`) and we surface it
    // verbatim, so match either separator.
    expect(resolved).toMatch(/[/\\]\.git[/\\]worktrees[/\\]/);

    // A merge in progress inside the linked worktree's gitdir must make
    // `fetchGitDiff` short-circuit; this would silently fail if transient
    // detection only looked at `<wt>/.git/MERGE_HEAD`.
    await fs.writeFile(path.join(resolved!, 'MERGE_HEAD'), ZERO_SHA);
    expect(await fetchGitDiff(wtPath)).toBeNull();
  });
});

describe('getGitWorkingTreeStatus stash count in a linked worktree', () => {
  useFreshRepo({ 'a.txt': 'hi\n' });
  beforeEach(async () => {
    // Two entries so the assertion cannot pass on an off-by-one.
    await write(repo, { 'a.txt': 'one\n' });
    await git(repo, 'stash', '-q');
    await write(repo, { 'a.txt': 'two\n' });
    await git(repo, 'stash', '-q');
  });

  it('counts the shared stash from inside a linked worktree', async () => {
    const wtPath = await addWorktree(repo);
    // The stash is one ref for the whole repository, so `git stash list`
    // reports both entries from either working tree. Reading the reflog from
    // the per-worktree gitdir found nothing and reported 0.
    expect((await getGitWorkingTreeStatus(wtPath))?.stashCount).toBe(2);
    // Same number from the main worktree: the two must not diverge.
    expect((await getGitWorkingTreeStatus(repo))?.stashCount).toBe(2);
  });

  it('still reports the per-worktree operation, not the shared one', async () => {
    // Guards against over-correcting: only refs are shared. MERGE_HEAD and
    // friends are per-worktree, so redirecting everything to the common dir
    // would make a merge in one worktree appear in all of them.
    const wtPath = await addWorktree(repo);
    await write(repo, { '.git/MERGE_HEAD': ZERO_SHA });

    expect((await getGitWorkingTreeStatus(repo))?.operation).toBe('merge');
    expect((await getGitWorkingTreeStatus(wtPath))?.operation).toBeUndefined();
  });

  it('still counts the stash in a plain repository', async () => {
    expect((await getGitWorkingTreeStatus(repo))?.stashCount).toBe(2);
  });
});

describe('fetchGitDiff transient-state detection', () => {
  useFreshRepo({ 'a.txt': 'hi\n' });

  it.each([
    ['CHERRY_PICK_HEAD', 'file'],
    ['REVERT_HEAD', 'file'],
    ['rebase-merge', 'dir'],
    ['rebase-apply', 'dir'],
  ] as const)('short-circuits when %s is present (%s)', async (name, kind) => {
    const target = path.join(repo, '.git', name);
    if (kind === 'dir') {
      await fs.mkdir(target);
    } else {
      await fs.writeFile(target, '0\n');
    }
    expect(await fetchGitDiff(repo)).toBeNull();
    expect((await fetchGitDiffHunks(repo)).size).toBe(0);
  });
});

describe('fetchGitDiff tracked-file filename robustness', () => {
  useFreshRepo();

  it('keeps the real filename for tracked files that contain a tab', async () => {
    const weirdName = 'tab\there.txt';
    try {
      await write(repo, { [weirdName]: 'x\n' });
    } catch {
      return; // Filesystem refused the name; nothing to assert.
    }
    await commit(repo, {});
    await write(repo, { [weirdName]: 'y\n' });

    const result = await diffOf(repo);
    // Plain --numstat would C-quote this as `"tab\\there.txt"` and the key
    // would not match the real path; `--numstat -z` gives the raw bytes.
    expect(result.perFileStats.has(weirdName)).toBe(true);
    expect(result.perFileStats.has(`"tab\\there.txt"`)).toBe(false);
  });

  it('keys a rename by its new path and carries the old path', async () => {
    await commit(repo, { 'old.txt': 'x\n' });
    await git(repo, 'mv', 'old.txt', 'new.txt');

    const result = await diffOf(repo);
    // Keyed by the current path so the row can expand; the old path is
    // carried for display instead of the synthetic `old => new` string
    // (which git cannot address).
    expect(result.perFileStats.get('new.txt')?.oldPath).toBe('old.txt');
  });
});

describe('parseShortstat ReDoS guard', () => {
  it('runs in bounded time on pathological input', () => {
    // CodeQL #137 flagged the previous regex as polynomial on many `0`s.
    // After hardening (anchors + bounded digit runs), even 1e5 `0`s parse fast.
    const adversarial = `${'0'.repeat(100_000)} files changed, ${'0'.repeat(
      100_000,
    )} insertions(+)`;
    const start = Date.now();
    const result = parseShortstat(adversarial);
    const elapsed = Date.now() - start;
    // The bounded regex either rejects (too long for \d{1,10}) or matches
    // trivially; either way it must not spin.
    expectWithinLatencyBudget(elapsed, 250, { poolMultiplier: 20 });
    expect(result).toBeNull();
  });
});

describe('fetchGitDiff non-ASCII filenames', () => {
  useFreshRepo();

  it('does not octal-escape UTF-8 filenames via core.quotepath', async () => {
    const fname = '日本語.txt';
    await commit(repo, { [fname]: 'alpha\n' });
    await write(repo, { [fname]: 'beta\n' });

    const result = await diffOf(repo);
    expect(result.perFileStats.has(fname)).toBe(true);
    // Make sure we didn't end up with an octal-escaped key instead.
    for (const key of result.perFileStats.keys()) {
      expect(key).not.toMatch(/\\\d{3}/);
    }
  });
});

describe('fetchGitDiff untracked with special filenames', () => {
  useFreshRepo({ 'seed.txt': 'x\n' });

  it('counts an untracked file whose name contains a newline as one entry', async () => {
    // Some (e.g. Windows) filesystems reject `\n` in names; POSIX accepts it.
    const weirdName = 'line1\nline2.txt';
    try {
      await write(repo, { [weirdName]: 'content\n' });
    } catch {
      // Filesystem refused newline in name — nothing to assert here.
      return;
    }

    const result = await diffOf(repo);
    // Without `-z`, `ls-files` would quote this as `"line1\nline2.txt"` and
    // split-on-\n would produce two phantom entries. With `-z` we get exactly
    // one entry, keyed by the real name.
    expect(result.stats.filesCount).toBe(1);
    expect(result.perFileStats.has(weirdName)).toBe(true);
  });
});

describe('fetchGitDiff invocation from a subdirectory', () => {
  useFreshRepo();

  it('returns repo-wide changes with consistent repo-root-relative path keys', async () => {
    // Reproduces wenshao Critical (PR #3491 line 63): from a subdir,
    // `git diff --numstat` emitted repo-root-relative keys but
    // `ls-files --others` was scoped to cwd, so untracked files outside the
    // subdir were silently dropped and the path basis was inconsistent.
    await fs.mkdir(path.join(repo, 'sub'), { recursive: true });
    await commit(repo, { 'sub/tracked.txt': 'x\n', 'rootkeep.txt': 'k\n' });
    await write(repo, {
      'sub/tracked.txt': 'y\n', // tracked, modified inside the subdir
      'rootnew.txt': 'fresh\n', // untracked, at the repo root
      'sub/subnew.txt': 'a\nb\n', // untracked, inside the subdir
    });

    // Invoke fetchGitDiff with cwd pointing at the SUBDIR, not the root.
    const result = await diffOf(path.join(repo, 'sub'));
    const keys = [...result.perFileStats.keys()].sort();
    // All keys must be repo-root-relative (not bare "tracked.txt" or
    // "subnew.txt"), and the root-level untracked file must be present even
    // though we asked from sub/.
    expect(keys).toEqual(['rootnew.txt', 'sub/subnew.txt', 'sub/tracked.txt']);
    expect(result.stats.filesCount).toBe(3);
  });
});

describe('fetchGitDiff fast path with untracked-only workspaces', () => {
  useFreshRepo({ 'seed.txt': 'x\n' });

  it('takes the >MAX_FILES_FOR_DETAILS short-circuit when shortstat is empty', async () => {
    // Reproduces wenshao Critical (PR #3491 line 146). 0 tracked changes +
    // many untracked left `quickStats` null, so the fast path was skipped and
    // the slow path under-reported `linesAdded` (it line-counted only the
    // first MAX_FILES untracked files). The fix makes the threshold fire on
    // tracked + untracked even when shortstat returns nothing. Here: 501
    // untracked files (just over MAX_FILES_FOR_DETAILS = 500), 0 tracked.
    const N = 501;
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      writes.push(fs.writeFile(path.join(repo, `u${i}.txt`), 'a\n'));
    }
    await Promise.all(writes);

    const result = await diffOf(repo);
    // Header includes every untracked file in `filesCount`.
    expect(result.stats.filesCount).toBe(N);
    // `perFileStats` is empty because we took the summary-only path, which is
    // the whole point of the guardrail.
    expect(result.perFileStats.size).toBe(0);
  });
});

describe('fetchGitDiffHunks ignores external diff drivers', () => {
  useFreshRepo();
  let sentinel: string;
  beforeEach(() => {
    sentinel = path.join(os.tmpdir(), `qwen-driver-fired-${Date.now()}`);
  });
  afterEach(() => fs.rm(sentinel, { force: true }));

  /** Driver script in the repo that writes the sentinel when invoked. */
  async function plantDriver(name: string, tail = ''): Promise<string> {
    const script = path.join(repo, name);
    await fs.writeFile(
      script,
      `#!/bin/sh\necho fired > "${sentinel}"\n${tail}`,
      {
        mode: 0o755,
      },
    );
    return script;
  }
  // ENOENT means the driver never ran.
  const driverFired = () =>
    fs.stat(sentinel).then(
      () => true,
      () => false,
    );

  it('does not invoke GIT_EXTERNAL_DIFF when reading hunks', async () => {
    // Reproduces wenshao Critical (PR #3491 line 219). Plain `git diff`
    // honors `GIT_EXTERNAL_DIFF` / `diff.<name>.command`, so a malicious
    // worktree could run arbitrary commands when a caller only wants to
    // inspect hunks. The fix is `--no-ext-diff`; the planted env-var driver
    // touches a sentinel file that must never appear.
    await commit(repo, { 'a.txt': 'one\n' });
    await write(repo, { 'a.txt': 'two\n' });
    const driverScript = await plantDriver('evil-diff.sh');

    // runGit's child processes inherit our env.
    vi.stubEnv('GIT_EXTERNAL_DIFF', driverScript);
    try {
      const hunks = await fetchGitDiffHunks(repo);
      expect(hunks.get('a.txt')).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await driverFired()).toBe(false);
  });

  it('does not invoke textconv drivers when reading hunks', async () => {
    // Reproduces wenshao Critical (PR #3491 line 282). `--no-ext-diff` blocks
    // GIT_EXTERNAL_DIFF / diff.<name>.command but NOT textconv filters set
    // via .gitattributes + `diff.<name>.textconv`. Without `--no-textconv`,
    // a malicious worktree can still execute commands when this runs.
    const driverScript = await plantDriver(
      'evil-textconv.sh',
      'cat "$1" 2>/dev/null\n',
    );
    await git(repo, 'config', 'diff.evil.textconv', driverScript);
    await commit(repo, {
      '.gitattributes': '*.pdf diff=evil\n',
      'doc.pdf': 'a\n',
    });
    await write(repo, { 'doc.pdf': 'b\n' });

    const hunks = await fetchGitDiffHunks(repo);
    expect(hunks.get('doc.pdf')).toBeDefined();
    expect(await driverFired()).toBe(false);
  });
});

describe('fetchGitDiff deletion detection', () => {
  useFreshRepo();

  it('marks tracked files removed from the worktree as isDeleted', async () => {
    await commit(repo, {
      'kept.txt': 'one\ntwo\n',
      'gone.txt': 'a\nb\nc\n',
      'gone.bin': Buffer.from([0x89, 0x00, 0xff]),
    });
    // Modify one tracked file (heavy edit), and remove two others.
    await write(repo, { 'kept.txt': '' });
    await fs.rm(path.join(repo, 'gone.txt'));
    await fs.rm(path.join(repo, 'gone.bin'));

    const result = await diffOf(repo);
    // A heavy edit must NOT be marked deleted, even though its numstat
    // `0\t2\tkept.txt` looks identical to a delete.
    expect(result.perFileStats.get('kept.txt')?.isDeleted).toBeFalsy();
    expect(result.perFileStats.get('gone.txt')?.isDeleted).toBe(true);
    expect(result.perFileStats.get('gone.bin')).toMatchObject({
      isBinary: true,
      isDeleted: true,
    });
  });

  it('does not mark either side of a rename as deleted', async () => {
    await commit(repo, { 'old.txt': 'x\n' });
    await git(repo, 'mv', 'old.txt', 'new.txt');

    const result = await diffOf(repo);
    // The rename collapses to one entry keyed by the new path (old path
    // carried for display); it must not be flagged as deleted.
    expect(result.perFileStats.get('new.txt')?.oldPath).toBe('old.txt');
    for (const s of result.perFileStats.values()) {
      expect(s.isDeleted).toBeFalsy();
    }
  });
});

describe('fetchGitDiff special filetypes among untracked files', () => {
  useFreshRepo({ 'seed.txt': 'x\n' });

  it('marks untracked symlinks as binary and never follows them', () =>
    // Reproduces wenshao Critical (PR #3491 line 455): without an lstat gate,
    // `open()` would dereference an untracked symlink and read its target,
    // which can live outside the worktree. The outside target has content
    // that would push linesAdded up if it were followed.
    inPlainDir(async (outside) => {
      await write(outside, { 'secret.txt': 'one\ntwo\nthree\n' });
      await fs.symlink(
        path.join(outside, 'secret.txt'),
        path.join(repo, 'link.txt'),
      );

      const result = await diffOf(repo);
      const entry = result.perFileStats.get('link.txt');
      expect(entry).toBeDefined();
      expect(entry?.isBinary).toBe(true);
      expect(entry?.isUntracked).toBe(true);
      // No content from the symlink target leaked into the totals.
      expect(result.stats.linesAdded).toBe(0);
    }));
});

describe('fetchGitDiff untracked counting', () => {
  useFreshRepo({ 'seed.txt': 'x\n' });

  it('aggregates untracked line counts into linesAdded even when the per-file map is full of tracked entries', async () => {
    // Saturate the per-file map with MAX_FILES modified tracked files, then
    // add untracked files that get cut out of the display slots; their line
    // counts must still land in `stats.linesAdded`.
    for (let i = 0; i < MAX_FILES; i++) {
      await write(repo, { [`t${i}.txt`]: `hello${i}\n` });
    }
    await commit(repo, {}, 'seed');
    for (let i = 0; i < MAX_FILES; i++) {
      await write(repo, { [`t${i}.txt`]: `HELLO${i}\n` });
    }
    // Each untracked file has 3 lines; 5 files × 3 = 15 lines we must keep.
    const untrackedCount = 5;
    const linesPerFile = 3;
    for (let i = 0; i < untrackedCount; i++) {
      await write(repo, { [`u${i}.txt`]: 'a\nb\nc\n' });
    }

    const result = await diffOf(repo);
    expect(result.stats.filesCount).toBe(MAX_FILES + untrackedCount);
    // The per-file map stays capped (t* entries fill every slot, so no u*
    // entry is visible), but the totals include the untracked additions.
    expect(result.perFileStats.size).toBe(MAX_FILES);
    const trackedLinesAdded = MAX_FILES; // each t* gained 1 char → numstat 1/1
    expect(result.stats.linesAdded).toBe(
      trackedLinesAdded + untrackedCount * linesPerFile,
    );
  });

  it('line-counts every untracked file in the slow path, not just the first MAX_FILES', async () => {
    // Regression for under-counted totals: with 0 tracked changes and 51-500
    // untracked files, the slow path read line counts only for
    // `untrackedPaths.slice(0, MAX_FILES)`, so files past the display cap
    // dropped out of `stats.linesAdded`. MAX_FILES + 10 one-line files here.
    const totalUntracked = MAX_FILES + 10;
    for (let i = 0; i < totalUntracked; i++) {
      // Padded names keep `ls-files --others` order stable; otherwise the
      // "first MAX_FILES" slice in the bug case could randomly cover them.
      const name = `u${String(i).padStart(3, '0')}.txt`;
      await write(repo, { [name]: 'one-line\n' });
    }
    const result = await diffOf(repo);
    expect(result.stats.filesCount).toBe(totalUntracked);
    // One line each, so totals must equal totalUntracked (pre-fix: MAX_FILES).
    expect(result.stats.linesAdded).toBe(totalUntracked);
    // Visible per-file rows still cap at MAX_FILES.
    expect(result.perFileStats.size).toBe(MAX_FILES);
  });
});

describe('parseStatusBranchLine', () => {
  const main = { branch: 'main', detached: false, hasUpstream: true };
  it.each([
    [
      'parses branch with upstream and ahead/behind',
      '## main...origin/main [ahead 2, behind 1]',
      { ...main, ahead: 2, behind: 1 },
    ],
    [
      'parses a local branch with no upstream',
      '## feature/foo',
      { ...main, branch: 'feature/foo', hasUpstream: false },
    ],
    [
      'parses upstream tracking with no divergence',
      '## main...origin/main',
      main,
    ],
    // Git forbids `..` in ref names so a real branch can't contain `...`, but
    // the split must use the last `...` (the branch/upstream separator) so a
    // dotted branch name isn't truncated at the first `...`.
    [
      'splits the branch from upstream at the last "..."',
      '## fix...feature...origin/main',
      { ...main, branch: 'fix...feature' },
    ],
    [
      'treats a gone upstream as tracked with zero divergence',
      '## main...origin/main [gone]',
      main,
    ],
    [
      'detects a detached HEAD',
      '## HEAD (no branch)',
      { branch: null, detached: true, hasUpstream: false },
    ],
    [
      'returns empty for a non-header line',
      ' M src/foo.ts',
      { branch: null, detached: false, hasUpstream: false },
    ],
  ])('%s', (_title, line, expected) => {
    expect(parseStatusBranchLine(line)).toEqual({
      ahead: 0,
      behind: 0,
      ...expected,
    });
  });

  it('parses ahead-only and behind-only brackets', () => {
    expect(
      parseStatusBranchLine('## main...origin/main [ahead 3]'),
    ).toMatchObject({ ahead: 3, behind: 0 });
    expect(
      parseStatusBranchLine('## main...origin/main [behind 5]'),
    ).toMatchObject({ ahead: 0, behind: 5 });
  });

  it('reads the branch from an unborn / initial-commit header', () => {
    expect(parseStatusBranchLine('## No commits yet on main')).toMatchObject({
      branch: 'main',
      detached: false,
    });
    expect(parseStatusBranchLine('## Initial commit on dev')).toMatchObject({
      branch: 'dev',
      detached: false,
    });
  });
});

describe('parseStatusEntries', () => {
  it('counts staged, unstaged, and untracked separately', () => {
    const tokens = [
      'M  staged-mod.ts', // staged modification
      ' M unstaged-mod.ts', // unstaged modification
      'MM both.ts', // staged then further modified
      'A  added.ts', // staged new file
      '?? new.txt', // untracked
    ];
    expect(parseStatusEntries(tokens)).toEqual({
      staged: 3, // staged-mod, both, added
      unstaged: 2, // unstaged-mod, both
      untracked: 1,
      conflicted: 0,
    });
  });

  it('counts unmerged entries as conflicted, not staged/unstaged', () => {
    const tokens = [
      'UU both-modified.ts', // both sides modified
      'AA both-added.ts', // both added
      'DU deleted-by-us.ts', // deleted by us
      'M  clean-staged.ts', // a normal staged change
    ];
    expect(parseStatusEntries(tokens)).toEqual({
      staged: 1, // clean-staged only
      unstaged: 0,
      untracked: 0,
      conflicted: 3,
    });
  });

  it('skips the second path of a rename without double counting', () => {
    const tokens = ['R  old.ts', 'new.ts', ' M other.ts'];
    expect(parseStatusEntries(tokens)).toEqual({
      staged: 1, // the rename
      unstaged: 1, // other.ts
      untracked: 0,
      conflicted: 0,
    });
  });

  it('returns all zeros for no entries', () => {
    expect(parseStatusEntries([])).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });
  });
});

describe('getGitWorkingTreeStatus', () => {
  useFreshRepo();

  it('returns null when not in a git repo', () =>
    inPlainDir(async (plain) => {
      expect(await getGitWorkingTreeStatus(plain)).toBeNull();
    }));

  it('reports a clean repo on its branch with zero counts', async () => {
    await commit(repo, { 'a.txt': 'one\n' });

    const status = await getGitWorkingTreeStatus(repo);
    expect(status).toEqual({
      branch: 'main',
      detached: false,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
    });
  });

  it('counts staged, unstaged, and untracked changes', async () => {
    await commit(repo, { 'a.txt': 'one\n', 'b.txt': 'one\n' });
    // Stage a change to a.txt, leave b.txt modified-but-unstaged, add new.txt.
    await write(repo, { 'a.txt': 'one\ntwo\n' });
    await git(repo, 'add', 'a.txt');
    await write(repo, { 'b.txt': 'one\ntwo\n', 'new.txt': 'hi\n' });

    const status = await getGitWorkingTreeStatus(repo);
    expect(status).toMatchObject({
      branch: 'main',
      staged: 1, // a.txt
      unstaged: 1, // b.txt
      untracked: 1, // new.txt
    });
  });

  it('detects a detached HEAD', async () => {
    await commit(repo, { 'a.txt': 'one\n' }, 'c1');
    const sha = await headSha(repo);
    await commit(repo, { 'a.txt': 'one\ntwo\n' }, 'c2');
    await git(repo, 'checkout', '-q', sha);

    const status = await getGitWorkingTreeStatus(repo);
    expect(status).toMatchObject({ detached: true, branch: null });
  });

  it('counts stash entries', async () => {
    await commit(repo, { 'a.txt': 'one\n' });
    await write(repo, { 'a.txt': 'one\ntwo\n' });
    await git(repo, 'stash', 'push', '-q');

    const status = await getGitWorkingTreeStatus(repo);
    expect(status).toMatchObject({ stashCount: 1, unstaged: 0 });
  });

  // Many git subprocesses (bare init, push, clone, fetch) make this slower
  // than the default 5s budget; the logic is unchanged, it just needs time.
  it(
    'reports ahead/behind against an upstream',
    () =>
      inPlainDir((remote) =>
        inPlainDir(async (other) => {
          await git(remote, 'init', '--bare', '-q', '-b', 'main');
          await commit(repo, { 'a.txt': '1\n' }, 'c1');
          await git(repo, 'remote', 'add', 'origin', remote);
          await git(repo, 'push', '-q', '-u', 'origin', 'main');

          // Local-only commit → ahead 1.
          await commit(repo, { 'a.txt': '2\n' }, 'c2-local');

          // Diverge the remote from a clone, then fetch → behind 1.
          await execFileAsync('git', ['clone', '-q', remote, other]);
          await git(other, 'config', 'user.email', 'o@example.com');
          await git(other, 'config', 'user.name', 'Other');
          await commit(other, { 'a.txt': 'remote\n' }, 'c3-remote');
          await git(other, 'push', '-q', 'origin', 'main');
          await git(repo, 'fetch', '-q', 'origin');

          const status = await getGitWorkingTreeStatus(repo);
          expect(status).toMatchObject({
            branch: 'main',
            hasUpstream: true,
            ahead: 1,
            behind: 1,
          });
        }),
      ),
    20000,
  );

  it.each([
    [
      'surfaces an in-progress merge instead of returning null',
      'MERGE_HEAD',
      'sha',
      { branch: 'main', operation: 'merge' },
    ],
    [
      'detects an in-progress rebase (rebase-merge dir)',
      'rebase-merge',
      'dir',
      { operation: 'rebase' },
    ],
    // `git am` (and an interrupted `git rebase --apply`) creates rebase-apply;
    // detectGitOperation maps it to 'rebase' too.
    [
      'detects an in-progress rebase (rebase-apply dir, e.g. git am)',
      'rebase-apply',
      'dir',
      { operation: 'rebase' },
    ],
    [
      'detects an in-progress cherry-pick',
      'CHERRY_PICK_HEAD',
      'sha',
      { operation: 'cherry-pick' },
    ],
    [
      'detects an in-progress revert',
      'REVERT_HEAD',
      'sha',
      { operation: 'revert' },
    ],
    [
      'detects an in-progress bisect',
      'BISECT_LOG',
      'bisect\n',
      { operation: 'bisect' },
    ],
  ])('%s', async (_title, name, marker, expected) => {
    await commit(repo, { 'a.txt': 'one\n' });
    const target = path.join(repo, '.git', name);
    if (marker === 'dir') {
      await fs.mkdir(target);
    } else {
      const content = marker === 'sha' ? `${await headSha(repo)}\n` : marker;
      await fs.writeFile(target, content);
    }

    const status = await getGitWorkingTreeStatus(repo);
    expect(status).toMatchObject(expected);
  });
});

describe('fetchGitLog', () => {
  useFreshRepo();
  const subjects = async (options?: Parameters<typeof fetchGitLog>[1]) =>
    (await fetchGitLog(repo, options))!.entries.map((e) => e.subject);

  it('returns null for a non-repo directory', () =>
    inPlainDir(async (dir) => {
      expect(await fetchGitLog(dir)).toBeNull();
    }));

  it('returns empty list for a repo with no commits', async () => {
    const result = await fetchGitLog(repo);
    expect(result).toEqual({ entries: [], hasMore: false });
  });

  it('returns commits newest-first with correct fields', async () => {
    await commit(repo, { 'a.txt': 'one\n' }, 'first commit');
    await commit(repo, { 'b.txt': 'two\n' }, 'second commit');

    const result = await fetchGitLog(repo);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(2);
    expect(result!.hasMore).toBe(false);

    const newest = result!.entries[0];
    expect(newest.subject).toBe('second commit');
    expect(newest.authorName).toBe('Test');
    expect(newest.authorEmail).toBe('test@example.com');
    expect(newest.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(newest.shortSha.length).toBeGreaterThanOrEqual(7);
    expect(newest.authorDate).toBeGreaterThan(0);
    expect(newest.parents).toHaveLength(1);

    const oldest = result!.entries[1];
    expect(oldest.subject).toBe('first commit');
    expect(oldest.parents).toHaveLength(0);
  }, 15_000);

  it('paginates with limit and hasMore', async () => {
    for (let i = 0; i < 5; i++) {
      await commit(repo, { [`f${i}.txt`]: `${i}\n` }, `commit ${i}`);
    }

    const page1 = await fetchGitLog(repo, { limit: 3 });
    expect(page1!.entries).toHaveLength(3);
    expect(page1!.hasMore).toBe(true);
    expect(page1!.entries[0].subject).toBe('commit 4');

    const page2 = await fetchGitLog(repo, { limit: 3, skip: 3 });
    expect(page2!.entries).toHaveLength(2);
    expect(page2!.hasMore).toBe(false);
    expect(page2!.entries[0].subject).toBe('commit 1');
  }, 15_000);

  it('respects limit and clamps edge values', async () => {
    for (let i = 0; i < 3; i++) {
      await commit(repo, { [`f${i}.txt`]: `${i}\n` }, `c${i}`);
    }

    const limited = await fetchGitLog(repo, { limit: 2 });
    expect(limited!.entries).toHaveLength(2);
    expect(limited!.hasMore).toBe(true);

    const clamped = await fetchGitLog(repo, { limit: 0 });
    expect(clamped!.entries).toHaveLength(1);
  }, 15_000);

  it('includes refs for HEAD', async () => {
    await commit(repo, { 'a.txt': 'x\n' }, 'c1');

    const result = await fetchGitLog(repo);
    expect(result!.entries[0].refs).toContain('HEAD');
    expect(result!.entries[0].refs).toContain('main');
  });

  it('preserves a unit separator in the commit subject', async () => {
    const subject = 'subject\x1ftail';
    await commit(repo, { 'a.txt': 'x\n' }, subject);

    const result = await fetchGitLog(repo);
    expect(result!.entries[0].subject).toBe(subject);
    expect(result!.entries[0].refs).toContain('HEAD');
    expect(result!.entries[0].parents).toHaveLength(0);
  });
  it('walks every branch and tag with `all`, children before parents', async () => {
    await commit(repo, { 'a.txt': 'x\n' }, 'base');
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await commit(repo, { 'f.txt': 'f\n' }, 'feature work');
    await git(repo, 'tag', 'v1');
    await git(repo, 'checkout', '-q', 'main');

    expect(await subjects()).toEqual(['base']);

    const all = await fetchGitLog(repo, { all: true });
    expect(all!.entries.map((e) => e.subject)).toEqual([
      'feature work',
      'base',
    ]);
    expect(all!.entries[0].refs).toContain('feature');
    expect(all!.entries[0].refs).toContain('v1');
  }, 15_000);

  it('ignores an unsafe range instead of passing it to git', async () => {
    await commit(repo, { 'a.txt': 'x\n' }, 'only');

    expect(await subjects({ range: '--output=/tmp/x' })).toEqual(['only']);
  });

  it('searches message, author, and hash prefix as a union', async () => {
    await commit(repo, { 'a.txt': 'x\n' }, 'Add parser');
    await write(repo, { 'b.txt': 'y\n' });
    await git(repo, 'add', '.');
    const asGrace = ['-c', 'user.name=Grace Hopper'];
    await git(repo, ...asGrace, 'commit', '-q', '-m', 'Fix typo');
    await commit(repo, { 'c.txt': 'z\n' }, 'Unrelated [a.b]');
    const unfiltered = await fetchGitLog(repo);
    const parserSha = unfiltered!.entries.find(
      (e) => e.subject === 'Add parser',
    )!.sha;

    expect(await subjects({ search: 'PARSER' })).toEqual(['Add parser']);
    expect(await subjects({ search: 'hopper' })).toEqual(['Fix typo']);

    const byHash = await fetchGitLog(repo, { search: parserSha.slice(0, 7) });
    expect(byHash!.entries.map((e) => e.sha)).toEqual([parserSha]);

    // Fixed-string matching: regex metacharacters are literal.
    expect(await subjects({ search: '[a.b]' })).toEqual(['Unrelated [a.b]']);

    const none = await fetchGitLog(repo, { search: 'zzz-no-such' });
    expect(none).toEqual({ entries: [], hasMore: false });
  }, 20_000);

  it('pages search results newest-first with hasMore', async () => {
    for (let i = 0; i < 4; i++) {
      await commit(repo, { [`f${i}.txt`]: `${i}\n` }, `match ${i}`);
    }
    const page1 = await fetchGitLog(repo, { search: 'match', limit: 3 });
    expect(page1!.entries.map((e) => e.subject)).toEqual([
      'match 3',
      'match 2',
      'match 1',
    ]);
    expect(page1!.hasMore).toBe(true);
    const page2 = await fetchGitLog(repo, {
      search: 'match',
      limit: 3,
      skip: 3,
    });
    expect(page2!.entries.map((e) => e.subject)).toEqual(['match 0']);
    expect(page2!.hasMore).toBe(false);
  }, 15_000);
});

describe('fetchGitCommitDetail', () => {
  useFreshRepo();

  /** Commit detail for the newest commit, addressed by fetchGitLog's sha. */
  const headDetail = async () =>
    fetchGitCommitDetail(repo, (await fetchGitLog(repo))!.entries[0].sha);

  it('returns null for invalid sha', async () => {
    expect(await fetchGitCommitDetail(repo, 'not-a-sha')).toBeNull();
    expect(await fetchGitCommitDetail(repo, 'abc')).toBeNull();
    expect(await fetchGitCommitDetail(repo, '')).toBeNull();
  });

  it('returns null for a non-repo directory', () =>
    inPlainDir(async (dir) => {
      expect(await fetchGitCommitDetail(dir, 'abcdef1')).toBeNull();
    }));

  it('returns detail with body and file stats', async () => {
    await commit(
      repo,
      { 'a.txt': 'line1\nline2\nline3\n' },
      'subject line\n\nBody paragraph here.',
    );

    const log = await fetchGitLog(repo);
    const sha = log!.entries[0].sha;

    const detail = await fetchGitCommitDetail(repo, sha);
    expect(detail).not.toBeNull();
    expect(detail!.sha).toBe(sha);
    expect(detail!.subject).toBe('subject line');
    expect(detail!.body).toContain('Body paragraph here.');
    expect(detail!.authorName).toBe('Test');
    expect(detail!.filesCount).toBe(1);
    expect(detail!.linesAdded).toBe(3);
    expect(detail!.linesRemoved).toBe(0);
    expect(detail!.files).toHaveLength(1);
    expect(detail!.files[0].path).toBe('a.txt');
    expect(detail!.files[0].added).toBe(3);
    expect(detail!.files[0].isBinary).toBe(false);
    expect(detail!.hiddenCount).toBe(0);
  });

  it('preserves unit separators in the subject and body', async () => {
    const subject = 'subject\x1ftail';
    const body = 'body\x1ftail';
    await commit(repo, { 'a.txt': 'x\n' }, `${subject}\n\n${body}`);

    const detail = await headDetail();
    expect(detail!.subject).toBe(subject);
    expect(detail!.body).toBe(body);
    expect(detail!.refs).toContain('HEAD');
    expect(detail!.parents).toHaveLength(0);
  });

  it('handles root commit (no parent)', async () => {
    await commit(repo, { 'init.txt': 'hello\n' }, 'root');

    const detail = await headDetail();
    expect(detail).not.toBeNull();
    expect(detail!.parents).toHaveLength(0);
    expect(detail!.filesCount).toBe(1);
    expect(detail!.files[0].path).toBe('init.txt');
  });

  it('detects binary files', async () => {
    // Git needs a reasonable amount of NUL-containing data to classify as binary.
    const buf = Buffer.alloc(1024);
    buf.fill(0x89, 0, 512);
    buf.fill(0x00, 512);
    await commit(repo, { 'img.png': buf }, 'add image');

    const detail = await headDetail();
    expect(detail!.files[0].isBinary).toBe(true);
    expect(detail!.files[0].added).toBe(0);
  });

  it('returns null for nonexistent sha', async () => {
    await commit(repo, { 'a.txt': 'x\n' }, 'c1');

    const result = await fetchGitCommitDetail(
      repo,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(result).toBeNull();
  });

  it('counts a renamed file by its new path (not dropped, not empty-path)', async () => {
    await commit(repo, { 'old.txt': 'a\nb\nc\nd\n' }, 'seed');
    // Rename + a small edit so git reports it as a rename with numstat counts.
    await git(repo, 'mv', 'old.txt', 'new.txt');
    await commit(repo, { 'new.txt': 'a\nB\nc\nd\ne\n' }, 'rename + edit');

    const detail = await headDetail();
    expect(detail).not.toBeNull();
    // One file keyed by the NEW path: the three-token `-z` rename sequence
    // must not record an empty path or drop it.
    expect(detail!.filesCount).toBe(1);
    expect(detail!.files).toHaveLength(1);
    expect(detail!.files[0].path).toBe('new.txt');
    expect(detail!.files[0].added).toBeGreaterThan(0);
  });

  it('shows the first-parent diff for a merge commit', async () => {
    await commit(repo, { 'base.txt': 'base\n' }, 'base');
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await commit(repo, { 'feature.txt': 'feature\n' }, 'feature work');
    await git(repo, 'checkout', '-q', 'main');
    await commit(repo, { 'main.txt': 'main\n' }, 'main work');
    await git(repo, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');

    const detail = await headDetail();
    expect(detail).not.toBeNull();
    expect(detail!.parents.length).toBe(2);
    // Plain diff-tree emits nothing for a merge; the first-parent diff must
    // surface what the merge introduced (feature.txt) — else filesCount is 0.
    expect(detail!.filesCount).toBeGreaterThan(0);
    expect(detail!.files.some((f) => f.path === 'feature.txt')).toBe(true);
  });
});

describe('fetchGitLog range argument injection guard', () => {
  useFreshRepo();
  beforeEach(async () => {
    await commit(repo, { 'a.txt': 'one\n' }, 'first');
    await commit(repo, { 'a.txt': 'two\n' }, 'second');
  });

  it('honours a legitimate revision range', async () => {
    const log = await fetchGitLog(repo, { range: 'HEAD~1..HEAD' });
    expect(log).not.toBeNull();
    expect(log!.entries).toHaveLength(1);
    expect(log!.entries[0].subject).toBe('second');
  });

  it('ignores a range that is really a git option and writes no file', async () => {
    const target = path.join(repo, 'PWNED.txt');
    const log = await fetchGitLog(repo, {
      range: `--output=${target}`,
    });
    // The malicious range is dropped, so the full log is returned and git
    // never interprets `--output` (which would truncate/create the file).
    expect(log).not.toBeNull();
    expect(log!.entries.length).toBe(2);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('drops a range starting with .. and returns the full log', async () => {
    const log = await fetchGitLog(repo, { range: '..HEAD' });
    expect(log).not.toBeNull();
    expect(log!.entries).toHaveLength(2);
  });

  it('drops a range with characters outside the allowlist', async () => {
    const log = await fetchGitLog(repo, { range: 'HEAD;rm -rf /' });
    expect(log).not.toBeNull();
    expect(log!.entries).toHaveLength(2);
  });
});

// openUntrackedForDiffRead consumes openNoFollow's refusals, so this suite
// stubs the helper at the seam. The helper's own rejection semantics (inode
// 0 -> UNVERIFIABLE_IDENTITY_CODE, symlink/race -> ELOOP) are covered in
// no-follow-open.test.ts; here we pin gitDiff's response to each code.
const noFollowRefusal = vi.hoisted(() => ({
  code: undefined as string | undefined,
  message: '',
}));

vi.mock('./no-follow-open.js', async (importActual) => {
  const actual = await importActual<typeof import('./no-follow-open.js')>();
  return {
    ...actual,
    openNoFollow: (filePath: string) => {
      if (noFollowRefusal.code !== undefined) {
        return Promise.reject(
          Object.assign(new Error(noFollowRefusal.message), {
            code: noFollowRefusal.code,
          }),
        );
      }
      return actual.openNoFollow(filePath);
    },
  };
});

describe('untracked files on inode-unverifiable volumes (#8227 follow-up)', () => {
  useFreshRepo({ 'seed.txt': 'x\n' });
  afterEach(() => {
    noFollowRefusal.code = undefined;
  });

  const refuseUnverifiable = () =>
    Object.assign(noFollowRefusal, {
      code: UNVERIFIABLE_IDENTITY_CODE,
      message: 'inode 0 cannot be verified',
    });

  it('falls back to a plain open when inode identity is unverifiable', async () => {
    // On inode-0 volumes (FAT/exFAT, some SMB shares) openNoFollow refuses
    // with UNVERIFIABLE_IDENTITY_CODE because identity can never be proven
    // there. Diff display is not identity-sensitive, so untracked text files
    // must keep their line counts instead of collapsing to a binary row.
    await write(repo, { 'fat-volume.txt': 'a\nb\nc\n' });
    refuseUnverifiable();

    const result = await diffOf(repo);
    expect(result.perFileStats.get('fat-volume.txt')).toEqual(
      untrackedEntry(3),
    );
    // The fallback keeps the lines in the aggregate total too.
    expect(result.stats.linesAdded).toBe(3);
  });

  it('still synthesizes an all-added hunk when inode identity is unverifiable', async () => {
    await write(repo, { 'new.txt': 'x\ny\n' });
    refuseUnverifiable();

    const result = await hunksFor(repo, 'new.txt');
    expect(result.truncated).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].lines).toEqual(['+x', '+y']);
  });

  it('never falls back to a plain open on a symlink refusal', async () => {
    // Any refusal OTHER than the inode-unverifiable one (a genuine symlink
    // race, ELOOP) must NOT degrade to a plain open, which would follow the
    // symlink the guard just refused. The file collapses to a binary row.
    await write(repo, { 'raced.txt': 'a\nb\n' });
    Object.assign(noFollowRefusal, {
      code: 'ELOOP',
      message: 'too many symbolic links',
    });

    const result = await diffOf(repo);
    expect(result.perFileStats.get('raced.txt')).toEqual(
      untrackedEntry(0, true),
    );
    expect(result.stats.linesAdded).toBe(0);
  });
});

describe('getGitWorkingTreeStatus in a caller’s environment', () => {
  it('answers about the checkout it was asked about, not the one GIT_DIR names', async () => {
    const asked = await makeRepo();
    const elsewhere = await makeRepo();
    try {
      await commit(asked, { 'a.txt': 'a\n' });
      await git(asked, 'switch', '-q', '-c', 'asked-branch');
      await write(asked, { 'new.txt': 'x\n' });
      await write(elsewhere, {
        '1.txt': 'y\n',
        '2.txt': 'y\n',
        '3.txt': 'y\n',
      });
      // The environment a daemon may have been started with: one that
      // points every git it runs at some other repository. Given as the
      // caller's environment, it has to be scrubbed of that, not obeyed.
      const hostile = {
        ...process.env,
        GIT_DIR: path.join(elsewhere, '.git'),
        GIT_WORK_TREE: elsewhere,
      };
      const status = await getGitWorkingTreeStatus(asked, { env: hostile });
      expect([status?.branch, status?.untracked]).toEqual(['asked-branch', 1]);

      // And the other half: the daemon's own environment is the hostile
      // one, while the workspace's is clean. Running git in the process's
      // environment instead of the one given would answer about `elsewhere`.
      vi.stubEnv('GIT_DIR', path.join(elsewhere, '.git'));
      vi.stubEnv('GIT_WORK_TREE', elsewhere);
      const clean = { ...process.env };
      delete clean['GIT_DIR'];
      delete clean['GIT_WORK_TREE'];
      const inClean = await getGitWorkingTreeStatus(asked, { env: clean });
      expect([inClean?.branch, inClean?.untracked]).toEqual([
        'asked-branch',
        1,
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rmDir(asked);
      await rmDir(elsewhere);
    }
  });
});
