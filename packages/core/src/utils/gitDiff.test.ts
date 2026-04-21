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
  it('parses added/removed counts and file totals', () => {
    const out = '3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n0\t5\tsrc/c.ts\n';
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
    const out = '-\t-\timg/logo.png\n';
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
    const lines: string[] = [];
    const totalFiles = MAX_FILES + 5;
    for (let i = 0; i < totalFiles; i++) {
      lines.push(`1\t0\tfile${i}.ts`);
    }
    const { stats, perFileStats } = parseGitNumstat(lines.join('\n'));
    expect(stats.filesCount).toBe(totalFiles);
    expect(stats.linesAdded).toBe(totalFiles);
    expect(perFileStats.size).toBe(MAX_FILES);
  });

  it('ignores malformed rows without crashing', () => {
    const out = 'garbage-line\n2\t1\tsrc/a.ts\n';
    const { stats, perFileStats } = parseGitNumstat(out);
    expect(stats.filesCount).toBe(1);
    expect(perFileStats.has('src/a.ts')).toBe(true);
  });

  it('handles filenames containing tabs', () => {
    const out = '1\t2\tweird\tname.ts\n';
    const { perFileStats } = parseGitNumstat(out);
    expect(perFileStats.has('weird\tname.ts')).toBe(true);
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

  it('captures tracked modifications and untracked files', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    await fs.writeFile(
      path.join(repo, 'tracked.txt'),
      'one\ntwo\nthree\nfour\n',
    );
    await fs.writeFile(path.join(repo, 'new.txt'), 'brand new\n');

    const result = await fetchGitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.stats.linesAdded).toBeGreaterThanOrEqual(1);
    expect(result!.stats.filesCount).toBe(2);
    expect(result!.perFileStats.get('tracked.txt')?.added).toBe(1);
    expect(result!.perFileStats.get('new.txt')?.isUntracked).toBe(true);
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
