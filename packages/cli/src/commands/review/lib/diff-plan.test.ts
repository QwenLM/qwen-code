/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildDiffPlan,
  chunksCoverDiff,
  classifyPath,
  MAX_CHUNK_CHARS,
  parseDiff,
} from './diff-plan.js';

/** Build a synthetic hunk body of `n` added lines. */
function body(n: number, prefix = '+'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}line ${i}`);
}

function fileSection(path: string, hunks: Array<[number, number]>): string[] {
  const out = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (const [newStart, n] of hunks) {
    out.push(`@@ -${newStart},${n} +${newStart},${n} @@`);
    out.push(...body(n));
  }
  return out;
}

describe('classifyPath', () => {
  /** Map each path to its kind so a failure names the offending path. */
  const kinds = (paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, classifyPath(p)]));
  const all = (paths: string[], kind: string) =>
    Object.fromEntries(paths.map((p) => [p, kind]));

  it('recognises test files across the common conventions', () => {
    const paths = [
      'packages/channels/qqbot/src/events.test.ts',
      'src/foo.spec.tsx',
      'packages/webui/src/__tests__/App.tsx',
      'integration-tests/foo.ts',
      'pkg/server/handler_test.go',
      'app/tests/test_views.py',
      'app/test_views.py',
      'src/test/java/Foo.java',
    ];
    expect(kinds(paths)).toEqual(all(paths, 'test'));
  });

  it('recognises generated and vendored files', () => {
    const paths = [
      'package-lock.json',
      'packages/desktop/bun.lock',
      'packages/vscode-ide-companion/NOTICES.txt',
      'dist/bundle.min.js',
      'vendor/lib.go',
    ];
    expect(kinds(paths)).toEqual(all(paths, 'generated'));
  });

  it('does not mistake a word containing "test" for a test path', () => {
    const paths = [
      'src/testing/helpers.ts',
      'src/contest/foo.ts',
      'src/latest/foo.ts',
      'packages/core/src/skills/bundled/review/SKILL.md',
      'packages/channels/qqbot/src/QQChannel.ts',
    ];
    expect(kinds(paths)).toEqual(all(paths, 'source'));
  });

  it('classifies prose as docs, wherever the prose lives', () => {
    // A root-only rule would call the nested package docs `source`.
    const docs = [
      'docs/users/features/code-review.md',
      'README.md',
      'packages/cua-driver/docs/tool-output-format.md',
      'website/docs/intro.mdx',
      'doc/api.rst',
    ];
    expect(kinds(docs)).toEqual(all(docs, 'docs'));
  });

  it('does not call code documentation because of where it sits', () => {
    // A bare directory rule would call `website/src/App.tsx` documentation.
    // A bundled skill prompt is executable behaviour, not prose, even though
    // it is markdown.
    const source = [
      'website/src/App.tsx',
      'website/build.ts',
      'packages/core/src/skills/bundled/review/SKILL.md',
    ];
    expect(kinds(source)).toEqual(all(source, 'source'));
  });

  it('classifies a generated snapshot as generated, not as a test', () => {
    // It lives under __snapshots__/, which also matches the test pattern, so
    // the generated check has to run first.
    expect(classifyPath('src/__snapshots__/App.snap')).toBe('generated');
  });
});

describe('parseDiff', () => {
  it('records file sections and hunk ranges', () => {
    const diff = [
      ...fileSection('src/a.ts', [
        [10, 3],
        [50, 2],
      ]),
      ...fileSection('src/b.ts', [[1, 4]]),
    ].join('\n');

    const { files, diffLines } = parseDiff(diff);
    expect(diffLines).toBe(diff.split('\n').length);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);

    const a = files[0];
    expect(a.diffStart).toBe(1);
    expect(a.hunks).toHaveLength(2);
    // Header is 4 lines, so the first `@@` sits on line 5.
    expect(a.hunks[0].diffStart).toBe(5);
    expect(a.hunks[0].newStart).toBe(10);
    expect(a.hunks[0].newEnd).toBe(12);
    expect(a.hunks[1].newStart).toBe(50);
    expect(a.hunks[1].newEnd).toBe(51);
    expect(a.addedLines).toBe(5);
  });

  it('labels a deleted file by its old path when +++ is /dev/null', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n');
    const { files } = parseDiff(diff);
    expect(files[0].path).toBe('gone.ts');
    expect(files[0].removedLines).toBe(2);
    // A `+0,0` hunk occupies no new-side lines; the range must stay sane.
    expect(files[0].hunks[0].newEnd).toBeGreaterThanOrEqual(
      files[0].hunks[0].newStart,
    );
  });

  it('decodes a C-quoted non-ASCII path as bytes, not as characters', () => {
    // Verbatim `git diff` output for a file named `sub/中文文件.ts`. Each
    // `\NNN` is one UTF-8 byte; stripping the backslashes would yield
    // `sub/344270255...ts`, and every later `git show` on that name fails.
    const diff = [
      'diff --git "a/sub/\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.ts" "b/sub/\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.ts"',
      'index 7898192..de98044 100644',
      '--- "a/sub/\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.ts"',
      '+++ "b/sub/\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.ts"',
      '@@ -1 +1,3 @@',
      ' a',
      '+b',
      '+c',
    ].join('\n');
    expect(parseDiff(diff).files[0].path).toBe('sub/中文文件.ts');
  });

  it('treats an empty hunk-body record as a blank context line', () => {
    // `diff.suppressBlankEmpty=true` prints a blank context line as a
    // physically empty record rather than a lone space. Not advancing the
    // new-side cursor shifts every later added range up by one.
    const withSpace = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,4 @@',
      ' a',
      ' ',
      ' b',
      '+ADDED',
    ].join('\n');
    const suppressed = withSpace.replace('\n \n', '\n\n');
    expect(parseDiff(withSpace).files[0].addedRanges).toEqual([
      { start: 4, end: 4 },
    ]);
    expect(parseDiff(suppressed).files[0].addedRanges).toEqual([
      { start: 4, end: 4 },
    ]);
  });

  it('decodes a C-quoted control character', () => {
    const diff = [
      'diff --git "a/sub/tab\\tname.ts" "b/sub/tab\\tname.ts"',
      '--- "a/sub/tab\\tname.ts"',
      '+++ "b/sub/tab\\tname.ts"',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n');
    expect(parseDiff(diff).files[0].path).toBe('sub/tab\tname.ts');
  });

  it('resolves a path containing a space from the +++ header', () => {
    // `diff --git a/my file b/my file` is genuinely ambiguous — git does not
    // quote spaces — so the `+++` line is the only reliable source.
    const diff = [
      'diff --git a/my file.ts b/my file.ts',
      '--- a/my file.ts',
      '+++ b/my file.ts',
      '@@ -1,1 +1,1 @@',
      '+x',
    ].join('\n');
    expect(parseDiff(diff).files[0].path).toBe('my file.ts');
  });

  it('resolves a space-containing path in a binary section', () => {
    // Verbatim `git diff` output. A binary section has no `---`/`+++` headers,
    // so the `diff --git` line is the only source — and git does not quote a
    // path merely for containing a space. A greedy `(.+) (.+)` lands on
    // `space.png`. Both paths are identical, so the split is arithmetic.
    const diff = [
      'diff --git a/img with space.png b/img with space.png',
      'index 1111111..2222222 100644',
      'Binary files a/img with space.png and b/img with space.png differ',
    ].join('\n');
    const f = parseDiff(diff).files[0];
    expect(f.path).toBe('img with space.png');
    expect(f.binary).toBe(true);
  });

  it('resolves a space-containing path in a mode-only section', () => {
    const diff = [
      'diff --git a/mode file.sh b/mode file.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    expect(parseDiff(diff).files[0].path).toBe('mode file.sh');
  });

  it("takes a renamed file's new path from the rename header", () => {
    // The two header paths differ here, so the arithmetic split does not apply.
    const diff = [
      'diff --git a/d/old.ts b/d/new name.ts',
      'similarity index 100%',
      'rename from d/old.ts',
      'rename to d/new name.ts',
    ].join('\n');
    expect(parseDiff(diff).files[0].path).toBe('d/new name.ts');
  });

  it('does not read a hunk payload line as a `---` / `+++` header', () => {
    // Verbatim `git diff`: deleting a line whose content is `-- old comment`
    // emits `--- old comment`; adding one whose content is `++ plus line`
    // emits `+++ plus line`. SQL, Lua and Haskell comments start with `-- `.
    // Reading those as headers overwrote the file's path and swallowed the
    // line from the add/remove counts.
    const diff = [
      'diff --git a/c.txt b/c.txt',
      '--- a/c.txt',
      '+++ b/c.txt',
      '@@ -1 +1,2 @@',
      ' x',
      '+++ plus line',
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1 @@',
      '--- old comment',
      '-SELECT 1;',
      '+SELECT 2;',
    ].join('\n');

    const { files } = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['c.txt', 'q.sql']);
    expect(files[0].addedLines).toBe(1); // `+++ plus line` is payload, not metadata
    expect(files[1].removedLines).toBe(2); // `--- old comment` and `-SELECT 1;`
    expect(files[1].addedLines).toBe(1);
  });

  it('records how many new-side lines each hunk occupies', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,2 @@',
      ' keep',
      '-gone',
      ' keep2',
      '@@ -10,2 +9,0 @@',
      '-only',
      '-deletions',
    ].join('\n');
    const h = parseDiff(diff).files[0].hunks;
    expect(h[0].newCount).toBe(2);
    // A `+9,0` hunk occupies no new-side line: nothing can be anchored there,
    // and Step 7 must not offer it as a RIGHT-side comment target.
    expect(h[1].newCount).toBe(0);
  });

  it('reports added ranges that exclude context lines', () => {
    // A hunk range spans its three context lines either side. Handing that to
    // an agent as "the changed lines" makes it review code the PR never wrote.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,6 +10,7 @@',
      ' ctx1',
      ' ctx2',
      '+new1',
      '+new2',
      ' ctx3',
      '-gone',
      '+new3',
      ' ctx4',
    ].join('\n');
    const f = parseDiff(diff).files[0];
    expect(f.hunks[0].newStart).toBe(10);
    expect(f.hunks[0].newEnd).toBe(16); // 7 new-side lines
    // Only 12-13 and 15 were written. A `-` line advances nothing.
    expect(f.addedRanges).toEqual([
      { start: 12, end: 13 },
      { start: 15, end: 15 },
    ]);
    expect(f.addedLines).toBe(3);
    expect(f.removedLines).toBe(1);
  });

  it('coalesces added ranges across hunks without merging them', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+one',
      '@@ -50,1 +51,2 @@',
      ' keep',
      '+two',
    ].join('\n');
    expect(parseDiff(diff).files[0].addedRanges).toEqual([
      { start: 2, end: 2 },
      { start: 52, end: 52 },
    ]);
  });

  it('marks binary sections and gives them no hunks', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const { files } = parseDiff(diff);
    expect(files[0].binary).toBe(true);
    expect(files[0].hunks).toEqual([]);
  });
});

describe('planChunks', () => {
  it('tiles the diff exactly: no gap, no overlap, no lost line', () => {
    const diff = [
      ...fileSection('src/a.ts', [
        [1, 120],
        [400, 300],
        [900, 30],
      ]),
      ...fileSection('src/b.ts', [[1, 20]]),
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');

    const plan = buildDiffPlan(diff, 200);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);

    // Reconstructing the chunk ranges must yield the original diff verbatim.
    const lines = diff.split('\n');
    const rebuilt = plan.chunks
      .flatMap((c) => lines.slice(c.startLine - 1, c.endLine))
      .join('\n');
    expect(rebuilt).toBe(diff);
  });

  it('splits an oversized new-file hunk at top-level boundaries', () => {
    // A brand-new file is one giant hunk. PR #6457 added events.test.ts as a
    // single 1535-line hunk; leaving it atomic hands one agent a 50 000-char
    // territory. Split at `<blank line><column-0 declaration>` only.
    const fnBlock = (i: number) => [
      `+function f${i}() {`,
      ...Array.from({ length: 28 }, (_, k) => `+  const x${k} = ${k};`),
      '+}',
      '+',
    ];
    const hunkBody = Array.from({ length: 20 }, (_, i) => fnBlock(i)).flat();
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      `@@ -0,0 +1,${hunkBody.length} @@`,
      ...hunkBody,
    ].join('\n');

    const plan = buildDiffPlan(diff, 200);
    expect(plan.chunks.length).toBeGreaterThan(2);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);

    const lines = diff.split('\n');
    for (const c of plan.chunks.slice(1)) {
      // Each later chunk must begin on a `function fN() {` line — never
      // inside a function body.
      expect(lines[c.startLine - 1]).toMatch(/^\+function f\d+\(\) \{$/);
    }
    for (const c of plan.chunks) expect(c.lines).toBeLessThanOrEqual(200);
    // new-side ranges stay ordered and contiguous across segments.
    const fileRanges = plan.chunks.map((c) => c.files[0]);
    for (let i = 1; i < fileRanges.length; i++) {
      expect(fileRanges[i].newStart).toBeGreaterThan(
        fileRanges[i - 1].newStart,
      );
    }
  });

  it('reaches past the budget window for the next safe boundary', () => {
    // PR #6591: a 1431-line React component whose first top-level boundary sits
    // 460 lines in. Giving up when the 400-line window holds no candidate
    // collapsed the whole remainder into one 45 000-char chunk — past what a
    // single `read_file` returns — even though 27 later boundaries existed.
    const wall = (n: number) =>
      Array.from({ length: n }, (_, k) => `+  const deep${k} = ${k};`);
    const body = [
      '+function first() {',
      ...wall(600), // no top-level boundary anywhere in the first window
      '+}',
      '+',
      '+function second() {',
      ...wall(300),
      '+}',
      '+',
      '+function third() {',
      ...wall(300),
      '+}',
    ];
    const diff = [
      'diff --git a/src/big.tsx b/src/big.tsx',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/big.tsx',
      `@@ -0,0 +1,${body.length} @@`,
      ...body,
    ].join('\n');

    const plan = buildDiffPlan(diff, 400);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    // It must not collapse into one chunk just because the first 400 lines
    // offered nowhere to cut.
    expect(plan.chunks.length).toBeGreaterThan(1);
    const lines = diff.split('\n');
    for (const c of plan.chunks.slice(1)) {
      expect(lines[c.startLine - 1]).toMatch(
        /^\+function (second|third)\(\) \{$/,
      );
    }
    // The one over-budget segment is the unavoidable wall; the rest are bounded.
    expect(plan.chunks.filter((c) => c.lines > 400)).toHaveLength(1);
  });

  it('does not treat a deleted blank line as the blank before a declaration', () => {
    // The heuristic claims "a top-level declaration preceded by a blank line".
    // Both must exist in the post-change file. A `-` blank exists only in the
    // old one, so it is no evidence about what precedes the declaration in the
    // file an agent will read.
    const blk = (i: number) => [
      `+function f${i}() {`,
      ...Array.from({ length: 28 }, (_, k) => `+  const x${k} = ${k};`),
      '+}',
      '-', // a blank line the change DELETES — not a new-file blank
    ];
    const hunkBody = Array.from({ length: 20 }, (_, i) => blk(i)).flat();
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      `@@ -1,${hunkBody.length} +1,${hunkBody.length} @@`,
      ...hunkBody,
    ].join('\n');

    const plan = buildDiffPlan(diff, 200);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    // Every candidate is preceded only by a deleted blank, so none qualifies:
    // the hunk stays whole rather than being cut on false evidence.
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].oversized).toBe(true);
  });

  it('never starts a chunk on a deleted line', () => {
    // A `-` line exists only on the old side. Starting a territory there gives
    // the agent a boundary that has no counterpart in the post-change file it
    // will read. Here the only column-0-after-blank candidates are deletions.
    const body: string[] = [];
    for (let i = 0; i < 12; i++) {
      body.push(`-function gone${i}() {`);
      for (let k = 0; k < 28; k++) body.push(`-  const x${k} = ${k};`);
      body.push('-}');
      body.push('-');
    }
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      `@@ -1,${body.length} +0,0 @@`,
      ...body,
    ].join('\n');

    const plan = buildDiffPlan(diff, 100);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    const lines = diff.split('\n');
    for (const c of plan.chunks.slice(1)) {
      expect(lines[c.startLine - 1].startsWith('-')).toBe(false);
    }
    // With no new-side candidate the hunk stays whole rather than being cut.
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].oversized).toBe(true);
  });

  it('reports each chunk’s character count', () => {
    const diff = fileSection('src/a.ts', [[1, 50]]).join('\n');
    const plan = buildDiffPlan(diff, 400);
    const lines = diff.split('\n');
    const expected = lines.reduce((n, l) => n + l.length + 1, 0);
    expect(plan.chunks[0].chars).toBe(expected);
  });

  it('leaves a hunk whole when it has no safe interior boundary', () => {
    const diff = fileSection('src/big.ts', [
      [1, 5],
      [100, 900],
      [2000, 5],
    ]).join('\n');

    const plan = buildDiffPlan(diff, 100);
    const { files } = parseDiff(diff);
    const hunkStarts = new Set(files[0].hunks.map((h) => h.diffStart));

    // Every chunk boundary after the first lands on a hunk start.
    for (const c of plan.chunks.slice(1)) {
      expect(hunkStarts.has(c.startLine)).toBe(true);
    }
    const oversized = plan.chunks.filter((c) => c.oversized);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].lines).toBeGreaterThan(900);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
  });

  it('keeps each chunk within the target size when hunks allow it', () => {
    const diff = fileSection(
      'src/a.ts',
      Array.from(
        { length: 20 },
        (_, i) => [i * 100 + 1, 30] as [number, number],
      ),
    ).join('\n');
    const plan = buildDiffPlan(diff, 200);
    for (const c of plan.chunks) {
      if (!c.oversized) expect(c.lines).toBeLessThanOrEqual(200);
    }
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
  });

  it("attaches a file's header to the chunk owning its first hunk", () => {
    const diff = [
      ...fileSection('src/a.ts', [[1, 150]]),
      ...fileSection('src/b.ts', [[1, 150]]),
    ].join('\n');
    const plan = buildDiffPlan(diff, 100);
    const lines = diff.split('\n');
    // b.ts starts a new chunk, and that chunk begins at its `diff --git` line.
    const bChunk = plan.chunks.find((c) =>
      c.files.some((f) => f.path === 'src/b.ts'),
    )!;
    expect(lines[bChunk.startLine - 1]).toBe(
      'diff --git a/src/b.ts b/src/b.ts',
    );
  });

  it('reports the new-side line range each chunk covers, per file', () => {
    const diff = fileSection('src/a.ts', [
      [10, 3],
      [900, 3],
    ]).join('\n');
    const plan = buildDiffPlan(diff, 1000); // one chunk
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].files).toEqual([
      { path: 'src/a.ts', newStart: 10, newEnd: 902 },
    ]);
  });

  it('bounds a chunk by characters, not just lines', () => {
    // 300 lines is under the 400-line cap, but at 400 chars each that is
    // 120 000 chars — `read_file` would return only the first 25 000 and
    // report `isTruncated`, silently hiding the rest of the chunk.
    const long = 'x'.repeat(400);
    const hunkBody = Array.from({ length: 300 }, (_, i) =>
      i % 30 === 0 ? `+f${i}()` : `+  ${long}`,
    );
    // Blank line before each `f<N>()` so a safe split point exists.
    for (let i = 0; i < hunkBody.length; i += 30) hunkBody[i - 1] &&= '+';
    const diff = [
      'diff --git a/src/wide.ts b/src/wide.ts',
      '--- a/src/wide.ts',
      '+++ b/src/wide.ts',
      `@@ -1,${hunkBody.length} +1,${hunkBody.length} @@`,
      ...hunkBody,
    ].join('\n');

    const plan = buildDiffPlan(diff, 400);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);

    const lines = diff.split('\n');
    for (const c of plan.chunks) {
      if (c.oversized) continue;
      const chars = lines
        .slice(c.startLine - 1, c.endLine)
        .reduce((n, l) => n + l.length + 1, 0);
      expect(chars).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('handles an empty diff', () => {
    const plan = buildDiffPlan('', 400);
    expect(plan.chunks).toEqual([]);
    expect(plan.diffLines).toBe(0);
    expect(chunksCoverDiff([], 0)).toBe(true);
  });

  it('chunk ids are 1-based and contiguous', () => {
    const diff = fileSection(
      'src/a.ts',
      Array.from(
        { length: 8 },
        (_, i) => [i * 100 + 1, 50] as [number, number],
      ),
    ).join('\n');
    const plan = buildDiffPlan(diff, 120);
    expect(plan.chunks.map((c) => c.id)).toEqual(
      plan.chunks.map((_, i) => i + 1),
    );
  });
});

describe('per-kind diff line totals', () => {
  it('splits the diff into source, test, docs, and generated lines', () => {
    const diff = [
      ...fileSection('src/a.ts', [[1, 40]]),
      ...fileSection('src/a.test.ts', [[1, 200]]),
      ...fileSection('docs/guide.md', [[1, 300]]),
      ...fileSection('package-lock.json', [[1, 500]]),
    ].join('\n');

    const plan = buildDiffPlan(diff, 400);
    // Each section is its 4 header lines + 1 hunk header + N body lines.
    expect(plan.srcDiffLines).toBe(45);
    expect(plan.testDiffLines).toBe(205);
    expect(plan.docsDiffLines).toBe(305);
    expect(plan.generatedDiffLines).toBe(505);
    expect(
      plan.srcDiffLines +
        plan.testDiffLines +
        plan.docsDiffLines +
        plan.generatedDiffLines,
    ).toBe(plan.diffLines);
  });

  it('keeps a docs-heavy PR out of the territory fan-out', () => {
    // A translation PR: 40 source lines, 3 000 lines of prose. Gating on raw
    // size would carve it into territories and spend chunk agents on markdown.
    const diff = [
      ...fileSection('src/a.ts', [[1, 40]]),
      ...fileSection('docs/a.md', [[1, 1500]]),
      ...fileSection('docs/b.md', [[1, 1500]]),
    ].join('\n');
    const plan = buildDiffPlan(diff, 400);
    expect(plan.srcDiffLines).toBeLessThan(500);
    expect(plan.docsDiffLines).toBeGreaterThan(3000);
    // Coverage is unaffected: the prose is still chunked and receipted.
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
  });

  it('is what separates a small production change from a big test diff', () => {
    // The shape the topology gate exists for: a modest source change shipping
    // a large new test file. Raw diff size says "large"; the risk does not.
    const diff = [
      ...fileSection('src/a.ts', [[1, 150]]),
      ...fileSection('src/a.test.ts', [[1, 800]]),
    ].join('\n');
    const plan = buildDiffPlan(diff, 400);
    expect(plan.diffLines).toBeGreaterThan(900);
    expect(plan.srcDiffLines).toBeLessThan(500);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
  });
});

describe('chunksCoverDiff', () => {
  it('rejects a gap', () => {
    expect(
      chunksCoverDiff(
        [
          {
            id: 1,
            startLine: 1,
            endLine: 5,
            lines: 5,
            chars: 0,
            maxLineChars: 0,
            oversized: false,
            files: [],
          },
          {
            id: 2,
            startLine: 7,
            endLine: 9,
            lines: 3,
            chars: 0,
            maxLineChars: 0,
            oversized: false,
            files: [],
          },
        ],
        9,
      ),
    ).toBe(false);
  });

  it('rejects an overlap and a short tail', () => {
    const overlap = [
      {
        id: 1,
        startLine: 1,
        endLine: 5,
        lines: 5,
        chars: 0,
        maxLineChars: 0,
        oversized: false,
        files: [],
      },
      {
        id: 2,
        startLine: 5,
        endLine: 9,
        lines: 5,
        chars: 0,
        maxLineChars: 0,
        oversized: false,
        files: [],
      },
    ];
    expect(chunksCoverDiff(overlap, 9)).toBe(false);
    const short = [
      {
        id: 1,
        startLine: 1,
        endLine: 5,
        lines: 5,
        chars: 0,
        maxLineChars: 0,
        oversized: false,
        files: [],
      },
    ];
    expect(chunksCoverDiff(short, 9)).toBe(false);
  });
});

describe('real-world shape', () => {
  it('partitions a 5800-line diff into reviewable chunks', () => {
    // Mirrors PR #6457: one 1700-line file dominating, plus small tails.
    const diff = [
      ...fileSection(
        'packages/channels/qqbot/src/QQChannel.ts',
        Array.from(
          { length: 40 },
          (_, i) => [i * 60 + 1, 42] as [number, number],
        ),
      ),
      ...fileSection('packages/channels/qqbot/src/types.ts', [[18, 95]]),
    ].join('\n');
    const plan = buildDiffPlan(diff, 400);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(4);
    // No chunk approaches the historical Shell preview that motivated this.
    for (const c of plan.chunks) expect(c.lines).toBeLessThanOrEqual(400 + 42);
  });
});
