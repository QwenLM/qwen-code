/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git`, real working trees. The bug under test is a property of what
// `git diff` does and does not report, so a mocked child_process would "pass"
// against a fiction of git's behaviour — which is exactly how the bug survived.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureLocalDiff,
  isBinarySection,
  MAX_UNTRACKED_BYTES,
  MAX_UNTRACKED_FILES,
  MAX_UNTRACKED_TOTAL_BYTES,
} from './local-diff.js';
import { parseDiff, buildDiffPlan, chunksCoverDiff } from './diff-plan.js';

let repo: string;
let home: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Capture, and hand back the diff as text plus the parsed file list. */
function capture(opts: Parameters<typeof captureLocalDiff>[0] = {}) {
  const res = captureLocalDiff(opts);
  const text = res.diff.toString('utf8');
  return { ...res, text, files: parseDiff(text).files };
}

beforeEach(() => {
  // `realpathSync` because macOS's tmpdir is a symlink (/var -> /private/var)
  // while `rev-parse --show-toplevel` returns the resolved path. Without this
  // the fixture's idea of its own root and git's would differ by a prefix, and
  // `-C <root>` would land somewhere else.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-loc-')));
  cwd = process.cwd();
  process.chdir(repo);

  // `captureLocalDiff` shells out to git through `process.env`, so the fixture
  // has to isolate the *process* environment, not just its own git calls. Left
  // inheriting the developer's setup, a global `core.hooksPath` runs during the
  // test and a global `commit.gpgsign=true` fails it outright for want of a key
  // — and a stray `~/.gitconfig` silently redefines what the "clean" baseline
  // is. Matches the neighbouring diff-plan fixture.
  savedEnv = { ...process.env };
  // The config lives OUTSIDE the repo. Written inside it, the fixture's own
  // isolation file becomes an untracked file — and this suite's whole subject is
  // what the capture does with untracked files.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'review-home-')));
  const emptyConfig = join(home, '.gitconfig');
  writeFileSync(emptyConfig, '');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_CONFIG_GLOBAL'] = emptyConfig;
  process.env['HOME'] = home; // belt and braces where the above is unsupported
});

afterEach(() => {
  process.chdir(cwd);
  process.env = savedEnv;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Init a repo with hooks and signing off, so a fixture cannot run either. */
function initRepo(): void {
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
  git('config', 'core.autocrlf', 'false');
}

/** A repo with one commit. Most tests want this. */
function seedRepo(): void {
  initRepo();
  write('tracked.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'init');
}

describe('captureLocalDiff — untracked files', () => {
  beforeEach(seedRepo);

  it('includes a brand-new file that `git diff HEAD` cannot see', () => {
    write(
      'src/payment.ts',
      'export function pay(amt: number) {\n  return amt;\n}\n',
    );

    // The bug, stated as an assertion: git's own diff does not have this file.
    const gitDiff = git('diff', 'HEAD');
    expect(gitDiff).not.toContain('payment.ts');

    const res = capture();
    expect(res.untracked).toEqual(['src/payment.ts']);
    expect(res.text).toContain('+++ b/src/payment.ts');
    expect(res.text).toContain('+export function pay(amt: number) {');

    // And it arrives as a file the review's own parser can see and attribute.
    const f = res.files.find((x) => x.path === 'src/payment.ts');
    expect(f).toBeDefined();
    expect(f!.addedLines).toBe(3);
    expect(f!.addedRanges).toEqual([{ start: 1, end: 3 }]);
  });

  it('is the difference between "no changes to review" and a review', () => {
    // The worst shape of the bug: the ONLY change is a new file, so the whole
    // review used to stop at "no changes to review" and never run.
    write('src/new-only.ts', 'export const x = 1;\n');

    expect(git('diff', 'HEAD').trim()).toBe('');
    expect(capture().text.trim()).not.toBe('');
  });

  it('carries staged, unstaged and untracked changes in one diff', () => {
    write('tracked.ts', 'export const a = 2;\n'); // unstaged edit
    write('staged.ts', 'export const b = 1;\n');
    git('add', 'staged.ts'); // staged add
    write('untracked.ts', 'export const c = 1;\n'); // untracked

    const paths = capture()
      .files.map((f) => f.path)
      .sort();
    expect(paths).toEqual(['staged.ts', 'tracked.ts', 'untracked.ts']);
  });

  it('honours .gitignore — an ignored file is not "untracked work"', () => {
    write('.gitignore', 'node_modules/\n*.log\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore');
    write('node_modules/dep/index.js', 'module.exports = 1;\n');
    write('debug.log', 'noise\n');
    write('real.ts', 'export const r = 1;\n');

    expect(capture().untracked).toEqual(['real.ts']);
  });

  it('handles a filename containing a space', () => {
    // git appends a trailing tab to the `+++` header for such paths.
    write('my new file.ts', 'export const s = 1;\n');

    const res = capture();
    expect(res.untracked).toEqual(['my new file.ts']);
    expect(res.files.map((f) => f.path)).toContain('my new file.ts');
  });

  it('names an oversized untracked file instead of silently dropping it', () => {
    write('huge.csv', 'x'.repeat(MAX_UNTRACKED_BYTES + 1));
    write('small.ts', 'export const s = 1;\n');

    const res = capture();
    expect(res.untracked).toEqual(['small.ts']);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({
      path: 'huge.csv',
      bytes: MAX_UNTRACKED_BYTES + 1,
    });
    expect(res.skipped[0].reason).toContain('cap');
    expect(res.text).not.toContain('huge.csv');
  });

  it('never claims to have reviewed a directory-shaped untracked entry', () => {
    // `ls-files --others` does not only name files. An **embedded git repo** (a
    // scratch clone, a vendored checkout) comes out as `nested/`, and a symlink
    // to a directory as a plain name. `stat` follows both and reports a size, so
    // they sailed through the size gate; `git diff --no-index` then failed on
    // them by exiting 1 with **empty stdout**, and an empty Buffer is a truthy
    // object, so the exit-1 tolerance accepted it as "a diff of nothing".
    //
    // The path landed in `untracked` — documented as "files whose contents are
    // in the diff" — contributed zero bytes, and never reached `skipped`. The
    // capture reported a file as reviewed that nobody had looked at: the exact
    // invariant this module exists to protect, and strictly worse than the bug
    // it replaced, which at least never claimed to have read anything.
    mkdirSync(join(repo, 'nested'));
    execFileSync('git', ['init', '-q', '.'], { cwd: join(repo, 'nested') });
    write('nested/inner.ts', 'export const hidden = 1;\n');
    mkdirSync(join(repo, 'realdir'));
    write('realdir/seen.ts', 'export const seen = 1;\n');
    symlinkSync(join(repo, 'realdir'), join(repo, 'dirlink'));

    const res = capture();

    // Every path claimed as reviewed must actually BE in the diff.
    for (const path of res.untracked) {
      expect(res.text).toContain(`+++ b/${path}`);
    }
    expect(res.untracked).toEqual(['realdir/seen.ts']);
    expect(res.skipped.map((s) => s.path).sort()).toEqual([
      'dirlink',
      'nested/',
    ]);
    // Both are named as directories, which is the actionable thing to say — the
    // symlink is followed before judging, because git decides from the resolved
    // type too.
    for (const s of res.skipped) expect(s.reason).toContain('directory');
    // The embedded repo's contents are not smuggled in either.
    expect(res.text).not.toContain('hidden');
  });

  it('records a file git could not diff, and keeps the others', () => {
    // The per-file recovery had no caller-level test: the helper's test proves an
    // empty git failure throws, and the command's test starts from a mocked skip
    // list. Neither showed that the capture survives one bad file, keeps the
    // good ones, and records the bad one as unreviewed rather than as reviewed.
    //
    // A symlink to a directory reaches git (it is a symlink, so the type gate
    // lets it by) and git then fails on it — the recovery path, driven for real.
    mkdirSync(join(repo, 'adir'));
    write('adir/inner.ts', 'export const i = 1;\n');
    symlinkSync(join(repo, 'adir'), join(repo, 'dirlink'));
    write('before.ts', 'export const b = 1;\n');
    write('zafter.ts', 'export const z = 1;\n');

    const res = capture();

    // Both good files survive — the failure did not take the capture down, and
    // did not swallow the file after it.
    // (`adir/inner.ts` is untracked too — git lists files inside a plain dir.)
    expect(res.untracked.sort()).toEqual([
      'adir/inner.ts',
      'before.ts',
      'zafter.ts',
    ]);
    expect(res.skipped.map((x) => x.path)).toEqual(['dirlink']);
    // And every path claimed as reviewed really is in the diff.
    for (const p of res.untracked) expect(res.text).toContain(`+++ b/${p}`);
    expect(res.text).not.toContain('dirlink');
  });

  it('does not capture the review own .qwen/tmp scratch files', () => {
    // The review writes its args/parse-args/diff/plan under .qwen/tmp before this
    // capture runs; in a repo that does not ignore .qwen they would show up as
    // the user's untracked work and the review would report on its own plumbing.
    write('.qwen/tmp/qwen-skill-args-review.txt', '6771 --comment\n');
    write('.qwen/tmp/qwen-review-local-plan.json', '{}\n');
    write('real.ts', 'export const r = 1;\n');

    const res = capture();
    expect(res.untracked).toEqual(['real.ts']);
    expect(res.text).not.toContain('.qwen/tmp');
  });

  it('reports an oversized tracked diff instead of inlining it', () => {
    // The aggregate budget covered only untracked files; a tracked diff could
    // grow to the 512 MiB gitRaw buffer. Stage one big tracked file past the
    // whole-capture cap and confirm it is skipped, not concatenated.
    const big =
      'export const x = "' + 'y'.repeat(MAX_UNTRACKED_TOTAL_BYTES) + '";\n';
    write('huge.ts', big);
    git('add', 'huge.ts');

    const res = capture();
    expect(res.skipped.some((f) => f.path === 'tracked changes')).toBe(true);
    expect(res.text).not.toContain('huge.ts');
  });

  it('reviews a dangling symlink instead of skipping it', () => {
    // Git renders a symlink as its **link text** at mode 120000, and the link
    // text does not depend on the target existing. A symlink pointing nowhere is
    // diffable, and it is exactly the sort of thing a reviewer should see — so
    // a failed `stat` on a symlink means "let git have it", not "skip".
    symlinkSync(join(repo, 'no-such-target.ts'), join(repo, 'dangling.ts'));

    const res = capture();
    expect(res.untracked).toEqual(['dangling.ts']);
    expect(res.skipped).toEqual([]);
    expect(res.text).toContain('new file mode 120000');
  });

  it('abandons the untracked pass when the tree has too many, and says so', () => {
    // A `.gitignore` that does not cover `node_modules` — `git init` then
    // `npm install` — offers tens of thousands of untracked files, and each one
    // costs a synchronous `git` spawn. Unbounded, the fix for "shows nothing"
    // becomes "hangs for minutes before the review starts". The count is checked
    // before the loop, so the pathological tree costs zero spawns.
    for (let i = 0; i <= MAX_UNTRACKED_FILES; i++) {
      write(`node_modules/pkg${i}/index.js`, `module.exports = ${i};\n`);
    }

    const res = capture();

    expect(res.untracked).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain('exceeds the');
    expect(res.skipped[0].reason).toContain('NONE of them were reviewed');
    // The tracked half of the capture is unaffected — it never depended on this.
    expect(res.text).toBe('');
  });

  it('stops inlining untracked files once the total budget is spent', () => {
    // Per-file caps do not bound a set. Twelve 900 kB files each pass the 1 MB
    // per-file cap and together blow past the 10 MB total.
    const big = 'x'.repeat(900_000);
    for (let i = 0; i < 12; i++) write(`blob${i}.txt`, big);

    const res = capture();

    expect(res.untracked.length).toBeGreaterThan(0);
    expect(res.skipped.length).toBeGreaterThan(0);
    expect(res.untracked.length + res.skipped.length).toBe(12);
    expect(res.skipped.some((s) => s.reason.includes('total cap'))).toBe(true);
    expect(res.diff.length).toBeLessThan(MAX_UNTRACKED_TOTAL_BYTES * 1.2);
  });

  it('can be turned off, restoring the tracked-only scope', () => {
    write('untracked.ts', 'export const c = 1;\n');

    const res = capture({ includeUntracked: false });
    expect(res.untracked).toEqual([]);
    expect(res.text).not.toContain('untracked.ts');
  });

  it('does not stage anything — the index and worktree are untouched', () => {
    write('src/payment.ts', 'export const p = 1;\n');
    // `-uall`, because plain `--porcelain` collapses a wholly-untracked
    // directory to `?? src/` and would hide the very transition under test.
    const status = () => git('status', '--porcelain', '-uall');
    const before = status();

    capture();

    // `git add -N` — the obvious way to make untracked files show up in
    // `git diff HEAD`, and the one this module refuses to use — would flip this
    // line from `?? src/payment.ts` to `A  src/payment.ts`. Reviewing code must
    // not stage the user's work.
    expect(before).toContain('?? src/payment.ts');
    expect(status()).toBe(before);
  });

  it('scopes to one path with `file`, untracked target included', () => {
    write('a.ts', 'export const a = 1;\n');
    write('b.ts', 'export const b = 1;\n');

    const res = capture({ file: 'a.ts' });
    expect(res.untracked).toEqual(['a.ts']);
    expect(res.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('resolves `file` against the caller’s directory, not the repo root', () => {
    // Every git call runs with `-C <repoRoot>`, so a path the user typed in a
    // subdirectory means a different file to git than it did to them. Asking for
    // `new.ts` from `sub/` used to search `<repo>/new.ts` and report no changes —
    // the file review would silently review nothing.
    write('sub/new.ts', 'export const n = 1;\n');
    process.chdir(join(repo, 'sub'));

    const res = capture({ file: 'new.ts' });
    expect(res.untracked).toEqual(['sub/new.ts']);
    expect(res.files.map((f) => f.path)).toEqual(['sub/new.ts']);
  });

  it('refuses a `file` outside the repository', () => {
    expect(() => capture({ file: '../../etc/passwd' })).toThrow(
      /outside the repository/,
    );
  });

  it('reads a glob-shaped filename as a name, not as a pathspec', () => {
    // `--` ends option parsing; it does not disable pathspec magic. `a[bc].ts` is
    // a *glob*, so scoping the review to that one file also dragged in `ab.ts`
    // and `ac.ts` — a review that says it looked at one file and looked at three.
    write('a[bc].ts', 'export const target = 1;\n');
    write('ab.ts', 'export const other = 1;\n');
    write('ac.ts', 'export const alsoOther = 1;\n');

    const res = capture({ file: 'a[bc].ts' });
    expect(res.untracked).toEqual(['a[bc].ts']);
    expect(res.files.map((f) => f.path)).toEqual(['a[bc].ts']);
  });

  it('accepts a valid file whose name merely begins with dots', () => {
    // `rel.startsWith('..')` is not a containment check. A root-level `..foo.ts`
    // relativises to `..foo.ts`, and the scoped review refused to look at an
    // ordinary file on the grounds that it had escaped the repository.
    write('..foo.ts', 'export const dotted = 1;\n');

    const res = capture({ file: '..foo.ts' });
    expect(res.untracked).toEqual(['..foo.ts']);
    expect(res.files.map((f) => f.path)).toEqual(['..foo.ts']);
  });

  it('does not mistake prose about binary patches for a binary file', () => {
    // The old test looked for `GIT binary patch` as a substring anywhere in the
    // first 4096 bytes. That is a sentence, and sentences appear in prose: this
    // markdown file was classified binary and thrown away unreviewed.
    write('notes.md', '# Diffs\n\nGIT binary patch is a format git uses.\n');

    const res = capture();
    expect(res.untracked).toEqual(['notes.md']);
    expect(res.skipped).toEqual([]);
    expect(res.text).toContain('GIT binary patch is a format git uses.');
  });

  it('still catches a binary marker sitting past the first 4 kB', () => {
    // The window the old check read was 4096 bytes, on the theory that a binary
    // section is short. Its *header* is short; the path in it is not, and a long
    // enough path pushes git's marker out of the window, certifying unreadable
    // bytes as reviewed. The property is about where the marker sits in the
    // section — exercise it directly, without a 4 kB filesystem path that macOS
    // (PATH_MAX 1024) rejects with ENAMETOOLONG, reddening the very CI leg the
    // cross-platform test was added for.
    const filler = '+' + 'x'.repeat(5000) + '\n';
    const section = Buffer.from(
      'diff --git a/logo.png b/logo.png\n' +
        filler +
        'Binary files /dev/null and b/logo.png differ\n',
    );
    expect(isBinarySection(section)).toBe(true);

    // And a text line that merely mentions the marker is still not binary,
    // wherever it sits.
    const prose = Buffer.from(
      'diff --git a/n.md b/n.md\n' +
        filler +
        '+GIT binary patch is a phrase that appears in prose.\n',
    );
    expect(isBinarySection(prose)).toBe(false);
  });

  it('never claims to have reviewed a binary file', () => {
    // Git renders a binary file as the single line `Binary files ... differ`.
    // The section is well-formed and parses; it contains not one byte an agent
    // could read. Recording the path among the files "whose contents are in the
    // diff" is the directory bug again, one octave quieter — a `.png` or a
    // `.pyc` certified as reviewed by a review that could not see it.
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
    write('real.ts', 'export const r = 1;\n');

    const res = capture();

    expect(res.untracked).toEqual(['real.ts']);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].path).toBe('logo.png');
    expect(res.skipped[0].reason).toContain('binary');
    expect(res.text).not.toContain('logo.png');
  });

  it('produces a diff the chunk planner can tile', () => {
    // The capture concatenates per-file sections from two different git
    // invocations. If that were not a well-formed unified diff, the coverage
    // guarantee the whole review rests on would quietly stop holding.
    write('tracked.ts', 'export const a = 99;\n');
    write('one.ts', 'export const one = 1;\n');
    write('two.ts', 'export const two = 2;\n');

    const res = capture();
    const plan = buildDiffPlan(res.text);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    expect(plan.chunks.length).toBeGreaterThan(0);
  });
});

describe('captureLocalDiff — degenerate repos', () => {
  it('survives a repo with no commits (unborn HEAD)', () => {
    git('init', '-q', '.');
    git('config', 'user.email', 'a@b');
    git('config', 'user.name', 'a');
    write('first.ts', 'export const f = 1;\n');

    // `git diff HEAD` here does not return an empty diff — it fails outright.
    expect(() => git('diff', 'HEAD')).toThrow();

    const res = capture();
    expect(res.unbornHead).toBe(true);
    expect(res.files.map((f) => f.path)).toEqual(['first.ts']);
  });

  it('survives an unborn HEAD in a SHA-256 repository', () => {
    // The famous `4b825dc…` empty tree is the SHA-**1** one and is not an object
    // in a SHA-256 repo at all — `git diff 4b825dc…` there dies with "ambiguous
    // argument". Hardcoding it would trade the unborn-HEAD crash for a rarer
    // crash, so the empty tree is asked of git instead. This test is the only
    // thing that can tell the two apart: every other fixture is SHA-1, where the
    // constant works fine.
    let sha256 = true;
    try {
      git('init', '-q', '--object-format=sha256', '.');
    } catch {
      sha256 = false; // git < 2.29
    }
    if (!sha256) return;

    git('config', 'user.email', 'a@b');
    git('config', 'user.name', 'a');
    write('first.ts', 'export const f = 1;\n');

    const res = capture();
    expect(res.unbornHead).toBe(true);
    expect(res.files.map((f) => f.path)).toEqual(['first.ts']);
  });

  it('reports a clean tree as an empty diff, not an error', () => {
    seedRepo();
    const res = capture();
    expect(res.text).toBe('');
    expect(res.untracked).toEqual([]);
  });
});
