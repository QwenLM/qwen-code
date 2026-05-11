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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  MAX_DIFF_SIZE_BYTES,
  MAX_FILES,
  MAX_LINES_PER_FILE,
  parseDeletedFromNameStatus,
  parseGitDiff,
  parseGitNumstat,
  parseShortstat,
  resolveGitDir,
} from './gitDiff.js';

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
    // With -z, git emits the raw path; no C-style quoting. `split('\t')`
    // would mis-attribute characters after the first tab, so the parser has
    // to use index-based slicing instead.
    const out = '1\t2\tweird\tname.ts\0';
    const { perFileStats } = parseGitNumstat(out);
    expect(perFileStats.has('weird\tname.ts')).toBe(true);
    expect(perFileStats.get('weird\tname.ts')).toEqual({
      added: 1,
      removed: 2,
      isBinary: false,
    });
  });

  it('combines rename-pair tokens into a single entry', () => {
    // `-z` rename format: `<a>\t<b>\t\0<old>\0<new>\0`.
    const out = '0\t0\t\0' + 'src/old.ts\0' + 'src/new.ts\0';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats.filesCount).toBe(1);
    expect(perFileStats.has('src/old.ts => src/new.ts')).toBe(true);
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
    // path is "deleted" in the user sense — the file still exists under
    // the new name.
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

  it('returns empty map on empty input', () => {
    expect(parseGitDiff('').size).toBe(0);
    expect(parseGitDiff('   \n').size).toBe(0);
  });

  it('caps per-file lines at MAX_LINES_PER_FILE', () => {
    const header = `diff --git a/big.ts b/big.ts
index 1111111..2222222 100644
--- a/big.ts
+++ b/big.ts
@@ -1,${MAX_LINES_PER_FILE + 50} +1,${MAX_LINES_PER_FILE + 50} @@
`;
    const body = Array.from(
      { length: MAX_LINES_PER_FILE + 50 },
      (_, i) => ` line${i}`,
    ).join('\n');
    const result = parseGitDiff(header + body + '\n');
    const hunk = result.get('big.ts')![0];
    expect(hunk.lines.length).toBe(MAX_LINES_PER_FILE);
  });
});

describe('fetchGitDiff', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('returns null when not in a git repo', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-plain-'));
    try {
      expect(await fetchGitDiff(plain)).toBeNull();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('captures tracked modifications and counts lines in untracked text files', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    await fs.writeFile(
      path.join(repo, 'tracked.txt'),
      'one\ntwo\nthree\nfour\n',
    );
    await fs.writeFile(path.join(repo, 'new.txt'), 'brand new\nsecond\n');

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats.filesCount).toBe(2);
    // Tracked: +1 from adding `four`. Untracked `new.txt`: 2 lines.
    expect(result!.stats.linesAdded).toBe(3);
    expect(result!.perFileStats.get('tracked.txt')?.added).toBe(1);
    expect(result!.perFileStats.get('new.txt')).toEqual({
      added: 2,
      removed: 0,
      isBinary: false,
      isUntracked: true,
      truncated: false,
    });
  });

  it('marks oversized untracked text files as truncated', async () => {
    await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    // Write a 1.5 MB text file — larger than UNTRACKED_READ_CAP_BYTES (1 MB),
    // so the counter can only see part of the lines. The flag lets the UI
    // mark `+N` as a lower bound instead of silently under-reporting.
    const line = 'a'.repeat(99) + '\n'; // 100 bytes per line
    const totalLines = 15_000; // 1.5 MB
    await fs.writeFile(path.join(repo, 'big.log'), line.repeat(totalLines));

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    const entry = result!.perFileStats.get('big.log');
    expect(entry?.isUntracked).toBe(true);
    expect(entry?.isBinary).toBe(false);
    expect(entry?.truncated).toBe(true);
    // We counted at most UNTRACKED_READ_CAP_BYTES / 100 = 10_000 lines, less
    // than the file's real line count.
    expect(entry?.added).toBeGreaterThan(0);
    expect(entry!.added).toBeLessThan(totalLines);
  });

  it('flags untracked binary files without counting lines', async () => {
    await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    // A NUL byte in the first few bytes is git's own binary heuristic.
    await fs.writeFile(
      path.join(repo, 'blob.bin'),
      Buffer.from([0x89, 0x00, 0xff, 0x10]),
    );

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.perFileStats.get('blob.bin')).toEqual({
      added: 0,
      removed: 0,
      isBinary: true,
      isUntracked: true,
      truncated: false,
    });
    // Binary bytes must not contaminate the linesAdded total.
    expect(result!.stats.linesAdded).toBe(0);
  });

  it('returns zero stats on a clean working tree', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats).toEqual({
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    expect(result!.perFileStats.size).toBe(0);
  });

  it('returns null during a transient merge state', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
    // Fake a merge in progress by writing MERGE_HEAD.
    await fs.writeFile(
      path.join(repo, '.git', 'MERGE_HEAD'),
      '0000000000000000000000000000000000000000\n',
    );
    expect(await fetchGitDiff(repo)).toBeNull();
    expect((await fetchGitDiffHunks(repo)).size).toBe(0);
  });
});

