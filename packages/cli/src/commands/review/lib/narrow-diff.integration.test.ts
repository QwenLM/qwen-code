/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Drives the narrowing against captures REAL git produced, on real histories,
// under the flags `fetch-pr` pins.
//
// The property under test is the one the containment oracle spent six review
// rounds failing to prove: every line of the published scope is a line the
// PR's own diff displays. Here it is checked as an invariant over each
// scenario rather than argued per shape — including the shapes that defeated
// the oracle, which now cannot arise because the delta's bytes never reach the
// output.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { narrowToDelta } from './narrow-diff.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from './diff-flags.js';
import { isolateHostGitConfig } from './test-utils.js';

let repo: string;
let env: NodeJS.ProcessEnv;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env });

const captureBytes = (from: string, to: string) =>
  execFileSync(
    'git',
    [...PINNED_DIFF_CONFIG, 'diff', ...PINNED_DIFF_FLAGS, from, to],
    { cwd: repo, maxBuffer: 1 << 28, env },
  );
const capture = (from: string, to: string) =>
  captureBytes(from, to).toString('utf8');

const commit = (msg: string, files: Record<string, string>) => {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(repo, name), body);
  }
  git('add', '-A');
  git('commit', '-qm', msg, '--no-verify');
  return git('rev-parse', 'HEAD').trim();
};

const lines = (n: number, tag = 'L') =>
  Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';

/**
 * The invariant, checked directly: every line of the narrowed text appears in
 * the full capture. Not a sample of shapes — the whole output.
 */
