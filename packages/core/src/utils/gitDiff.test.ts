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
      expect(resolved).toContain(path.join('.git', 'worktrees'));

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
});