describe('fetchGitDiffHunks', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('returns hunks for modified tracked files', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    await fs.writeFile(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    const hunks = await fetchGitDiffHunks(repo);
    const fileHunks = hunks.get('a.txt');
    expect(fileHunks).toBeDefined();
    expect(fileHunks![0].lines.some((l: string) => l.startsWith('-two'))).toBe(
      true,
    );
    expect(fileHunks![0].lines.some((l: string) => l.startsWith('+TWO'))).toBe(
      true,
    );
  });

  it('preserves content lines that start with --- / +++ / index', async () => {
    await fs.writeFile(
      path.join(repo, 'notes.md'),
      'keep\n---a/foo\n+++b/bar\nindex deadbeef\nkeep2\n',
    );
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    // Remove every diff-lookalike line; the added/removed lines should still
    // round-trip through parseGitDiff even though their prefixes match
    // file-header sentinels.
    await fs.writeFile(path.join(repo, 'notes.md'), 'keep\nkeep2\n');
    const hunks = await fetchGitDiffHunks(repo);
    const fileHunks = hunks.get('notes.md');
    expect(fileHunks).toBeDefined();
    const removed = fileHunks!.flatMap((h) =>
      h.lines.filter((l: string) => l.startsWith('-')),
    );
    expect(removed).toEqual(
      expect.arrayContaining(['----a/foo', '-+++b/bar', '-index deadbeef']),
    );
  });

  it('keys hunks by the real path for files with tabs in the name (C-quoted in diff output)', async () => {
    // Real git output for a tracked file named `tab\there.txt` looks like
    // `+++ "b/tab\there.txt"` even with `core.quotepath=false` — C-quoting
    // for tabs/newlines/quotes is independent of that config. Without the
    // unquote step in `extractFilePath`, fetchGitDiffHunks would silently
    // drop the file's hunks.
    const weirdName = 'tab\there.txt';
    try {
      await fs.writeFile(path.join(repo, weirdName), 'x\n');
    } catch {
      return; // Filesystem refused tab in name (e.g. Windows NTFS).
    }
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
    await fs.writeFile(path.join(repo, weirdName), 'y\n');

    const hunks = await fetchGitDiffHunks(repo);
    expect([...hunks.keys()]).toEqual([weirdName]);
    expect(hunks.get(weirdName)![0].lines.some((l) => l.startsWith('-x'))).toBe(
      true,
    );
    expect(hunks.get(weirdName)![0].lines.some((l) => l.startsWith('+y'))).toBe(
      true,
    );
  });

  it('keys hunks by the real path for files whose name contains " b/"', async () => {
    await fs.mkdir(path.join(repo, 'a b'), { recursive: true });
    await fs.writeFile(path.join(repo, 'a b', 'c.txt'), 'x\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
    await fs.writeFile(path.join(repo, 'a b', 'c.txt'), 'y\n');

    const hunks = await fetchGitDiffHunks(repo);
    // `diff --git a/a b/c.txt b/a b/c.txt` is ambiguous to split; the parser
    // must anchor on `+++ b/<path>\t` instead.
    expect([...hunks.keys()]).toEqual(['a b/c.txt']);
  });

  it('handles multi-hunk diffs', async () => {
    const initial = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
    await fs.writeFile(path.join(repo, 'big.txt'), initial + '\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    const lines = initial.split('\n');
    lines[2] = 'CHANGED_EARLY';
    lines[35] = 'CHANGED_LATE';
    await fs.writeFile(path.join(repo, 'big.txt'), lines.join('\n') + '\n');

    const hunks = await fetchGitDiffHunks(repo);
    const fileHunks = hunks.get('big.txt');
    expect(fileHunks).toBeDefined();
    expect(fileHunks!.length).toBeGreaterThanOrEqual(2);
  });
});

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
    // Even with `core.quotepath=false` set on our git invocations, callers
    // could feed us output produced by a different command. \346\226\207
    // is the UTF-8 byte sequence for `文`.
    const diff = `diff --git "a/\\346\\226\\207.txt" "b/\\346\\226\\207.txt"
index 1111111..2222222 100644
--- "a/\\346\\226\\207.txt"
+++ "b/\\346\\226\\207.txt"
@@ -1 +1 @@
-x
+y
`;
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['文.txt']);
  });

  it('preserves non-BMP code points in quoted paths instead of splitting surrogates', () => {
    // Reproduces wenshao Critical (PR #3491 line 504): the previous walker
    // advanced one UTF-16 code unit at a time, so a non-BMP codepoint such
    // as the rocket emoji 🚀 (U+1F680) coexisting with a forced-quoting byte
    // (here a TAB) was decoded as two lone surrogates → two replacement
    // characters, corrupting the hunk key.
    const diff = `diff --git "a/\\t🚀.txt" "b/\\t🚀.txt"
index 1111111..2222222 100644
--- "a/\\t🚀.txt"
+++ "b/\\t🚀.txt"
@@ -1 +1 @@
-x
+y
`;
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['\t🚀.txt']);
  });

  it('decodes the remaining C-style escapes (\\a, \\b, \\f, \\v)', () => {
    // Reproduces wenshao Critical (PR #3491 line 552): the previous switch
    // dropped the leading backslash for these escapes, turning `\a` / `\b`
    // / `\f` / `\v` into ordinary `a` / `b` / `f` / `v` and yielding a
    // hunk key that did not match the real on-disk filename.
    const diff = `diff --git "a/bell\\afile.txt" "b/bell\\afile.txt"
index 1111111..2222222 100644
--- "a/bell\\afile.txt"
+++ "b/bell\\afile.txt"
@@ -1 +1 @@
-x
+y
diff --git "a/back\\bspace.txt" "b/back\\bspace.txt"
index 3333333..4444444 100644
--- "a/back\\bspace.txt"
+++ "b/back\\bspace.txt"
@@ -1 +1 @@
-x
+y
diff --git "a/form\\ffeed.txt" "b/form\\ffeed.txt"
index 5555555..6666666 100644
--- "a/form\\ffeed.txt"
+++ "b/form\\ffeed.txt"
@@ -1 +1 @@
-x
+y
diff --git "a/vert\\vtab.txt" "b/vert\\vtab.txt"
index 7777777..8888888 100644
--- "a/vert\\vtab.txt"
+++ "b/vert\\vtab.txt"
@@ -1 +1 @@
-x
+y
`;
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
    // No hunks — nothing to key — but the extractor should still not confuse
    // paths. The file block is dropped because there are no `@@` lines, which
    // is the existing behavior for mode-only / rename-only changes.
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
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['gone.txt']);
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
    const result = parseGitDiff(diff);
    expect([...result.keys()]).toEqual(['new.txt']);
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
  it('returns the .git directory for a regular repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdir-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      const resolved = await resolveGitDir(dir);
      expect(resolved).toBe(path.join(dir, '.git'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('follows the gitdir pointer for linked worktrees', async () => {
    const main = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitmain-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: main });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: main,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: main,
      });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: main,
      });
      await fs.writeFile(path.join(main, 'a.txt'), 'hi\n');
      await execFileAsync('git', ['add', '.'], { cwd: main });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: main });

      const wtPath = path.join(main, 'wt');
      await execFileAsync(
        'git',
        ['worktree', 'add', '-q', wtPath, '-b', 'side'],
        { cwd: main },
      );

      const resolved = await resolveGitDir(wtPath);
      expect(resolved).not.toBeNull();
      // Git writes the linked-worktree pointer with forward slashes even on
      // Windows (`gitdir: C:/.../main/.git/worktrees/wt`), and we surface
      // that string verbatim. Match either separator so the assertion is
      // platform-independent.
      expect(resolved).toMatch(/[/\\]\.git[/\\]worktrees[/\\]/);

      // Fake a merge-in-progress inside the linked worktree's gitdir and
      // confirm `fetchGitDiff` short-circuits, which would silently fail if
      // transient detection only looked at `<wt>/.git/MERGE_HEAD`.
      await fs.writeFile(
        path.join(resolved!, 'MERGE_HEAD'),
        '0000000000000000000000000000000000000000\n',
      );
      expect(await fetchGitDiff(wtPath)).toBeNull();
    } finally {
      await fs.rm(main, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiff transient-state detection', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'hi\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

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
  it('keeps the real filename for tracked files that contain a tab', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-tab-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      const weirdName = 'tab\there.txt';
      try {
        await fs.writeFile(path.join(repo, weirdName), 'x\n');
      } catch {
        return; // Filesystem refused the name; nothing to assert.
      }
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
      await fs.writeFile(path.join(repo, weirdName), 'y\n');

      const result = await fetchGitDiff(repo);
      expect(result).not.toBeNull();
      // With plain --numstat, git would C-quote this as `"tab\\there.txt"`
      // and the map key would not match the real path. `--numstat -z` gives
      // us the raw bytes back.
      expect(result!.perFileStats.has(weirdName)).toBe(true);
      expect(result!.perFileStats.has(`"tab\\there.txt"`)).toBe(false);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it('combines a rename into a single "old => new" per-file entry', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-mv-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.writeFile(path.join(repo, 'old.txt'), 'x\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
      await execFileAsync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repo });

      const result = await fetchGitDiff(repo);
      expect(result).not.toBeNull();
      // Rename detection is the git default with -M; we preserve that display
      // shape rather than splitting into delete + add rows.
      const keys = [...result!.perFileStats.keys()];
      expect(keys.some((k) => k.includes('old.txt => new.txt'))).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
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
    // Expect the bounded regex to either reject (too long for \d{1,10}) or
    // match trivially. Either way it must not spin.
    expect(elapsed).toBeLessThan(250);
    expect(result).toBeNull();
  });
});

