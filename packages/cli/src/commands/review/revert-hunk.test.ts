/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The mechanical claim under test: hunk N of file F, extracted VERBATIM and
// applied in reverse by git's own patch engine — never a hand transcription,
// never a reimplementation of `git apply`. The fixtures are real repositories
// and the applies are real, because the one oracle this command must agree
// with is git itself.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A real two-hunk history: a base commit, then one commit editing the file's
 * top AND bottom — far enough apart that git emits two hunks. The tree is
 * left at the "PR head" state, which is what a scratch tree holds.
 */
function twoHunkFixture(trailingNewline = true) {
  const dir = mkdtempSync(join(tmpdir(), 'rh-'));
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

  it('demands both --hunk and --tree when not listing', () => {
    const { diffPath } = twoHunkFixture();
    process.exitCode = 0;
    (revertHunkCommand.handler as (a: unknown) => void)({
      diff: diffPath,
      list: false,
      hunk: 'f.txt:1',
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});
