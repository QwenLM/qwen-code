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

import { describe, it, expect, vi, afterAll } from 'vitest';
import yargs from 'yargs';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
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

  it('reverts a mode-changed file’s content hunk WITHOUT flipping the mode', () => {
    // `old mode`/`new mode` lines carried into the patch would strip the +x
    // the PR added while the note claims a content-only revert — the probe
    // then fails because the script lost its execute bit.
    const dir = tempDir('rh-mode-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
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
});

describe('the command wiring', () => {
  it('--list prints the enumeration without touching any tree', () => {
    const { diffPath } = twoHunkFixture();
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      list: true,
    });
    const printed = vi.mocked(writeStdoutLine).mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(printed) as {
      hunks: Array<{ id: string }>;
    };
    expect(parsed.hunks.map((h) => h.id)).toEqual(['f.txt:1', 'f.txt:2']);
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