describe('fetchGitDiff non-ASCII filenames', () => {
  it('does not octal-escape UTF-8 filenames via core.quotepath', async () => {
    const repo = await makeRepo();
    try {
      const fname = '日本語.txt';
      await fs.writeFile(path.join(repo, fname), 'alpha\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-q', '-m', 'init');
      await fs.writeFile(path.join(repo, fname), 'beta\n');

      const result = await fetchGitDiff(repo);
      expect(result).not.toBeNull();
      expect(result!.perFileStats.has(fname)).toBe(true);
      // Make sure we didn't end up with an octal-escaped key instead.
      for (const key of result!.perFileStats.keys()) {
        expect(key).not.toMatch(/\\\d{3}/);
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiff untracked with special filenames', () => {
  it('counts an untracked file whose name contains a newline as one entry', async () => {
    // Skip on platforms where the filesystem rejects `\n` in names (e.g. some
    // Windows filesystems). POSIX filesystems accept it; we rely on that here.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-nl-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@example.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });

      const weirdName = 'line1\nline2.txt';
      try {
        await fs.writeFile(path.join(repo, weirdName), 'content\n');
      } catch {
        // Filesystem refused newline in name — nothing to assert here.
        return;
      }

      const result = await fetchGitDiff(repo);
      expect(result).not.toBeNull();
      // Without `-z`, `ls-files` would quote this as `"line1\nline2.txt"`
      // and split-on-\n would produce two phantom entries. With `-z` we get
      // exactly one entry, keyed by the real name.
      expect(result!.stats.filesCount).toBe(1);
      expect(result!.perFileStats.has(weirdName)).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiff invocation from a subdirectory', () => {
  it('returns repo-wide changes with consistent repo-root-relative path keys', async () => {
    // Reproduces wenshao Critical (PR #3491 line 63): when /diff was invoked
    // from a subdir, `git diff --numstat` emitted repo-root-relative keys but
    // `ls-files --others` was scoped to cwd, so untracked files outside the
    // subdir were silently dropped and the path basis was inconsistent.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-sub-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.mkdir(path.join(repo, 'sub'), { recursive: true });
      await fs.writeFile(path.join(repo, 'sub', 'tracked.txt'), 'x\n');
      await fs.writeFile(path.join(repo, 'rootkeep.txt'), 'k\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

      // Modify a tracked file inside the subdir.
      await fs.writeFile(path.join(repo, 'sub', 'tracked.txt'), 'y\n');
      // Add an untracked file in a sibling location at the repo root.
      await fs.writeFile(path.join(repo, 'rootnew.txt'), 'fresh\n');
      // And one in the subdir for good measure.
      await fs.writeFile(path.join(repo, 'sub', 'subnew.txt'), 'a\nb\n');

      // Invoke fetchGitDiff with cwd pointing at the SUBDIR, not the root.
      const result = await fetchGitDiff(path.join(repo, 'sub'));
      expect(result).not.toBeNull();
      const keys = [...result!.perFileStats.keys()].sort();
      // All path keys must be repo-root-relative (not "tracked.txt" or
      // "subnew.txt" alone). And the root-level untracked file must be
      // present even though we asked from sub/.
      expect(keys).toEqual([
        'rootnew.txt',
        'sub/subnew.txt',
        'sub/tracked.txt',
      ]);
      expect(result!.stats.filesCount).toBe(3);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiff fast path with untracked-only workspaces', () => {
  it('takes the >MAX_FILES_FOR_DETAILS short-circuit when shortstat is empty', async () => {
    // Reproduces wenshao Critical (PR #3491 line 146). 0 tracked changes
    // + many untracked previously left `quickStats` null, so the fast
    // path was skipped and the slow path under-reported `linesAdded`
    // because it line-counted only the first MAX_FILES untracked files.
    // The fix makes the threshold fire on tracked + untracked even when
    // shortstat returns nothing.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-fp-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });

      // Plant 501 untracked files (just over MAX_FILES_FOR_DETAILS = 500)
      // and zero tracked changes.
      const N = 501;
      const writes: Array<Promise<void>> = [];
      for (let i = 0; i < N; i++) {
        writes.push(fs.writeFile(path.join(repo, `u${i}.txt`), 'a\n'));
      }
      await Promise.all(writes);

      const result = await fetchGitDiff(repo);
      expect(result).not.toBeNull();
      // Header includes every untracked file in `filesCount`.
      expect(result!.stats.filesCount).toBe(N);
      // `perFileStats` is empty because we took the summary-only path,
      // which is the whole point of the guardrail.
      expect(result!.perFileStats.size).toBe(0);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiffHunks ignores external diff drivers', () => {
  it('does not invoke GIT_EXTERNAL_DIFF when reading hunks', async () => {
    // Reproduces wenshao Critical (PR #3491 line 219). Plain `git diff`
    // honors `GIT_EXTERNAL_DIFF` / `diff.<name>.command`, so a malicious
    // worktree could execute arbitrary commands when a caller of
    // `fetchGitDiffHunks` only wants to inspect hunks. The fix is
    // `--no-ext-diff`; this test plants an env-var driver that touches a
    // sentinel file and asserts it never fires.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-ext-'));
    const sentinel = path.join(os.tmpdir(), `qwen-ext-fired-${Date.now()}`);
    const driverScript = path.join(repo, 'evil-diff.sh');
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'two\n');

      // Driver writes the sentinel as a side effect when invoked.
      await fs.writeFile(
        driverScript,
        `#!/bin/sh\necho fired > "${sentinel}"\n`,
        { mode: 0o755 },
      );

      // Set GIT_EXTERNAL_DIFF for the rest of this test. fetchGitDiffHunks
      // calls runGit which spawns child processes that inherit our env.
      const prev = process.env['GIT_EXTERNAL_DIFF'];
      process.env['GIT_EXTERNAL_DIFF'] = driverScript;
      try {
        const hunks = await fetchGitDiffHunks(repo);
        expect(hunks.get('a.txt')).toBeDefined();
      } finally {
        if (prev === undefined) delete process.env['GIT_EXTERNAL_DIFF'];
        else process.env['GIT_EXTERNAL_DIFF'] = prev;
      }

      // The sentinel must NOT exist — `--no-ext-diff` should have stopped
      // git from running the driver.
      let driverFired = false;
      try {
        await fs.stat(sentinel);
        driverFired = true;
      } catch {
        // ENOENT — driver never ran. Expected.
      }
      expect(driverFired).toBe(false);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(sentinel, { force: true });
    }
  });

  it('does not invoke textconv drivers when reading hunks', async () => {
    // Reproduces wenshao Critical (PR #3491 line 282). `--no-ext-diff`
    // blocks GIT_EXTERNAL_DIFF / diff.<name>.command but is INDEPENDENT
    // of textconv filters configured via .gitattributes +
    // `diff.<name>.textconv`. Without `--no-textconv`, a malicious
    // worktree can still execute commands when this utility runs.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-tc-'));
    const sentinel = path.join(os.tmpdir(), `qwen-tc-fired-${Date.now()}`);
    const driverScript = path.join(repo, 'evil-textconv.sh');
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });

      // Driver writes the sentinel as a side effect when invoked.
      await fs.writeFile(
        driverScript,
        `#!/bin/sh\necho fired > "${sentinel}"\ncat "$1" 2>/dev/null\n`,
        { mode: 0o755 },
      );

      // Wire the driver up: register textconv command + attribute.
      await execFileAsync(
        'git',
        ['config', 'diff.evil.textconv', driverScript],
        {
          cwd: repo,
        },
      );
      await fs.writeFile(
        path.join(repo, '.gitattributes'),
        '*.pdf diff=evil\n',
      );
      await fs.writeFile(path.join(repo, 'doc.pdf'), 'a\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'doc.pdf'), 'b\n');

      const hunks = await fetchGitDiffHunks(repo);
      expect(hunks.get('doc.pdf')).toBeDefined();

      let driverFired = false;
      try {
        await fs.stat(sentinel);
        driverFired = true;
      } catch {
        // ENOENT — driver never ran. Expected.
      }
      expect(driverFired).toBe(false);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(sentinel, { force: true });
    }
  });
});

describe('fetchGitDiff deletion detection', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('marks tracked files removed from the worktree as isDeleted', async () => {
    await fs.writeFile(path.join(repo, 'kept.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repo, 'gone.txt'), 'a\nb\nc\n');
    await fs.writeFile(
      path.join(repo, 'gone.bin'),
      Buffer.from([0x89, 0x00, 0xff]),
    );
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    // Modify one tracked file (heavy edit), and remove two others.
    await fs.writeFile(path.join(repo, 'kept.txt'), '');
    await fs.rm(path.join(repo, 'gone.txt'));
    await fs.rm(path.join(repo, 'gone.bin'));

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    // Heavy edit must NOT be marked deleted, even though numstat shows
    // `0\t2\tkept.txt` (which looks identical to a delete shape).
    expect(result!.perFileStats.get('kept.txt')?.isDeleted).toBeFalsy();
    expect(result!.perFileStats.get('gone.txt')?.isDeleted).toBe(true);
    expect(result!.perFileStats.get('gone.bin')).toMatchObject({
      isBinary: true,
      isDeleted: true,
    });
  });

  it('does not mark either side of a rename as deleted', async () => {
    await fs.writeFile(path.join(repo, 'old.txt'), 'x\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
    await git(repo, 'mv', 'old.txt', 'new.txt');

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    // The rename collapses to a single "old => new" entry; it must not
    // be flagged as deleted.
    const keys = [...result!.perFileStats.keys()];
    expect(keys.some((k) => k.includes('=>'))).toBe(true);
    for (const s of result!.perFileStats.values()) {
      expect(s.isDeleted).toBeFalsy();
    }
  });
});

describe('fetchGitDiff special filetypes among untracked files', () => {
  it('marks untracked symlinks as binary and never follows them', async () => {
    // Reproduces wenshao Critical (PR #3491 line 455): without an lstat
    // gate, `open()` would dereference an untracked symlink and read its
    // target — which can live outside the worktree.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdiff-lnk-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repo });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: repo,
      });
      await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

      // Create an outside-worktree target with content that, if followed,
      // would push linesAdded up. The lstat gate means we never read it.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
      try {
        await fs.writeFile(
          path.join(outside, 'secret.txt'),
          'one\ntwo\nthree\n',
        );
        await fs.symlink(
          path.join(outside, 'secret.txt'),
          path.join(repo, 'link.txt'),
        );

        const result = await fetchGitDiff(repo);
        expect(result).not.toBeNull();
        const entry = result!.perFileStats.get('link.txt');
        expect(entry).toBeDefined();
        expect(entry?.isBinary).toBe(true);
        expect(entry?.isUntracked).toBe(true);
        // No content from the symlink target leaked into the totals.
        expect(result!.stats.linesAdded).toBe(0);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('fetchGitDiff untracked counting', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
    await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('aggregates untracked line counts into linesAdded even when the per-file map is full of tracked entries', async () => {
    // Seed MAX_FILES tracked files, then modify them so the per-file map
    // saturates with tracked entries. Add a handful of untracked files that
    // would otherwise be cut out of the display slots — their line counts
    // still need to land in `stats.linesAdded`.
    for (let i = 0; i < MAX_FILES; i++) {
      await fs.writeFile(path.join(repo, `t${i}.txt`), `hello${i}\n`);
    }
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'seed');
    for (let i = 0; i < MAX_FILES; i++) {
      await fs.writeFile(path.join(repo, `t${i}.txt`), `HELLO${i}\n`);
    }
    // Each untracked file has 3 lines; 5 files × 3 = 15 lines we must keep.
    const untrackedCount = 5;
    const linesPerFile = 3;
    for (let i = 0; i < untrackedCount; i++) {
      await fs.writeFile(path.join(repo, `u${i}.txt`), 'a\nb\nc\n');
    }

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats.filesCount).toBe(MAX_FILES + untrackedCount);
    // Per-file map is still capped — none of the u* entries will be visible
    // because the t* entries filled every slot. But the totals must still
    // include the untracked additions.
    expect(result!.perFileStats.size).toBe(MAX_FILES);
    const trackedLinesAdded = MAX_FILES; // each t* gained 1 char → numstat 1/1
    expect(result!.stats.linesAdded).toBe(
      trackedLinesAdded + untrackedCount * linesPerFile,
    );
  });

  it('counts untracked files in filesCount even after the per-file map is full', async () => {
    // Create MAX_FILES tracked modifications to fill the per-file map.
    for (let i = 0; i < MAX_FILES; i++) {
      await fs.writeFile(path.join(repo, `t${i}.txt`), `hello${i}\n`);
    }
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'seed');
    for (let i = 0; i < MAX_FILES; i++) {
      await fs.writeFile(path.join(repo, `t${i}.txt`), `HELLO${i}\n`);
    }
    // Add 3 untracked files.
    await fs.writeFile(path.join(repo, 'u1.txt'), 'a\n');
    await fs.writeFile(path.join(repo, 'u2.txt'), 'b\n');
    await fs.writeFile(path.join(repo, 'u3.txt'), 'c\n');

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats.filesCount).toBe(MAX_FILES + 3);
    // Per-file map is still capped at MAX_FILES.
    expect(result!.perFileStats.size).toBe(MAX_FILES);
  });

  it('line-counts every untracked file in the slow path, not just the first MAX_FILES', async () => {
    // Regression for the under-counted-totals bug: with 0 tracked changes
    // and 51-500 untracked files, the slow path used to read line counts
    // for `untrackedPaths.slice(0, MAX_FILES)` only, so files beyond the
    // per-file display cap silently dropped out of `stats.linesAdded`.
    // This test puts MAX_FILES + 10 = 60 untracked one-line files in a
    // clean repo and asserts every one of them contributes to the total.
    const extra = 10;
    const totalUntracked = MAX_FILES + extra;
    for (let i = 0; i < totalUntracked; i++) {
      // Padded filenames so `ls-files --others` returns them in stable
      // order — otherwise the "first MAX_FILES" slicing in the bug case
      // could randomly cover the test files.
      const name = `u${String(i).padStart(3, '0')}.txt`;
      await fs.writeFile(path.join(repo, name), 'one-line\n');
    }
    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats.filesCount).toBe(totalUntracked);
    // Every untracked file is one line, so totals must equal totalUntracked.
    // Pre-fix this would have been MAX_FILES (= 50).
    expect(result!.stats.linesAdded).toBe(totalUntracked);
    // Visible per-file rows still cap at MAX_FILES.
    expect(result!.perFileStats.size).toBe(MAX_FILES);
  });
});
