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
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
 * Commit after recording an exec-bit flip THROUGH GIT. `chmodSync` alone is
 * invisible on Windows: libuv cannot set the exec bit there, and git's
 * `core.fileMode` is false anyway, so the capture the test drives would
 * carry no mode section on the Windows CI leg. The index-native form
 * records the mode on every platform; the filesystem chmod keeps the
 * worktree consistent with the index where `core.fileMode` IS true.
 */
const commitModeChange = (
  msg: string,
  file: string,
  exec: boolean,
  files: Record<string, string>,
) => {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(repo, name), body);
  }
  chmodSync(join(repo, file), exec ? 0o755 : 0o644);
  git('add', '-A');
  git('update-index', `--chmod=${exec ? '+x' : '-x'}`, file);
  git('commit', '-qm', msg, '--no-verify');
  return git('rev-parse', 'HEAD').trim();
};

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
    const deltaBytes = captureBytes(anchor, head);
    const narrowed =
      narrowToDelta(captureBytes(base, head), deltaBytes)?.toString('utf8') ??
      null;

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
    const deltaBytes = captureBytes(anchor, head);
    expect(deltaBytes.toString('utf8')).toContain('-X1'); // really carries it
    expect(full).not.toContain('X1'); // and the PR's diff never mentions it

    const narrowed =
      narrowToDelta(captureBytes(base, head), deltaBytes)?.toString('utf8') ??
      null;
    // The scenario is constructed to narrow — the delta's surviving edit
    // overlaps the full capture's one hunk — so assert it outright. A
    // regression refusing on ANY missed delta range (all-or-nothing emission
    // instead of per-hunk) must not ship green behind a null-tolerant check.
    expect(narrowed).not.toBeNull();
    // Whatever it narrowed to, the deleted lines cannot be in it: the output
    // is assembled from `full`, which does not contain them.
    expect(narrowed!).not.toContain('X1');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('narrows to a post-anchor file the PR diff also carries', () => {
    // The anchor round covered the original file; the only work since it is a
    // brand-new file, which both captures carry.
    const base = commit('quiet base', { 'q.ts': lines(30, 'Q') });
    const anchor = commit('quiet round 1', {
      'q.ts': lines(30, 'Q').replace('Q5\n', 'Q5-EDIT\n'),
    });
    const head = commit('quiet round 2', {
      'q.ts': lines(30, 'Q').replace('Q5\n', 'Q5-EDIT\n'),
      'untracked-elsewhere.txt': 'noise\n',
    });

    const full = capture(base, head);
    const deltaBytes = captureBytes(anchor, head);
    const narrowed =
      narrowToDelta(captureBytes(base, head), deltaBytes)?.toString('utf8') ??
      null;
    // The scenario is constructed to narrow, so assert it outright: a
    // regression returning null for new-file delta sections must not pass
    // with zero assertions executed behind a null guard.
    expect(narrowed).not.toBeNull();
    // `untracked-elsewhere.txt` IS in both captures, so this narrows to it —
    // and the assertion that matters is the invariant, not the emptiness.
    expect(narrowed).toContain('untracked-elsewhere.txt');
    expect(narrowed).not.toContain('q.ts');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('refuses to narrow a capture that does not round-trip through utf8', () => {
    // Narrowing selects over decoded text, so a capture carrying bytes that
    // are not valid UTF-8 cannot be reassembled faithfully — re-encoding
    // would write bytes git never produced, and `diffSha256` would then name
    // a file nobody captured. Checked by refusing to decode, not by hunting
    // U+FFFD.
    const invalid = Buffer.concat([
      Buffer.from('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from('\n+ok\n'),
    ]);
    expect(invalid.toString('utf8')).not.toBe(invalid.toString('latin1'));
    expect(
      narrowToDelta(
        invalid,
        Buffer.from('diff --git a/f b/f\n@@ -1,1 +1,1 @@\n+ok\n', 'utf8'),
      ),
    ).toBeNull();
  });

  it('refuses to narrow a delta that does not round-trip through utf8', () => {
    // Symmetric with the full-side refusal: the delta's decoded paths drive
    // the guard and the join, so a lossily pre-decoded delta folds an
    // invalid path byte onto U+FFFD, which can collide with a legitimate
    // U+FFFD path the full capture carries and publish an unchanged file's
    // hunks. Fatal-decoding the delta refuses the shape instead; the round
    // keeps the full range.
    const delta = Buffer.concat([
      Buffer.from('diff --git a/f'),
      Buffer.from([0xff]),
      Buffer.from(' b/f'),
      Buffer.from([0xff]),
      Buffer.from('\n@@ -1,1 +1,1 @@\n-x\n+y\n'),
    ]);
    const full = Buffer.from(
      'diff --git a/g.ts b/g.ts\n--- a/g.ts\n+++ b/g.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n',
      'utf8',
    );
    expect(narrowToDelta(full, delta)).toBeNull();
  });

  it('falls back rather than scoping when the captures key a change differently', () => {
    // Round 1 renames old.ts -> new.ts; round 2 deletes new.ts and edits
    // other.ts. `base..head` nets the chain to a plain deletion keyed
    // `old.ts`; `anchor..head` deletes `new.ts`. The change both the delta
    // performed and the PR's diff displays sits under a key the delta does
    // not carry, so narrowing would silently drop it — refuse instead. The
    // round keeps the full range, which still displays it.
    const base = commit('rename-fallback base', {
      'old.ts': lines(8, 'O'),
      'other.ts': lines(8, 'T'),
    });
    git('mv', 'old.ts', 'new.ts');
    git('commit', '-qm', 'rename-fallback round 1', '--no-verify');
    const anchor = git('rev-parse', 'HEAD').trim();
    git('rm', '-q', 'new.ts');
    writeFileSync(
      join(repo, 'other.ts'),
      lines(8, 'T').replace('T3\n', 'T3-EDIT\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'rename-fallback round 2', '--no-verify');

    const deltaBytes = captureBytes(anchor, 'HEAD');
    const delta = deltaBytes.toString('utf8');
    expect(delta).toContain('b/new.ts');
    expect(delta).not.toContain('b/old.ts');
    expect(narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)).toBeNull();
  });

  it('refuses to narrow a rewrite the delta keys as a rename', () => {
    // Round 1 completely rewrites old.ts (similarity below git's rename
    // threshold); round 2 renames it and edits another file. `base..head`
    // nets the chain to a `new.ts` addition plus an `old.ts` deletion;
    // `anchor..head` carries a 100%-similarity rename keyed on the NEW
    // path. The path guard cannot see the divergence — the new path IS in
    // the full capture, as the addition — while the rename's deletion half
    // sits under the old path, keyed only there. Narrowing would publish
    // the addition and silently drop the deletion, so the rename guard
    // refuses instead: the round keeps the full range, which still displays
    // it.
    const base = commit('rewrite-rename base', {
      'rw-old.ts': lines(8, 'O'),
      'rw-other.ts': lines(8, 'T'),
    });
    commit('rewrite-rename round 1', {
      'rw-old.ts': lines(8, 'W'),
      'rw-other.ts': lines(8, 'T'),
    });
    const anchor = git('rev-parse', 'HEAD').trim();
    git('mv', 'rw-old.ts', 'rw-new.ts');
    writeFileSync(
      join(repo, 'rw-other.ts'),
      lines(8, 'T').replace('T3\n', 'T3-EDIT\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'rewrite-rename round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    const delta = deltaBytes.toString('utf8');
    // The scenario's premise: the two captures key the move differently.
    expect(delta).toContain('rename from rw-old.ts');
    expect(full).not.toContain('rename from');
    expect(full).toContain('-O1'); // the deletion the PR's diff displays
    expect(narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)).toBeNull();
  });

  it('emits the full section whole for a hunk-less delta touch', () => {
    // Round 1 edits m.sh's content; round 2 chmods it and edits other.ts.
    // The delta's m.sh section is mode-only — no hunks — and the change
    // lives in the full section's header, so the section is emitted whole.
    // A security-relevant executable-bit change must not drop from scope.
    const base = commit('mode base', {
      'm.sh': lines(8, 'M'),
      'other.ts': lines(8, 'T'),
    });
    const anchor = commit('mode round 1', {
      'm.sh': lines(8, 'M').replace('M2\n', 'M2-EDIT\n'),
      'other.ts': lines(8, 'T'),
    });
    commitModeChange('mode round 2', 'm.sh', true, {
      'm.sh': lines(8, 'M').replace('M2\n', 'M2-EDIT\n'),
      'other.ts': lines(8, 'T').replace('T4\n', 'T4-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const narrowed =
      narrowToDelta(
        captureBytes(base, 'HEAD'),
        captureBytes(anchor, 'HEAD'),
      )?.toString('utf8') ?? null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('new mode 100755');
    expect(narrowed).toContain('+T4-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('emits the rename section for a hunk-less pure-rename delta', () => {
    // Round 1 edits one line; round 2 renames the file. The delta is a
    // hunk-less pure rename keyed on the new path; the full capture carries
    // the same path with hunks. The rename — this round's work — must not
    // drop.
    const base = commit('pure-rename base', {
      'old.ts': lines(8, 'O'),
      'keep.ts': 'k\n',
    });
    commit('pure-rename round 1', {
      'old.ts': lines(8, 'O').replace('O5\n', 'O5-EDIT\n'),
      'keep.ts': 'k\n',
    });
    const anchor = git('rev-parse', 'HEAD').trim();
    git('mv', 'old.ts', 'new.ts');
    git('commit', '-qm', 'pure-rename round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('rename to new.ts');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('rename to new.ts');
    expect(narrowed).toContain('+O5-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries the section when a mode change reverts but content stays', () => {
    // Round 1 chmods AND edits; round 2 reverts the mode only. The delta's
    // section is mode-only while the full section carries the round-1
    // content hunks; the touch carries the section whole. Over-inclusion
    // (re-reviewing those hunks) is the chosen semantics — every emitted
    // line is still displayed.
    const base = commit('mode-revert base', {
      'c.sh': lines(8, 'C'),
      'other.ts': lines(8, 'T'),
    });
    const anchor = commitModeChange('mode-revert round 1', 'c.sh', true, {
      'c.sh': lines(8, 'C').replace('C3\n', 'C3-EDIT\n'),
      'other.ts': lines(8, 'T'),
    });
    commitModeChange('mode-revert round 2', 'c.sh', false, {
      'c.sh': lines(8, 'C').replace('C3\n', 'C3-EDIT\n'),
      'other.ts': lines(8, 'T').replace('T6\n', 'T6-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const narrowed =
      narrowToDelta(
        captureBytes(base, 'HEAD'),
        captureBytes(anchor, 'HEAD'),
      )?.toString('utf8') ?? null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('c.sh');
    expect(narrowed).toContain('+T6-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a mode-only full section the delta touches with content hunks', () => {
    // Mirror of the hunk-less-delta shape: round 1 chmods AND edits m.sh;
    // round 2 reverts only the content. `base..head` nets to a mode-only
    // section — no hunks — while the delta carries the content reversion's
    // hunk. The emission must carry the full section whole; a hunkless full
    // section must not be skipped because the delta has ranges at the path.
    const base = commit('mode-net base', { 'mode-net.sh': lines(8, 'M') });
    const anchor = commitModeChange('mode-net round 1', 'mode-net.sh', true, {
      'mode-net.sh': lines(8, 'M').replace('M4\n', 'M4-EDIT\n'),
    });
    commit('mode-net round 2', { 'mode-net.sh': lines(8, 'M') });

    const full = capture(base, 'HEAD');
    // The scenario's premise: full nets to mode-only, delta carries hunks.
    expect(full).toContain('new mode 100755');
    expect(full).not.toContain('@@');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('@@');

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('new mode 100755');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('falls back when the delta overlaps no hunk the PR diff still carries', () => {
    // Round 1 inserts X1–X3 and edits U25; round 2 reverts the insertion,
    // keeping the edit. The delta's one hunk — the X deletion — lands in a
    // new-side range the full capture's single hunk (the U25 edit) does not
    // reach, so there is genuinely nothing to narrow to. Unconditional: the
    // fallback must not hide behind a null guard.
    const base = commit('no-overlap base', { 'u.ts': lines(30, 'U') });
    const anchor = commit('no-overlap round 1', {
      'u.ts': lines(30, 'U')
        .replace('U10\n', 'U10\nX1\nX2\nX3\n')
        .replace('U25\n', 'U25-EDIT\n'),
    });
    commit('no-overlap round 2', {
      'u.ts': lines(30, 'U').replace('U25\n', 'U25-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('-X1');
    expect(full).not.toContain('X1');
    expect(narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)).toBeNull();
  });

  it('accepts a delta whose deletion the PR diff performs too', () => {
    // The control for the deletion shape: head deletes lines that stood at
    // the base, so the delta's deletion hunk and the full capture's are the
    // same hunk — the scope must carry it, not refuse it.
    const base = commit('deletion base', {
      'd.ts': lines(30, 'D'),
      'e.ts': lines(10, 'E'),
    });
    const anchor = commit('deletion round 1', {
      'd.ts': lines(30, 'D'),
      'e.ts': lines(10, 'E').replace('E2\n', 'E2-EDIT\n'),
    });
    commit('deletion round 2', {
      'd.ts': lines(30, 'D').replace('D10\nD11\nD12\n', ''),
      'e.ts': lines(10, 'E').replace('E2\n', 'E2-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('-D10');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('-D10');
    expect(narrowed).not.toContain('e.ts');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('emits a whole-file deletion the delta performs too', () => {
    // The whole-file-deletion shape rides two implementation choices at
    // once: parseDiff clamps a `+0,0` hunk to the point range [0, 0], and
    // `overlaps` is inclusive. An off-by-one in either would silently drop
    // file deletions from the incremental scope while the PR diff displays
    // them — the mid-file deletion control above cannot see it, its range
    // shape is different.
    const base = commit('rm base', {
      'f.ts': lines(10, 'F'),
      'g.ts': lines(10, 'G'),
    });
    const anchor = commit('rm round 1', {
      'f.ts': lines(10, 'F').replace('F2\n', 'F2-EDIT\n'),
      'g.ts': lines(10, 'G').replace('G2\n', 'G2-EDIT\n'),
    });
    git('rm', '-q', 'f.ts');
    writeFileSync(
      join(repo, 'g.ts'),
      lines(10, 'G').replace('G2\n', 'G2-EDIT\n').replace('G7\n', 'G7-EDIT\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'rm round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('deleted file mode');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('deleted file mode');
    expect(narrowed).toContain('--- a/f.ts');
    expect(narrowed).toContain('-F1');
    expect(narrowed).toContain('+G7-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('assembles a selected hunk beyond the argument-count ceiling', () => {
    // A selected hunk over ~125k lines used to throw a RangeError from
    // spreading it into a single `push` — crashing the whole fetch-pr round
    // instead of degrading. A regenerated lockfile on a large long-lived PR
    // is exactly such a hunk.
    const N = 150_000;
    const base = commit('huge base', { 'keep.ts': 'keep\n' });
    const anchor = commit('huge round 1', {
      'keep.ts': 'keep\n',
      'f.txt': lines(N, 'F'),
    });
    commit('huge round 2', {
      'keep.ts': 'keep\n',
      'f.txt': lines(N, 'F').replace(`F${N / 2}\n`, `F${N / 2}-EDIT\n`),
    });

    const full = capture(base, 'HEAD');
    const narrowed =
      narrowToDelta(
        captureBytes(base, 'HEAD'),
        captureBytes(anchor, 'HEAD'),
      )?.toString('utf8') ?? null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain(`+F${N / 2}-EDIT`);
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
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
    const deltaBytes = captureBytes(anchor, head);
    const narrowed = narrowToDelta(
      captureBytes(base, head),
      deltaBytes,
    )!.toString('utf8');
    expect(narrowed).not.toBeNull();

    // It is still a well-formed diff: git itself accepts it.
    writeFileSync(join(repo, 'narrowed.patch'), narrowed);
    expect(() =>
      git('apply', '--check', '--reverse', 'narrowed.patch'),
    ).not.toThrow();
    expect(everyLineIsDisplayed(narrowed, full)).toBe(true);
    // EVERY matching hunk survives, not just the first: p2.ts carries two
    // post-anchor edit regions, and a first-match-only emission would drop
    // the second from the scope while every check above stayed green.
    expect(narrowed).toContain('+R10-EDIT');
    expect(narrowed).toContain('+R40-EDIT');
  });
});
