/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The mechanical claim under test: hunk N of file F, extracted as a pure
// content revert and applied in reverse by git's own patch engine — never a
// hand transcription, never a reimplementation of `git apply`. The fixtures
// are real repositories and the applies are real, because the one oracle this
// command must agree with is git itself. The exceptions are deliberate: the
// spawn-failure and check-passed-apply-failed branches are driven through the
// exec seam, because no real git invocation can be made to take them
// deterministically.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import yargs from 'yargs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractHunkPatch,
  listHunks,
  parseHunkId,
  runRevertHunk,
  revertHunkCommand,
} from './revert-hunk.js';
import { parseDiff } from './lib/diff-plan.js';
import {
  writeStdoutLineSafe,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  ignoreBrokenPipe: vi.fn(),
  writeStdoutLine: vi.fn(),
  writeStdoutLineSafe: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

// Every fixture repo this suite creates, removed at the end — one run leaves
// seven real git repositories otherwise, and CI shards multiply that.
const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// The stdio helpers are `vi.fn()` mocks with no auto-clear (no clearMocks in
// vitest.config); without this, `toHaveBeenCalledWith` matches across EVERY
// prior test's calls, and since every message this command emits starts with
// `revert-hunk:` a stale call makes such an assertion vacuous. Clear per test
// so each mock assertion sees only its own test's calls.
beforeEach(() => {
  vi.clearAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A real two-hunk history: a base commit, then one commit editing the file's
 * top AND bottom — far enough apart that git emits two hunks. The tree is
 * left at the "PR head" state, which is what a scratch tree holds.
 */
function twoHunkFixture(trailingNewline = true) {
  const dir = tempDir('rh-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  const base = [
    'top-old',
    ...Array.from({ length: 10 }, (_, i) => `mid-${i}`),
    'bottom-old',
  ].join('\n');
  writeFileSync(join(dir, 'f.txt'), base + (trailingNewline ? '\n' : ''));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const head = [
    'top-new',
    ...Array.from({ length: 10 }, (_, i) => `mid-${i}`),
    'bottom-new',
  ].join('\n');
  writeFileSync(join(dir, 'f.txt'), head + (trailingNewline ? '\n' : ''));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'pr');
  const diffPath = join(dir, 'pr.diff');
  writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD'));
  return { dir, diffPath };
}

describe('listHunks', () => {
  it('enumerates hunks under stable <path>:<n> ids with their headers and counts', () => {
    const { diffPath } = twoHunkFixture();
    const hunks = listHunks(readFileSync(diffPath, 'utf8'));
    expect(hunks.map((h) => h.id)).toEqual(['f.txt:1', 'f.txt:2']);
    expect(hunks[0].header).toMatch(/^@@ /);
    expect(hunks[0].addedLines).toBe(1);
    expect(hunks[0].removedLines).toBe(1);
  });

  it('keeps added and removed on their own counters — an asymmetric hunk tells them apart', () => {
    // Every 1+/1- fixture is blind to a counter transposition; the verifier
    // sizes mutations off these numbers.
    const dir = tempDir('rh-cnt-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    // Repo convention for git-fixture tests: pin LF so `git apply -R` does not
    // write CRLF into the reverted tree under a core.autocrlf=true host
    // (the Git-for-Windows default), which would fail the exact-LF asserts.
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'c.txt'), 'one\ntwo\nthree\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'c.txt'), 'one\nTWO\n2.5\nthree\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const hunks = listHunks(git(dir, 'diff', 'HEAD~1', 'HEAD'));
    expect(hunks[0].addedLines).toBe(2);
    expect(hunks[0].removedLines).toBe(1);
  });
});

describe('parseHunkId', () => {
  it('splits from the RIGHT, so a path containing a colon still resolves', () => {
    expect(parseHunkId('a:b/c.ts:3')).toEqual({ path: 'a:b/c.ts', n: 3 });
  });

  it('refuses anything that is not <path>:<n> with n >= 1', () => {
    for (const bad of ['f.txt', 'f.txt:0', 'f.txt:x', ':2']) {
      expect(parseHunkId(bad)).toBeNull();
    }
  });
});

describe('runRevertHunk', () => {
  it('reverts exactly the selected hunk and leaves the other in place', () => {
    const { dir, diffPath } = twoHunkFixture();
    const report = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
    });
    expect(report.applied).toBe(true);
    expect(report.hunk?.id).toBe('f.txt:1');
    const content = readFileSync(join(dir, 'f.txt'), 'utf8');
    // Hunk 1 (the top edit) is back at base; hunk 2 (the bottom) is untouched.
    expect(content).toContain('top-old');
    expect(content).toContain('bottom-new');
    expect(content).not.toContain('top-new');
  });

  it('accepts a non-canonical hunk number without throwing mid-mutation', () => {
    // `parseHunkId` accepts `1.0`/`01` (Number() semantics); the lookup keys
    // on the PARSED selector, so these resolve to the same hunk instead of
    // leaving `entry` undefined and throwing AFTER the tree was mutated —
    // with exit code 2 telling the caller nothing happened.
    for (const alias of ['f.txt:01', 'f.txt:1.0']) {
      const { dir, diffPath } = twoHunkFixture();
      const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: alias });
      expect(r.applied).toBe(true);
      expect(r.hunk?.id).toBe('f.txt:1');
    }
  });

  it('refuses via --check when the context no longer matches, tree unchanged', () => {
    const { dir, diffPath } = twoHunkFixture();
    const first = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'f.txt:1' });
    expect(first.applied).toBe(true);
    const before = readFileSync(join(dir, 'f.txt'), 'utf8');
    // Reverting the same hunk again cannot apply — its "+" side is gone. The
    // refusal must leave the tree byte-identical, or the verifier's next
    // probe measures a half-mutation nothing reports.
    const second = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
    });
    expect(second.applied).toBe(false);
    expect(second.conflict).toBeTruthy();
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe(before);
  });

  it('names a hunk that does not exist instead of guessing', () => {
    const { dir, diffPath } = twoHunkFixture();
    for (const hunk of ['f.txt:9', 'nope.ts:1', 'garbage']) {
      const r = runRevertHunk({ diff: diffPath, tree: dir, hunk });
      expect(r.applied).toBe(false);
      expect(r.note).toContain('--list');
    }
  });

  it('carries the `\\ No newline at end of file` marker with its hunk', () => {
    // The marker lives INSIDE the hunk's diff range; a transcription that
    // drops it reverts to a file with a trailing newline the base never had —
    // a mutation different from the one the report claims was tested.
    const { dir, diffPath } = twoHunkFixture(false);
    const diffText = readFileSync(diffPath, 'utf8');
    const { files } = parseDiff(diffText);
    const last = files[0].hunks.length;
    expect(extractHunkPatch(diffText, files[0], last)).toContain(
      '\\ No newline at end of file',
    );
    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: `f.txt:${last}`,
    });
    expect(r.applied).toBe(true);
    const content = readFileSync(join(dir, 'f.txt'), 'utf8');
    expect(content).toContain('bottom-old');
    expect(content.endsWith('\n')).toBe(false);
  });

  it('reverts a renamed file’s content hunk WITHOUT rewinding the rename', () => {
    // A rename-with-edits section carries `similarity index`/`rename from`/
    // `rename to`; carried into the patch, `git apply -R` would move the file
    // back to its OLD path while the report claims a content revert at the
    // new one — and the verifier's probe would then fail because the file
    // moved, not because the hunk is load-bearing.
    const dir = tempDir('rh-ren-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    writeFileSync(join(dir, 'old.txt'), `top-old\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'mv', 'old.txt', 'new.txt');
    writeFileSync(join(dir, 'new.txt'), `top-new\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'rename+edit');
    const diffText = git(dir, 'diff', '-M', 'HEAD~1', 'HEAD');
    expect(diffText).toContain('rename from');
    const diffPath = join(dir, 'ren.diff');
    writeFileSync(diffPath, diffText);

    const { files } = parseDiff(diffText);
    const patch = extractHunkPatch(diffText, files[0], 1);
    expect(patch).not.toContain('rename from');
    expect(patch).not.toContain('similarity index');

    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'new.txt:1' });
    expect(r.applied).toBe(true);
    // The file stays where the PR put it; only the content hunk reverted.
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toContain('top-old');
    expect(statSync(join(dir, 'new.txt')).isFile()).toBe(true);
    expect(() => statSync(join(dir, 'old.txt'))).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'reverts a mode-changed file’s content hunk WITHOUT flipping the mode',
    () => {
      // `old mode`/`new mode` lines carried into the patch would strip the +x
      // the PR added while the note claims a content-only revert — the probe
      // then fails because the script lost its execute bit.
      const dir = tempDir('rh-mode-');
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@t');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'core.autocrlf', 'false');
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho old\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho new\n');
      chmodSync(join(dir, 'run.sh'), 0o755);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'mode+edit');
      const diffText = git(dir, 'diff', 'HEAD~1', 'HEAD');
      expect(diffText).toContain('old mode');
      const diffPath = join(dir, 'mode.diff');
      writeFileSync(diffPath, diffText);

      const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'run.sh:1' });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(dir, 'run.sh'), 'utf8')).toContain('echo old');
      // The execute bit the PR set survives the content revert.
      expect(statSync(join(dir, 'run.sh')).mode & 0o111).not.toBe(0);
    },
  );

  it('refuses a plain edit under a non-standard prefix rather than risk mis-targeting it', () => {
    // The command assumes git's a/ b/ prefixes at every layer; a custom
    // (--src-prefix) or absent (--no-prefix) prefix is refused wholesale,
    // which is safe where a -p1 mis-apply or a spurious rename-rewrite is
    // not. The pipeline's own captures always use default prefixes.
    const dir = tempDir('rh-plainpfx-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'caf\u00e9.txt'), 'top-old\nmid\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'caf\u00e9.txt'), 'top-new\nmid\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'edit');
    const diffText = git(
      dir,
      'diff',
      '--src-prefix=old/',
      '--dst-prefix=new/',
      'HEAD~1',
      'HEAD',
    );
    const diffPath = join(dir, 'plainpfx.diff');
    writeFileSync(diffPath, diffText);
    const id = listHunks(diffText)[0].id;
    const before = readFileSync(join(dir, 'caf\u00e9.txt'), 'utf8');
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: id });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('standard a/ b/');
    // Nothing was touched — no move, no content change.
    expect(readFileSync(join(dir, 'caf\u00e9.txt'), 'utf8')).toBe(before);
  });

  it('refuses a hand-crafted section whose paths differ without rename metadata', () => {
    // git never emits `--- a/old` / `+++ b/new` without a rename/copy header;
    // a hand-assembled --diff can, and reverse-applying it would MOVE the
    // file. Build one by taking a real single-file diff and rewriting its
    // +++ path.
    const { dir, diffPath } = twoHunkFixture();
    const raw = readFileSync(diffPath, 'utf8');
    const crafted = raw
      .replace('+++ b/f.txt', '+++ b/other.txt')
      .replace('diff --git a/f.txt b/f.txt', 'diff --git a/f.txt b/other.txt');
    const craftedPath = join(dir, 'crafted.diff');
    writeFileSync(craftedPath, crafted);
    const before = readFileSync(join(dir, 'f.txt'), 'utf8');
    const r = runRevertHunk({
      diff: craftedPath,
      tree: dir,
      hunk: 'other.txt:1',
    });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('no rename/copy metadata');
    // Neither file moved or changed.
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'other.txt'))).toBe(false);
  });

  it('refuses an ambiguous hunk id — a path in more than one diff section', () => {
    // format-patch --stdout concatenates per-commit sections; a path edited
    // in two commits yields two `f.txt:1` rows and files.find would silently
    // revert the FIRST. Refuse rather than mutate a section the caller could
    // not have addressed.
    const dir = tempDir('rh-ambig-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'f.txt'), 'v0\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'c0');
    writeFileSync(join(dir, 'f.txt'), 'v1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'c1');
    writeFileSync(join(dir, 'f.txt'), 'v2\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'c2');
    // Two sections for f.txt, concatenated.
    const diffText = git(
      dir,
      'format-patch',
      '--stdout',
      'HEAD~2',
      '--unified=1',
    );
    const diffPath = join(dir, 'fp.diff');
    writeFileSync(diffPath, diffText);
    const ids = listHunks(diffText).filter((h) => h.path === 'f.txt');
    expect(ids.length).toBeGreaterThan(1); // the collision
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'f.txt:1' });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('ambiguous');
    // The tree was not touched.
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('refuses a copy section under a non-standard prefix instead of rewinding the copy', () => {
    const dir = tempDir('rh-cpfx-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    writeFileSync(join(dir, 'orig.txt'), `top-old\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'copy.txt'), `top-new\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'copy+edit');
    const diffText = git(
      dir,
      'diff',
      '-C',
      '-C',
      '--src-prefix=x/',
      '--dst-prefix=y/',
      'HEAD~1',
      'HEAD',
    );
    expect(diffText).toContain('copy from');
    const diffPath = join(dir, 'cpfx.diff');
    writeFileSync(diffPath, diffText);
    const id = listHunks(diffText)[0].id;
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: id });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('standard a/ b/');
    // The copy was NOT rewound.
    expect(existsSync(join(dir, 'copy.txt'))).toBe(true);
  });

  it('refuses a C-quoted rename under a non-default prefix', () => {
    const dir = tempDir('rh-qpfx-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    writeFileSync(join(dir, 'plain.txt'), `top-old\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'mv', 'plain.txt', 'caf\u00e9.txt');
    writeFileSync(join(dir, 'caf\u00e9.txt'), `top-new\n${body}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'rename+edit');
    const diffText = git(
      dir,
      'diff',
      '-M',
      '--src-prefix=x/',
      '--dst-prefix=y/',
      'HEAD~1',
      'HEAD',
    );
    const diffPath = join(dir, 'qpfx.diff');
    writeFileSync(diffPath, diffText);
    const id = listHunks(diffText)[0].id;
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: id });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
  });

  it('reports a git FATAL (status 128) as a harness fact, not a coupling refusal', () => {
    // status 128 is git's `fatal:` — a pruned gitdir, a non-repo worktree —
    // where git never inspected the patch; recording it as a coupling fact
    // would feed the load-bearing decision a harness failure dressed as a
    // fact about the diff. Driven through the seam because a real
    // pruned-gitdir is not deterministically constructible here.
    const { dir, diffPath } = twoHunkFixture();
    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
      exec: () => ({
        status: 128,
        stderr: 'fatal: not a git repository',
      }),
    });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(r.note).not.toContain('coupling');
  });

  it('reports a spawn-level failure as a harness fact, never as hunk coupling', () => {
    // A mistyped --tree makes spawnSync return {status: null, error: ENOENT}
    // without throwing; folded into the refusal branch it would record a
    // phantom coupling fact about the diff — feeding the load-bearing
    // decision a fabricated input.
    const { diffPath } = twoHunkFixture();
    const r = runRevertHunk({
      diff: diffPath,
      tree: '/definitely/not/a/tree-xyz',
      hunk: 'f.txt:1',
    });
    expect(r.applied).toBe(false);
    expect(r.conflict).toBeUndefined();
    expect(r.note).toContain('could not run git');
    expect(r.note).not.toContain('coupling');
  });

  it('reverts a created file’s only hunk by removing the file — and restores a deleted one', () => {
    // `new file mode` / `deleted file mode` are deliberately KEPT by the
    // header filter: they ARE the content semantics of those sections.
    // "Is this new file dead weight?" is a primary use of the command.
    const dir = tempDir('rh-cd-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'stays.txt'), 'anchor\n');
    writeFileSync(join(dir, 'doomed.txt'), 'old content\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'born.txt'), 'new content\n');
    rmSync(join(dir, 'doomed.txt'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'create+delete');
    const diffPath = join(dir, 'cd.diff');
    writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD'));

    const created = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'born.txt:1',
    });
    expect(created.applied).toBe(true);
    expect(existsSync(join(dir, 'born.txt'))).toBe(false);

    const deleted = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'doomed.txt:1',
    });
    expect(deleted.applied).toBe(true);
    expect(readFileSync(join(dir, 'doomed.txt'), 'utf8')).toBe('old content\n');
  });

  it('reverts a COPIED file’s content hunk without rewinding the copy', () => {
    // A copy-with-edits section has the same two-path header shape as a
    // rename but under `copy from`/`copy to` — which parseDiff does not
    // surface as renameFrom. The rewrite keys on the header TOKENS
    // disagreeing, so copies take the same content-only path.
    const dir = tempDir('rh-copy-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    writeFileSync(join(dir, 'orig.txt'), `top-old\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'copy.txt'), `top-new\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'copy+edit');
    // -C -C finds copies against unmodified files; the section carries
    // `copy from`/`copy to`.
    const diffText = git(dir, 'diff', '-C', '-C', 'HEAD~1', 'HEAD');
    expect(diffText).toContain('copy from');
    const diffPath = join(dir, 'copy.diff');
    writeFileSync(diffPath, diffText);

    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'copy.txt:1' });
    expect(r.applied).toBe(true);
    // The copy stays; only its content hunk reverted. The source file is
    // untouched either way.
    expect(readFileSync(join(dir, 'copy.txt'), 'utf8')).toContain('top-old');
    expect(readFileSync(join(dir, 'orig.txt'), 'utf8')).toContain('top-old');
  });

  it('reverts through a C-QUOTED rename — the quoted-token surgery is load-bearing', () => {
    // With core.quotepath on (the default) git C-quotes non-ASCII paths in
    // the `+++` header, and the rewrite must rebuild the a/ token from the
    // quoted form without dropping a byte.
    const dir = tempDir('rh-cq-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    writeFileSync(join(dir, 'plain.txt'), `top-old\n${body}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'mv', 'plain.txt', 'caf\u00e9.txt');
    writeFileSync(join(dir, 'caf\u00e9.txt'), `top-new\n${body}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'rename+edit');
    const diffText = git(dir, 'diff', '-M', 'HEAD~1', 'HEAD');
    const diffPath = join(dir, 'cq.diff');
    writeFileSync(diffPath, diffText);
    const { files } = parseDiff(diffText);
    expect(files[0].path).toBe('caf\u00e9.txt');

    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'caf\u00e9.txt:1',
    });
    expect(r.applied).toBe(true);
    expect(readFileSync(join(dir, 'caf\u00e9.txt'), 'utf8')).toContain(
      'top-old',
    );
    expect(existsSync(join(dir, 'plain.txt'))).toBe(false);
  });

  it('round-trips non-UTF-8 bytes — the diff is a byte stream, not text', () => {
    // A utf8 read mangles a lone 0xE9 (Latin-1 é) to U+FFFD before git ever
    // sees the patch: context lines then mismatch (a fabricated coupling
    // fact) or replacement bytes land in the "reverted" tree. latin1 is the
    // pipeline's byte-fidelity convention (fetch-diff writes it).
    const dir = tempDir('rh-l1-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    const mid = Buffer.from('caf\xe9 latin1 line\n', 'latin1');
    writeFileSync(
      join(dir, 'legacy.txt'),
      Buffer.concat([Buffer.from('top-old\n'), mid]),
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(
      join(dir, 'legacy.txt'),
      Buffer.concat([Buffer.from('top-new\n'), mid]),
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const diffPath = join(dir, 'l1.diff');
    writeFileSync(
      diffPath,
      execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: dir }),
    );

    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'legacy.txt:1',
    });
    expect(r.applied).toBe(true);
    const bytes = readFileSync(join(dir, 'legacy.txt'));
    expect(bytes.includes(Buffer.from('top-old'))).toBe(true);
    // The 0xE9 byte survived — no U+FFFD (EF BF BD) anywhere.
    expect(bytes.includes(0xe9)).toBe(true);
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('numbers hunks PER FILE on a multi-file diff, and reverts only the addressed file', () => {
    const dir = tempDir('rh-multi-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'a.txt'), 'a-old\n');
    writeFileSync(join(dir, 'b.txt'), 'b-old\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'a.txt'), 'a-new\n');
    writeFileSync(join(dir, 'b.txt'), 'b-new\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const diffPath = join(dir, 'multi.diff');
    writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD'));

    const diffText = readFileSync(diffPath, 'utf8');
    // Per-file numbering: the second file's first hunk is :1, not :2.
    expect(listHunks(diffText).map((h) => h.id)).toEqual([
      'a.txt:1',
      'b.txt:1',
    ]);
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'b.txt:1' });
    expect(r.applied).toBe(true);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b-old\n');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a-new\n');
  });

  it('reports a git KILLED during --check as a harness fact too', () => {
    // The signal arm of the guard: a timeout or OOM kill returns
    // {status: null, signal} — falling through to `status !== 0` would
    // record a phantom coupling fact.
    const { dir, diffPath } = twoHunkFixture();
    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
      exec: () => ({ status: null, stderr: '', signal: 'SIGTERM' }),
    });
    expect(r.applied).toBe(false);
    expect(r.conflict).toBeUndefined();
    expect(r.note).toContain('could not run git');
    expect(r.note).toContain('SIGTERM');
  });

  it('a git killed MID-APPLY warns that the tree may be partially modified', () => {
    // After --check passes the apply can still be killed; unlike the check
    // stage, writes may already have landed, and the note must send the
    // caller to reset before the next probe.
    const { dir, diffPath } = twoHunkFixture();
    const calls: string[][] = [];
    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
      exec: (_cwd, args) => {
        calls.push(args);
        return args.includes('--check')
          ? { status: 0, stderr: '' }
          : { status: null, stderr: '', signal: 'SIGKILL' };
      },
    });
    expect(calls).toHaveLength(2);
    expect(r.applied).toBe(false);
    expect(r.note).toContain('PARTIALLY modified');
    expect(r.conflict).toBeUndefined();
    expect(r.harnessFailure).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'returns the applied report even if the staging sweep cannot remove the dir',
    () => {
      // The finally's rmSync is best-effort: an un-removable staging dir (a
      // same-uid peer chmods it mid-apply) must not throw out of the finally
      // and turn applied:true into a refusal exit. Simulate by making the
      // dir read-only right as the apply runs, via the exec seam. Skipped at
      // uid 0: root bypasses the 0o500 mode, so rmSync succeeds and there is
      // no un-removable dir to simulate.
      const { dir, diffPath } = twoHunkFixture();
      let stagingDir: string | undefined;
      const r = runRevertHunk({
        diff: diffPath,
        tree: dir,
        hunk: 'f.txt:1',
        exec: (cwd, gitArgs) => {
          // The patch path is the last arg; its dirname is the staging dir.
          const patch = gitArgs[gitArgs.length - 1];
          stagingDir = dirname(patch);
          if (!gitArgs.includes('--check')) chmodSync(stagingDir, 0o500);
          // Delegate to real git so the revert actually applies.
          const res = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
          return { status: res.status ?? null, stderr: res.stderr ?? '' };
        },
      });
      expect(r.applied).toBe(true);
      // Clean the dir the command's finally could not remove — afterAll only
      // sweeps tempDir() paths, not runRevertHunk's internal mkdtemp, so this
      // file must remove it itself or leak one dir per run. The chmod-back is
      // guarded: at some uids rmSync may have partially removed it.
      if (stagingDir !== undefined) {
        try {
          chmodSync(stagingDir, 0o700);
        } catch {
          /* already gone */
        }
        rmSync(stagingDir, { recursive: true, force: true });
      }
    },
  );

  it('cleans its patch staging directory up on every outcome', () => {
    const countStaging = () =>
      readdirSync(tmpdir()).filter((d) =>
        d.startsWith('qwen-review-revert-hunk-'),
      ).length;
    const before = countStaging();
    const { dir, diffPath } = twoHunkFixture();
    runRevertHunk({ diff: diffPath, tree: dir, hunk: 'f.txt:1' }); // applied
    runRevertHunk({ diff: diffPath, tree: dir, hunk: 'f.txt:1' }); // refused
    // The three harness-failure returns inside the try are the ones a
    // per-branch cleanup would miss; the unconditional finally must catch
    // them too.
    runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:2',
      exec: () => ({ status: null, stderr: '', error: 'ENOENT' }),
    });
    runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:2',
      exec: (_c, a) =>
        a.includes('--check')
          ? { status: 0, stderr: '' }
          : { status: null, stderr: '', signal: 'SIGKILL' },
    });
    runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:2',
      exec: (_c, a) =>
        a.includes('--check')
          ? { status: 0, stderr: '' }
          : { status: 1, stderr: 'patch does not apply' },
    });
    expect(countStaging()).toBe(before);
  });

  it('names the check-passed-but-apply-failed race as a tree change, via the exec seam', () => {
    // Unreachable deterministically through real git — the whole point of
    // the seam. `--check` passes, the apply then fails: something raced the
    // tree between the two calls.
    const { dir, diffPath } = twoHunkFixture();
    const calls: string[][] = [];
    const r = runRevertHunk({
      diff: diffPath,
      tree: dir,
      hunk: 'f.txt:1',
      exec: (_cwd, args) => {
        calls.push(args);
        return args.includes('--check')
          ? { status: 0, stderr: '' }
          : { status: 1, stderr: 'patch does not apply' };
      },
    });
    expect(calls).toHaveLength(2);
    expect(r.applied).toBe(false);
    expect(r.note).toContain('passed --check but failed to apply');
  });

  it('refuses a gitlink/submodule hunk instead of reporting a false applied:true', () => {
    // `git apply -R` on a submodule-pointer hunk exits 0 without moving the
    // submodule, so applied:true would be a witness for a mutation that never
    // happened. The command must refuse structurally (harnessFailure), and it
    // decides this from the diff text alone — the `index <sha>..<sha> 160000`
    // marker — before it ever runs the apply, so the fixture is the authentic
    // gitlink diff git emits for a bumped pointer, over a throwaway tree the
    // refusal never touches.
    const dir = tempDir('rh-gitlink-');
    const diffPath = join(dir, 'sub.diff');
    writeFileSync(
      diffPath,
      [
        'diff --git a/sub b/sub',
        'index 1111111aaa..2222222bbb 160000',
        '--- a/sub',
        '+++ b/sub',
        '@@ -1 +1 @@',
        '-Subproject commit 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '+Subproject commit 2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '',
      ].join('\n'),
    );
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'sub:1' });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('gitlink/submodule');
  });

  it('refuses submodule ADDITION and DELETION hunks, not only pointer changes', () => {
    // git emits a submodule deletion as `deleted file mode 160000` + an index
    // line whose other side is all-zero (no trailing 160000), and an addition
    // as `new file mode 160000` — neither matches the trailing-mode index
    // regex, so only the file-mode markers catch them. Without this, git apply
    // -R exits 0 without moving the gitlink and applied:true is a false witness.
    const del = [
      'diff --git a/vendor/lib b/vendor/lib',
      'deleted file mode 160000',
      'index cc9a958ccccccccccccccccccccccccccccccccc..0000000000000000000000000000000000000000',
      '--- a/vendor/lib',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-Subproject commit cc9a958ccccccccccccccccccccccccccccccccc',
      '',
    ].join('\n');
    const add = [
      'diff --git a/vendor/lib b/vendor/lib',
      'new file mode 160000',
      'index 0000000000000000000000000000000000000000..cc9a958ccccccccccccccccccccccccccccccccc',
      '--- /dev/null',
      '+++ b/vendor/lib',
      '@@ -0,0 +1 @@',
      '+Subproject commit cc9a958ccccccccccccccccccccccccccccccccc',
      '',
    ].join('\n');
    for (const [label, text] of [
      ['delete', del],
      ['add', add],
    ] as const) {
      const dir = tempDir(`rh-sub-${label}-`);
      const diffPath = join(dir, 'sub.diff');
      writeFileSync(diffPath, text);
      const r = runRevertHunk({
        diff: diffPath,
        tree: dir,
        hunk: 'vendor/lib:1',
      });
      expect(r.applied).toBe(false);
      expect(r.harnessFailure).toBe(true);
      expect(r.note).toContain('gitlink/submodule');
    }
  });

  it('refuses a gitlink whose index line carries trailing whitespace or uppercase SHAs', () => {
    // The predicate's `$` anchor and lowercase-only class admitted both
    // shapes: the section reached the apply, `git apply -R` exited 0 without
    // moving the pointer, and applied:true witnessed a revert that never
    // happened. The check must be as loose as its startsWith siblings —
    // over-refusing to the exit-2 harness class is the safe direction.
    for (const index of [
      'index 1111111aaa..2222222bbb 160000 ', // trailing whitespace
      'index 1111111AAA..2222222BBB 160000', // uppercase SHAs
    ]) {
      const { dir } = twoHunkFixture();
      const diffPath = join(dir, 'subx.diff');
      writeFileSync(
        diffPath,
        [
          'diff --git a/sub b/sub',
          index,
          '--- a/sub',
          '+++ b/sub',
          '@@ -1 +1 @@',
          '-Subproject commit 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '+Subproject commit 2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '',
        ].join('\n'),
      );
      const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'sub:1' });
      expect(r.applied).toBe(false);
      expect(r.harnessFailure).toBe(true);
      expect(r.note).toContain('gitlink/submodule');
    }
  });

  it('refuses a section mixing rename/copy metadata with a /dev/null side', () => {
    // A contradictory shape git never emits (a real rename/copy has two real
    // paths). Left through, extractHunkPatch's old-side rewrite fires on
    // isMoveOrCopy and rewrites the /dev/null token into a fabricated real
    // path, reverse-applying over the WRONG mutation with applied:true.
    const dir = tempDir('rh-rendevnull-');
    const diffPath = join(dir, 'x.diff');
    writeFileSync(
      diffPath,
      [
        'diff --git a/old b/new',
        'rename from old',
        'rename to new',
        '--- /dev/null',
        '+++ b/new',
        '@@ -0,0 +1 @@',
        '+content',
        '',
      ].join('\n'),
    );
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'new:1' });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.note).toContain('/dev/null');
  });

  it('does not count a format-patch signature trailer as a removed line', () => {
    // `git format-patch -1 --stdout` appends an mbox trailer (`-- \n<version>`)
    // after the last hunk; parseDiff leaves that hunk's range open to EOF, so a
    // raw scan reads the `-- ` line's leading `-` as a removed line. The count
    // must be bounded by the hunk header's declared line counts instead.
    const dir = tempDir('rh-fp-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'f.txt'), 'one\ntwo\nthree\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'f.txt'), 'one\nTWO\nthree\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const patchPath = join(dir, 'fp.patch');
    writeFileSync(patchPath, git(dir, 'format-patch', '-1', '--stdout'));
    const raw = readFileSync(patchPath, 'utf8');
    // Sanity: the capture really carries the mbox signature trailer.
    expect(raw).toContain('\n-- \n');

    const hunks = listHunks(raw);
    const h = hunks.find((x) => x.id === 'f.txt:1')!;
    expect(h.removedLines).toBe(1); // the real edit, not 1 + the `-- ` trailer
    expect(h.addedLines).toBe(1);
    // And the revert still applies cleanly — the trailer is not in the patch.
    const r = runRevertHunk({ diff: patchPath, tree: dir, hunk: 'f.txt:1' });
    expect(r.applied).toBe(true);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('survives a physically empty blank context line (diff.suppressBlankEmpty)', () => {
    // Under diff.suppressBlankEmpty git emits a blank context line as a
    // physically EMPTY record, which parseDiff counts as context and git's own
    // patch engine accepts. A body scan that breaks on the empty record
    // truncates the hunk before the blank line while the `@@` header keeps its
    // declared counts — `git apply -R --check` then fails with `corrupt patch`
    // (exit 128), misattributing an extraction defect to the tree/harness and
    // making the revert permanently impossible for any such capture.
    const dir = tempDir('rh-sbe-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 's.txt'), 'top-old\n\nbottom-old\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 's.txt'), 'top-new\n\nbottom-new\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const plain = git(dir, 'diff', 'HEAD~1', 'HEAD');
    const diffText = git(
      dir,
      '-c',
      'diff.suppressBlankEmpty=true',
      'diff',
      'HEAD~1',
      'HEAD',
    );
    // Sanity: the capture really carries the suppressed shape — the blank
    // context line loses its leading space.
    expect(plain).toContain('\n \n');
    expect(diffText).not.toBe(plain);
    const diffPath = join(dir, 'sbe.diff');
    writeFileSync(diffPath, diffText);

    const hunks = listHunks(diffText);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedLines).toBe(2);
    expect(hunks[0].removedLines).toBe(2);

    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 's.txt:1' });
    expect(r.harnessFailure).toBeUndefined();
    expect(r.applied).toBe(true);
    // The blank line survives the revert intact.
    expect(readFileSync(join(dir, 's.txt'), 'utf8')).toBe(
      'top-old\n\nbottom-old\n',
    );
  });

  it('refuses a CRLF-normalized diff as a harness fact, not a coupling refusal', () => {
    // A capture whose line endings were normalized to CRLF carries a trailing
    // \r on the `@@` header; git apply would refuse the \r\n patch and the
    // refusal would read as a coupling fact (exit 1) instead of the repairable
    // exit-2 class every other damaged capture gets.
    const { dir, diffPath } = twoHunkFixture();
    const crlf = readFileSync(diffPath, 'utf8').replace(/\n/g, '\r\n');
    const crlfPath = join(dir, 'crlf.diff');
    writeFileSync(crlfPath, crlf);
    const r = runRevertHunk({ diff: crlfPath, tree: dir, hunk: 'f.txt:1' });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(r.note).toContain('CRLF');
  });

  it('does not fire the CRLF guard on a diff whose CONTENT lines carry \\r', () => {
    // A CRLF file's own bytes appear as `+content\r` lines; only a normalized
    // capture puts \r on the structural `@@` header. The guard must key on the
    // header, or it refuses legitimate diffs of CRLF-terminated files.
    const dir = tempDir('rh-crcontent-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'crlf.txt'), 'alpha\r\nBETA\r\ngamma\r\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const diffPath = join(dir, 'content.diff');
    writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD'));
    // The diff bytes contain \r\n on content lines but not on the `@@` header.
    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'crlf.txt:1' });
    expect(r.note ?? '').not.toContain('CRLF');
    expect(r.applied).toBe(true);
  });

  it('refuses a plain (non-repo) --tree instead of mutating the wrong directory', () => {
    // git apply needs no repository; a --tree pointing at a plain directory
    // whose contents happen to match would silently reverse-apply into the
    // wrong place with applied:true. Require a real work tree up front.
    const { diffPath } = twoHunkFixture();
    const plain = tempDir('rh-nonrepo-'); // exists, but no git init
    const r = runRevertHunk({ diff: diffPath, tree: plain, hunk: 'f.txt:1' });
    expect(r.applied).toBe(false);
    expect(r.harnessFailure).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(r.note).toContain('not inside a git repository');
  });

  it('refuses a bare repo or a .git dir as --tree — repo-ness is not work-tree-ness', () => {
    // A bare clone and a `.git` metadata dir both answer
    // `git rev-parse --git-dir` with exit 0, but neither holds work-tree
    // files: the apply's guaranteed refusal there is exit 1, not 128, so it
    // would land in the conflict branch and be recorded as a coupling fact
    // about the hunk — the fabrication the --tree gate exists to prevent.
    const { dir, diffPath } = twoHunkFixture();
    const bare = tempDir('rh-bare-');
    execFileSync('git', ['clone', '-q', '--bare', dir, bare]);
    for (const tree of [bare, join(dir, '.git')]) {
      const r = runRevertHunk({ diff: diffPath, tree, hunk: 'f.txt:1' });
      expect(r.applied).toBe(false);
      expect(r.harnessFailure).toBe(true);
      expect(r.conflict).toBeUndefined();
      expect(r.note).toContain('not inside a git repository');
    }
  });

  it('reverts under apply.whitespace=fix without silently rewriting the restored base', () => {
    // A repo whose config sets apply.whitespace=fix would have git strip the
    // trailing space off the base line as it is re-added under -R, so the
    // reverted tree would NOT match base byte-for-byte — a half-mutation the
    // report would still call applied:true. --whitespace=nochange pins it.
    const dir = tempDir('rh-ws-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'apply.whitespace', 'fix');
    const base = 'alpha\nkeepme \nomega\n'; // note the trailing space on line 2
    writeFileSync(join(dir, 'w.txt'), base);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'w.txt'), 'alpha\nkeepme\nomega\n'); // space removed
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pr');
    const diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD'));

    const r = runRevertHunk({ diff: diffPath, tree: dir, hunk: 'w.txt:1' });
    expect(r.applied).toBe(true);
    // The restored base must carry the trailing space back verbatim.
    expect(readFileSync(join(dir, 'w.txt'), 'utf8')).toBe(base);
  });
});

describe('the command wiring', () => {
  it('--list prints the enumeration without touching any tree, exit 0', () => {
    const { diffPath } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      list: true,
    });
    const printed = vi
      .mocked(writeStdoutLineSafe)
      .mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(printed) as {
      hunks: Array<{ id: string }>;
    };
    expect(parsed.hunks.map((h) => h.id)).toEqual(['f.txt:1', 'f.txt:2']);
    // The enumeration is step one of every calling script; a stray non-zero
    // here aborts hunk selection with a perfectly good listing on stdout.
    expect(process.exitCode).toBe(0);
  });

  it('demands both --hunk and --tree when not listing, and says so', () => {
    const { diffPath } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      list: false,
      hunk: 'f.txt:1',
    });
    expect(process.exitCode).toBe(2);
    // Exit 2 alone cannot distinguish the graceful branch from a crash — the
    // usage message is the contract.
    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledWith(
      expect.stringContaining('--hunk <path>:<n> and --tree'),
    );
    process.exitCode = 0;
  });

  it('exit code carries applied/refused — the branch a calling script takes', () => {
    // A verifier script branches on the exit status; a refusal reported as 0
    // sends it to probe an un-mutated tree — the wrong half of the
    // intact/reverted witness pair.
    const { dir, diffPath } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      hunk: 'f.txt:1',
      tree: dir,
    });
    expect(process.exitCode).toBe(0);
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      hunk: 'f.txt:1',
      tree: dir,
    });
    expect(process.exitCode).toBe(1);
    // The refusal REPORT still reaches stdout — exit 1 tells the script
    // which branch to take, the JSON tells it why (coupling vs mutated tree
    // vs harness race), and losing the second half strands the caller.
    const printed = vi
      .mocked(writeStdoutLineSafe)
      .mock.calls.at(-1)?.[0] as string;
    expect((JSON.parse(printed) as { applied: boolean }).applied).toBe(false);
    process.exitCode = 0;
  });

  it('--out carries the same report stdout did, and an unusable --out refuses BEFORE mutating', () => {
    const { dir, diffPath } = twoHunkFixture();
    const out = join(tempDir('rh-out-'), 'report.json');
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      hunk: 'f.txt:1',
      tree: dir,
      out,
    });
    expect(process.exitCode).toBe(0);
    const printed = vi
      .mocked(writeStdoutLineSafe)
      .mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(JSON.parse(printed));

    // A not-yet-existing parent directory is created for --out — deleting
    // the mkdir would ship green against an already-existing parent.
    const nested = twoHunkFixture();
    const nestedOut = join(tempDir('rh-out2-'), 'deep', 'nest', 'report.json');
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: nested.diffPath,
      hunk: 'f.txt:1',
      tree: nested.dir,
      out: nestedOut,
    });
    expect(existsSync(nestedOut)).toBe(true);

    // A directory --out must be classified before the reverse-apply runs —
    // discovering EISDIR after it would leave a mutated tree behind a
    // failure exit nothing distinguishes.
    const fresh = twoHunkFixture();
    const before = readFileSync(join(fresh.dir, 'f.txt'), 'utf8');
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: fresh.diffPath,
      hunk: 'f.txt:1',
      tree: fresh.dir,
      out: tempDir('rh-outdir-'),
    });
    expect(process.exitCode).toBe(2);
    expect(readFileSync(join(fresh.dir, 'f.txt'), 'utf8')).toBe(before);
    // The outer catch's diagnostic is not silent — deleting the
    // writeStderrLineSafe there would exit 2 with nothing said. Assert the
    // OUTER-CATCH message specifically (the directory-out TypeError text),
    // not the `revert-hunk:` prefix every message shares.
    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledWith(
      expect.stringContaining('names a directory, not a file'),
    );
    process.exitCode = 0;
  });

  it('maps a harness failure (bad --tree) to exit 2 through the handler', () => {
    const { diffPath } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      hunk: 'f.txt:1',
      tree: '/definitely/not/a/tree-xyz',
    });
    // Exit 2 (repairable), not 1 (a refusal a calling script records as a
    // coupling fact).
    expect(process.exitCode).toBe(2);
    const printed = vi
      .mocked(writeStdoutLineSafe)
      .mock.calls.at(-1)?.[0] as string;
    expect((JSON.parse(printed) as { applied: boolean }).applied).toBe(false);
    process.exitCode = 0;
  });

  it('writes the report to --out on a REFUSAL too, not only on apply', () => {
    // The consumer brief quotes the applied:false fact from --out; gating the
    // write on `applied` leaves a stale or absent file after a refusal.
    const { dir, diffPath } = twoHunkFixture();
    runRevertHunk({ diff: diffPath, tree: dir, hunk: 'f.txt:1' }); // mutate first
    const out = join(tempDir('rh-refout-'), 'r.json');
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      hunk: 'f.txt:1', // now refuses — its "+" side is gone
      tree: dir,
      out,
    });
    expect(process.exitCode).toBe(1);
    const written = JSON.parse(readFileSync(out, 'utf8')) as {
      applied: boolean;
    };
    expect(written.applied).toBe(false);
  });

  it('a mistyped --diff exits 2 with the reason named — never the refused-revert class', () => {
    const { dir } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: '/no/such/place/pr.diff',
      hunk: 'f.txt:1',
      tree: dir,
    });
    expect(process.exitCode).toBe(2);
    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledWith(
      expect.stringContaining('not a readable file'),
    );
    process.exitCode = 0;
  });

  it('parses through the REAL yargs builder — the conflicts guard must not eat --hunk', () => {
    // The documented trap this pins: giving the boolean `--list` option a
    // `default: false` makes yargs `conflicts` treat it as "given", and
    // `--hunk` is then rejected before the handler runs — the command's
    // primary path dead while every handler-level test stays green.
    const { dir, diffPath } = twoHunkFixture();
    const handler = vi.fn();
    const failures: string[] = [];
    yargs([
      'revert-hunk',
      '--diff',
      diffPath,
      '--hunk',
      'f.txt:1',
      '--tree',
      dir,
    ])
      .command({ ...revertHunkCommand, handler })
      .exitProcess(false)
      .fail((msg) => {
        failures.push(msg ?? '');
      })
      .parseSync();
    expect(failures).toEqual([]);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      diff: diffPath,
      hunk: 'f.txt:1',
      tree: dir,
    });

    // And the guard itself still guards: --list with --hunk is refused. The
    // fail callback THROWS on purpose — a yargs fail handler that returns
    // normally lets parsing continue into the command handler, which is a
    // yargs quirk, not this command's contract.
    const handler2 = vi.fn();
    const failures2: string[] = [];
    expect(() =>
      yargs(['revert-hunk', '--diff', diffPath, '--list', '--hunk', 'f.txt:1'])
        .command({ ...revertHunkCommand, handler: handler2 })
        .exitProcess(false)
        .fail((msg) => {
          failures2.push(msg ?? '');
          throw new Error(msg ?? 'parse failure');
        })
        .parseSync(),
    ).toThrow();
    expect(handler2).not.toHaveBeenCalled();
    expect(failures2.join('\n')).toContain('mutually exclusive');
  });
});