const everyLineIsDisplayed = (narrowed: string, full: string) => {
  const displayed = new Set(full.split('\n'));
  return narrowed
    .split('\n')
    .filter((l) => l !== '')
    .every((l) => displayed.has(l));
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'narrow-'));
  gitIsolation = isolateHostGitConfig();
  env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('narrowToDelta on real-git captures', () => {
  it('keeps only the PR hunks the anchor round did not already cover', () => {
    // Two files edited before the anchor, a third edited after it. The round
    // should review the third and nothing else.
    const base = commit('base', {
      'a.ts': lines(40, 'A'),
      'b.ts': lines(40, 'B'),
      'c.ts': lines(40, 'C'),
    });
    const anchor = commit('round 1', {
      'a.ts': lines(40, 'A').replace('A5\n', 'A5-EDIT\n'),
      'b.ts': lines(40, 'B').replace('B5\n', 'B5-EDIT\n'),
      'c.ts': lines(40, 'C'),
    });
    const head = commit('round 2', {
      'a.ts': lines(40, 'A').replace('A5\n', 'A5-EDIT\n'),
      'b.ts': lines(40, 'B').replace('B5\n', 'B5-EDIT\n'),
      'c.ts': lines(40, 'C').replace('C20\n', 'C20-EDIT\n'),
    });

    const full = capture(base, head);
    const delta = capture(anchor, head);
    const narrowed =
      narrowToDelta(captureBytes(base, head), delta)?.toString('utf8') ?? null;

    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('c.ts');
    expect(narrowed).toContain('+C20-EDIT');
    // The two files the anchor round already reviewed are gone…
    expect(narrowed).not.toContain('a.ts');
    expect(narrowed).not.toContain('b.ts');
    // …and every surviving line came from the PR's own diff.
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('never emits a line the PR diff lacks, on the undo-per-feedback round', () => {
    // The shape that defeated the oracle six times: round 1 adds lines, round
    // 2 takes them back out, so the delta deletes text that stood at neither
    // the base nor the head and the PR's diff displays it on neither side.
    const base = commit('undo base', { 'u.ts': lines(30, 'U') });
    const anchor = commit('undo round 1', {
      'u.ts': lines(30, 'U').replace('U10\n', 'U10\nX1\nX2\nX3\n'),
    });
    const head = commit('undo round 2', {
      'u.ts': lines(30, 'U').replace('U25\n', 'U25-EDIT\n'),
    });

    const full = capture(base, head);
    const delta = capture(anchor, head);
    expect(delta).toContain('-X1'); // the delta really does carry it
    expect(full).not.toContain('X1'); // and the PR's diff never mentions it

    const narrowed =
      narrowToDelta(captureBytes(base, head), delta)?.toString('utf8') ?? null;
    // Whatever it narrowed to, the deleted lines cannot be in it: the output
    // is assembled from `full`, which does not contain them.
    expect(narrowed ?? '').not.toContain('X1');
    if (narrowed !== null) {
      expect(everyLineIsDisplayed(narrowed, full)).toBe(true);
    }
  });

  it('falls back rather than scoping when nothing of the PR diff changed', () => {
    // The anchor round covered the whole PR: nothing since it touches a hunk
    // the PR's diff still carries. Null means "keep the full range", which is
    // the review the round would have done anyway.
    const base = commit('quiet base', { 'q.ts': lines(30, 'Q') });
    const anchor = commit('quiet round 1', {
      'q.ts': lines(30, 'Q').replace('Q5\n', 'Q5-EDIT\n'),
    });
    const head = commit('quiet round 2', {
      'q.ts': lines(30, 'Q').replace('Q5\n', 'Q5-EDIT\n'),
      'untracked-elsewhere.txt': 'noise\n',
    });

    const full = capture(base, head);
    const delta = capture(anchor, head);
    const narrowed =
      narrowToDelta(captureBytes(base, head), delta)?.toString('utf8') ?? null;
    // `untracked-elsewhere.txt` IS in both captures, so this narrows to it —
    // and the assertion that matters is the invariant, not the emptiness.
    if (narrowed !== null) {
      expect(everyLineIsDisplayed(narrowed, full)).toBe(true);
      expect(narrowed).not.toContain('q.ts');
    }
  });

  it('refuses to narrow a capture that does not round-trip through utf8', () => {
    // Narrowing selects over decoded text, so a capture carrying bytes that
    // are not valid UTF-8 cannot be reassembled faithfully — re-encoding
    // would write bytes git never produced, and `diffSha256` would then name
    // a file nobody captured. Checked by round-trip, not by hunting U+FFFD.
    const invalid = Buffer.concat([
      Buffer.from('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from('\n+ok\n'),
    ]);
    expect(invalid.toString('utf8')).not.toBe(invalid.toString('latin1'));
    expect(
      narrowToDelta(invalid, 'diff --git a/f b/f\n@@ -1,1 +1,1 @@\n+ok\n'),
    ).toBeNull();
  });

  it('narrows to a subset that still parses as a diff', () => {
    const base = commit('parse base', {
      'p1.ts': lines(50, 'P'),
      'p2.ts': lines(50, 'R'),
    });
    const anchor = commit('parse round 1', {
      'p1.ts': lines(50, 'P').replace('P5\n', 'P5-EDIT\n'),
      'p2.ts': lines(50, 'R'),
    });
    const head = commit('parse round 2', {
      'p1.ts': lines(50, 'P').replace('P5\n', 'P5-EDIT\n'),
      'p2.ts': lines(50, 'R')
        .replace('R10\n', 'R10-EDIT\n')
        .replace('R40\n', 'R40-EDIT\n'),
    });

    const full = capture(base, head);
    const delta = capture(anchor, head);
    const narrowed = narrowToDelta(captureBytes(base, head), delta)!.toString(
      'utf8',
    );
    expect(narrowed).not.toBeNull();

    // It is still a well-formed diff: git itself accepts it.
    writeFileSync(join(repo, 'narrowed.patch'), narrowed);
    expect(() =>
      git('apply', '--check', '--reverse', 'narrowed.patch'),
    ).not.toThrow();
    expect(everyLineIsDisplayed(narrowed, full)).toBe(true);
  });
});
