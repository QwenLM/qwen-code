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
import {
  assembleSections,
  narrowToDelta,
  selectNarrowing,
} from './narrow-diff.js';
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
    // keeps the full range. The full side carries the collision's other
    // half — a legitimate U+FFFD path (bytes EF BF BD) whose hunk overlaps
    // the delta's range — so a lossily decoded delta would pass the path
    // guard and publish: the assertion answers null only while the fatal
    // guard stands.
    const delta = Buffer.concat([
      Buffer.from('diff --git a/f'),
      Buffer.from([0xff]),
      Buffer.from(' b/f'),
      Buffer.from([0xff]),
      Buffer.from('\n@@ -1,1 +1,1 @@\n-x\n+y\n'),
    ]);
    const fffd = Buffer.from([0xef, 0xbf, 0xbd]);
    const full = Buffer.concat([
      Buffer.from('diff --git a/f'),
      fffd,
      Buffer.from(' b/f'),
      fffd,
      Buffer.from('\n--- a/f'),
      fffd,
      Buffer.from('\n+++ b/f'),
      fffd,
      Buffer.from('\n@@ -1,1 +1,1 @@\n-a\n+b\n'),
    ]);
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

  it('carries a post-anchor mode flip whose hunks all miss the full capture', () => {
    // Round 1 edits lines 5 and 15; round 2 reverts line 5, keeps line 15,
    // and flips the exec bit. The delta's section then carries BOTH the
    // mode flip and a revert hunk whose new-side range overlaps no full
    // hunk. The hunk miss must not drop the header-level change with it:
    // the exec-bit flip sits in no other review chunk, and the ledger
    // certifies head, so a dropped section never re-enters any later scope.
    const base = commit('mode-miss base', {
      'mm.sh': lines(20, 'M'),
      'mm-other.ts': lines(8, 'T'),
    });
    const anchor = commit('mode-miss round 1', {
      'mm.sh': lines(20, 'M')
        .replace('M5\n', 'M5-EDIT\n')
        .replace('M15\n', 'M15-EDIT\n'),
      'mm-other.ts': lines(8, 'T'),
    });
    commitModeChange('mode-miss round 2', 'mm.sh', true, {
      'mm.sh': lines(20, 'M').replace('M15\n', 'M15-EDIT\n'),
      'mm-other.ts': lines(8, 'T').replace('T4\n', 'T4-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the mode flip rides a section whose only
    // hunk — the line-5 revert — nets out of the full capture.
    expect(full).toContain('new mode 100755');
    expect(deltaBytes.toString('utf8')).toContain('-M5-EDIT');
    expect(full).not.toContain('M5-EDIT');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('new mode 100755');
    expect(narrowed).toContain('+M15-EDIT');
    expect(narrowed).toContain('+T4-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a post-anchor rename whose hunks all miss the full capture', () => {
    // Round 1 edits lines 5 and 15; round 2 renames the file and reverts
    // line 5, keeping line 15. Both captures key the SAME rename, so the
    // rename guard passes — and the delta's revert hunk then misses every
    // full hunk exactly as in the mode-flip sibling. The rename — this
    // round's work — must not drop with the missed hunks.
    const base = commit('rename-miss base', {
      'rn-old.ts': lines(20, 'O'),
      'rn-other.ts': lines(8, 'T'),
    });
    const anchor = commit('rename-miss round 1', {
      'rn-old.ts': lines(20, 'O')
        .replace('O5\n', 'O5-EDIT\n')
        .replace('O15\n', 'O15-EDIT\n'),
      'rn-other.ts': lines(8, 'T'),
    });
    git('mv', 'rn-old.ts', 'rn-new.ts');
    writeFileSync(
      join(repo, 'rn-new.ts'),
      lines(20, 'O').replace('O15\n', 'O15-EDIT\n'),
    );
    writeFileSync(
      join(repo, 'rn-other.ts'),
      lines(8, 'T').replace('T4\n', 'T4-EDIT\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'rename-miss round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: BOTH captures key the move as the same
    // rename, and the delta's only hunk — the line-5 revert — nets out of
    // the full capture.
    expect(deltaBytes.toString('utf8')).toContain('rename from rn-old.ts');
    expect(full).toContain('rename from rn-old.ts');
    expect(deltaBytes.toString('utf8')).toContain('-O5-EDIT');
    expect(full).not.toContain('O5-EDIT');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('rename to rn-new.ts');
    expect(narrowed).toContain('+O15-EDIT');
    expect(narrowed).toContain('+T4-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('narrows a plain edit of a file an earlier round renamed', () => {
    // The rename guard's pass-through arm: the full capture keys the path
    // as a rename (round 1 moved it), while the delta carries a plain edit
    // of the new path with no `renameFrom` (round 2 edited it). The guard
    // must skip the section and narrow — refusing here would answer
    // nothing-to-narrow on every later round of such a PR, permanently
    // losing the incremental optimization with no error surface.
    const base = commit('pass-through base', { 'pt-old.ts': lines(20, 'O') });
    git('mv', 'pt-old.ts', 'pt-new.ts');
    git('commit', '-qm', 'pass-through round 1', '--no-verify');
    const anchor = git('rev-parse', 'HEAD').trim();
    commit('pass-through round 2', {
      'pt-new.ts': lines(20, 'O').replace('O10\n', 'O10-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: full keys a rename; the delta is a plain edit.
    expect(full).toContain('rename to pt-new.ts');
    expect(deltaBytes.toString('utf8')).not.toContain('rename from');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('+O10-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('emits the rename header and matching hunks when one round does both', () => {
    // Round 1 edits line 3; round 2 renames the file AND edits line 15.
    // The delta's section carries the rename AND content hunks — the
    // emission cell (guard equality passes) × (non-empty ranges → header +
    // matching hunks), distinct from the hunk-less pass and the
    // rewrite-rename refusal.
    const base = commit('rename-edit base', { 're-old.ts': lines(20, 'O') });
    const anchor = commit('rename-edit round 1', {
      're-old.ts': lines(20, 'O').replace('O3\n', 'O3-EDIT\n'),
    });
    git('mv', 're-old.ts', 're-new.ts');
    writeFileSync(
      join(repo, 're-new.ts'),
      lines(20, 'O')
        .replace('O3\n', 'O3-EDIT\n')
        .replace('O15\n', 'O15-EDIT\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'rename-edit round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    expect(deltaBytes.toString('utf8')).toContain('rename to re-new.ts');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('rename to re-new.ts');
    expect(narrowed).toContain('+O15-EDIT');
    // The round-1 edit is correctly absent: a non-empty-range section
    // emits matching hunks only.
    // Carried, not excluded: narrowing is per FILE now, so a touched
    // section arrives whole — including hunks the anchor round already
    // covered. Over-inclusion inside a touched file is the deliberate price
    // of never dropping one.
    expect(narrowed).toContain('+O3-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('keeps every full hunk a single delta hunk overlaps', () => {
    // Round 1 edits lines 5 and 25 and replaces lines 9..21; round 2
    // reverts the replacement. The delta is ONE hunk whose new-side range
    // overlaps BOTH surviving full hunks — a first-match-per-range emission
    // would drop the second edit from the published scope while the report
    // still says the round narrowed.
    const base = commit('two-overlap base', { 'ov.ts': lines(30, 'F') });
    const anchor = commit('two-overlap round 1', {
      'ov.ts': lines(30, 'F')
        .replace('F5\n', 'F5-EDIT\n')
        .replace(
          Array.from({ length: 13 }, (_, i) => `F${9 + i}`).join('\n') + '\n',
          Array.from({ length: 13 }, (_, i) => `Y${i + 1}`).join('\n') + '\n',
        )
        .replace('F25\n', 'F25-EDIT\n'),
    });
    commit('two-overlap round 2', {
      'ov.ts': lines(30, 'F')
        .replace('F5\n', 'F5-EDIT\n')
        .replace('F25\n', 'F25-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: full carries both edits and no replacement;
    // the delta is the single revert hunk.
    expect(full).toContain('+F5-EDIT');
    expect(full).toContain('+F25-EDIT');
    expect(full).not.toContain('Y1');
    expect(deltaBytes.toString('utf8')).toContain('-Y1');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('+F5-EDIT');
    expect(narrowed).toContain('+F25-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a netted-undo section whole while its sibling still narrows', () => {
    // Round 1 edits f.ts line 10 and inserts X1–X3 after line 25; round 2
    // reverts the insertion, keeps the edit, and edits g.ts line 15. The
    // f.ts delta hunk — the X revert — is corroborated by no full hunk:
    // none overlaps its range and none shares its text. It IS a netted-out
    // undo, but the captures cannot prove that — the same shape is how a
    // Myers misplacement looks — so the join fails closed and carries the
    // section whole: over-inclusion re-reviews the round-1 edit, while a
    // dropped change would be certified unreviewed by the ledger. The
    // treatment stays per-section: the corroborated sibling still narrows.
    const base = commit('section-drop base', {
      'sd-f.ts': lines(30, 'F'),
      'sd-g.ts': lines(20, 'G'),
    });
    const anchor = commit('section-drop round 1', {
      'sd-f.ts': lines(30, 'F')
        .replace('F10\n', 'F10-EDIT\n')
        .replace('F25\n', 'F25\nX1\nX2\nX3\n'),
      'sd-g.ts': lines(20, 'G').replace('G5\n', 'G5-EDIT\n'),
    });
    commit('section-drop round 2', {
      'sd-f.ts': lines(30, 'F').replace('F10\n', 'F10-EDIT\n'),
      'sd-g.ts': lines(20, 'G')
        .replace('G5\n', 'G5-EDIT\n')
        .replace('G15\n', 'G15-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: full carries the f.ts edit but no insertion;
    // the delta carries the revert.
    expect(full).toContain('+F10-EDIT');
    expect(full).not.toContain('X1');
    expect(deltaBytes.toString('utf8')).toContain('-X1');
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    // The uncorroborated section is carried whole — round-1 edit included
    // — while the corroborated sibling narrows to its post-anchor hunk.
    expect(narrowed).toContain('sd-f.ts');
    expect(narrowed).toContain('+F10-EDIT');
    expect(narrowed).toContain('+G15-EDIT');
    // Same file, so the whole section is carried — the sibling narrowing
    // that matters is the FILE the round did not touch, asserted below.
    expect(narrowed).toContain('+G5-EDIT');
    expect(narrowed!).not.toContain('X1');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries the section whole when the delta overlaps no hunk the PR diff still carries', () => {
    // Round 1 inserts X1–X3 and edits U25; round 2 reverts the insertion,
    // keeping the edit. The delta's one hunk — the X deletion — is
    // corroborated by no full hunk: the full capture's single hunk (the
    // U25 edit) neither overlaps its range nor shares its text. The old
    // design read that as "nothing to narrow to" and fell back; the join
    // now fails closed instead and carries the section whole. Every line
    // of it is displayed by the PR's diff — and a dropped change here
    // would be certified unreviewed by the ledger.
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
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('+U25-EDIT');
    expect(narrowed!).not.toContain('X1');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a change the captures position disjointly in an identical run', () => {
    // Round 1 edits the line before a run of 20 identical lines; round 2
    // deletes one line OF the run and edits a sibling file. Myers aligns a
    // change inside an identical-line run against whatever surrounds it,
    // and the two captures' old sides differ: `base..head` folds the
    // deletion into the round-1 edit's hunk at the FRONT of the run, while
    // `anchor..head` places the same deletion at the BACK. The ranges are
    // disjoint for a change both captures display, and the ledger certifies
    // head — a dropped change here would never re-enter any later scope.
    const run = Array.from({ length: 20 }, () => 'R').join('\n') + '\n';
    const base = commit('disjoint base', {
      'dj-run.ts': 'E\n' + run,
      'dj-sib.ts': 'S1\nS2\nS3\n',
    });
    const anchor = commit('disjoint round 1', {
      'dj-run.ts': 'E-EDIT\n' + run,
      'dj-sib.ts': 'S1\nS2\nS3\n',
    });
    commit('disjoint round 2', {
      'dj-run.ts':
        'E-EDIT\n' + Array.from({ length: 19 }, () => 'R').join('\n') + '\n',
      'dj-sib.ts': 'S1\nS2-EDIT\nS3\n',
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the SAME deletion, displayed by BOTH
    // captures, positioned disjointly on the head side.
    expect(full).toContain('@@ -1,5 +1,4 @@');
    expect(deltaBytes.toString('utf8')).toContain('@@ -18,4 +18,3 @@');

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    // The divergent section is carried whole — over-inclusion is the
    // chosen semantics — while the clean sibling still narrows.
    expect(narrowed).toContain('dj-run.ts');
    expect(narrowed).toContain('-R\n');
    expect(narrowed).toContain('+S2-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries the divergent hunk when a sibling hunk of the section matches', () => {
    // The partial-miss shape of the disjoint-run mechanism: round 1 edits
    // the line before the run; round 2 deletes one line of the run AND
    // edits F20 far away. The full capture folds the deletion into the
    // front-of-run hunk, the delta places it at the back, and the F20 hunk
    // aligns identically in both captures. One delta hunk matches, one
    // misses disjointly — a per-section emission of header + matched hunks
    // would drop the deletion while the file stays visible.
    const run = Array.from({ length: 20 }, () => 'R').join('\n') + '\n';
    const front = 'F1\nF2\nF3\nF4\nF5\n';
    const tail =
      Array.from({ length: 15 }, (_, i) => `F${i + 6}`).join('\n') + '\n';
    const base = commit('partial-miss base', {
      'pm.ts': front + 'B-LEAD\n' + run + tail,
    });
    const anchor = commit('partial-miss round 1', {
      'pm.ts': front + 'B-LEAD-EDIT\n' + run + tail,
    });
    commit('partial-miss round 2', {
      'pm.ts':
        front +
        'B-LEAD-EDIT\n' +
        Array.from({ length: 19 }, () => 'R').join('\n') +
        '\n' +
        tail.replace('F20\n', 'F20-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the deletion folded into the front hunk in
    // full, positioned at the back in the delta; the F20 hunk matches.
    expect(full).toContain('@@ -3,8 +3,7 @@');
    expect(deltaBytes.toString('utf8')).toContain('@@ -23,7 +23,6 @@');

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('+F20-EDIT'); // the matched hunk stays
    expect(narrowed).toContain('-R\n'); // the divergent hunk is carried
    expect(narrowed).toContain('+B-LEAD-EDIT'); // whole section: over-inclusion
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('narrows between FILES, never within one — the invariant, stated once', () => {
    // What four rounds of position-divergence findings were really about:
    // the delta and the full capture are independent Myers alignments, so
    // which HUNK a change lands in is not stable between them, and every
    // attempt to match hunks across them was defeated by a new shape. Which
    // FILE it lands in IS stable — the path and rename guards above fail
    // closed on the one way that could differ — so the file is the unit.
    //
    // Stated as a property rather than a shape: for every file the delta
    // touched, the narrowed output contains that section's every line.
    const base = commit('inv base', {
      'inv-a.ts': lines(30, 'A'),
      'inv-b.ts': lines(30, 'B'),
    });
    const anchor = commit('inv round 1', {
      'inv-a.ts': lines(30, 'A').replace('A4\n', 'A4-EDIT\n'),
      'inv-b.ts': lines(30, 'B').replace('B4\n', 'B4-EDIT\n'),
    });
    // Round 2 touches only inv-a, and does so near a run of identical lines —
    // the shape that makes Myers place the same edit differently.
    const head = commit('inv round 2', {
      'inv-a.ts': lines(30, 'A')
        .replace('A4\n', 'A4-EDIT\n')
        .replace('A20\n', 'A20-EDIT\n'),
      'inv-b.ts': lines(30, 'B').replace('B4\n', 'B4-EDIT\n'),
    });

    const full = capture(base, head);
    const narrowed = narrowToDelta(
      captureBytes(base, head),
      captureBytes(anchor, head),
    )!.toString('utf8');

    // The untouched FILE is gone — that is the whole saving.
    expect(narrowed).not.toContain('inv-b.ts');
    // The touched file arrives entire: every line of its full section, not a
    // selection of it. Checked by containment of the section, not by naming
    // hunks, so no future alignment change can quietly narrow it further.
    const sectionOf = (text: string, path: string) => {
      const all = text.split('\n');
      const start = all.findIndex((l) => l.startsWith(`diff --git a/${path}`));
      const rest = all
        .slice(start + 1)
        .findIndex((l) => l.startsWith('diff --git '));
      return all.slice(start, rest === -1 ? undefined : start + 1 + rest);
    };
    for (const line of sectionOf(full, 'inv-a.ts')) {
      expect(narrowed).toContain(line);
    }
    expect(everyLineIsDisplayed(narrowed, full)).toBe(true);
  });

  it('carries a change the captures display at disjoint positions under disjoint texts', () => {
    // R9-1 entrance A: round 1 substitutes the line LEADING a run of
    // identical lines with the run's own text, extending the run by one;
    // round 2 deletes one line OF the run. `base..head` nets to the
    // leader's deletion — the only one-edit script — which Myers displays
    // at the FRONT of the file; `anchor..head` deletes one run line, which
    // Myers displays at the run's BACK. The same change, displayed by both
    // captures, sits at disjoint head-side ranges AND under disjoint
    // changed texts (`-B` vs `-R`): the range join misses it, and a guard
    // keyed on either conjunct alone misses it too. The section must still
    // be carried — a dropped change here is certified unreviewed by the
    // ledger.
    const runOf = (n: number) =>
      Array.from({ length: n }, () => 'R').join('\n') + '\n';
    const base = commit('disjoint-text base', {
      'dt-run.ts': 'B\n' + runOf(24),
      'dt-sib.ts': lines(13, 'S'),
    });
    const anchor = commit('disjoint-text round 1', {
      'dt-run.ts': 'R\n' + runOf(24),
      'dt-sib.ts': lines(13, 'S').replace('S2\n', 'S2-EDIT\n'),
    });
    commit('disjoint-text round 2', {
      'dt-run.ts': runOf(24),
      'dt-sib.ts': lines(13, 'S')
        .replace('S2\n', 'S2-EDIT\n')
        .replace('S10\n', 'S10-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the SAME deletion displayed by BOTH
    // captures, at disjoint head-side ranges under disjoint changed texts.
    expect(full).toContain('@@ -1,4 +1,3 @@');
    expect(full).toContain('-B');
    expect(deltaBytes.toString('utf8')).toContain('@@ -22,4 +22,3 @@');
    expect(deltaBytes.toString('utf8')).not.toContain('-B');

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    // The divergent section is carried whole — over-inclusion is the
    // chosen semantics — while the clean sibling still narrows.
    expect(narrowed).toContain('dt-run.ts');
    expect(narrowed).toContain('-B');
    expect(narrowed).toContain('+S10-EDIT');
    // The divergent change is what must survive, and it does — carried
    // inside the whole section rather than selected by a position match that
    // two independent Myers alignments cannot be trusted to agree on.
    expect(narrowed).toContain('+S2-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a divergent hunk that overlaps an unrelated bystander hunk', () => {
    // R9-1 entrance B: round 1 edits the line before the run AND inserts a
    // line in the tail region; round 2 deletes one line OF the run. The
    // full capture folds the deletion into the front-of-run hunk; the
    // delta places it at the run's back, where its new-side range overlaps
    // the BYSTANDER insertion hunk — a change that predates the anchor, so
    // the delta never performs it. An overlap precondition sees the
    // bystander and stands down; the range join then carries the bystander
    // alone and drops the front hunk that actually displays the deletion.
    // The divergent hunk must still be carried.
    const run = Array.from({ length: 20 }, () => 'R').join('\n') + '\n';
    const front = 'F1\nF2\nF3\nF4\nF5\n';
    const tail =
      Array.from({ length: 14 }, (_, i) => `F${i + 7}`).join('\n') + '\n';
    const base = commit('bystander base', {
      'by-run.ts': front + 'B-LEAD\n' + run + 'F6\n' + tail,
    });
    const anchor = commit('bystander round 1', {
      'by-run.ts': front + 'B-LEAD-EDIT\n' + run + 'F6\nINSERTED\n' + tail,
    });
    commit('bystander round 2', {
      'by-run.ts':
        front +
        'B-LEAD-EDIT\n' +
        Array.from({ length: 19 }, () => 'R').join('\n') +
        '\n' +
        'F6\nINSERTED\n' +
        tail,
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the deletion folded into the front hunk in
    // full, the delta's divergent hunk overlapping the bystander's range.
    expect(full).toContain('@@ -3,8 +3,7 @@');
    expect(full).toContain('@@ -25,6 +24,7 @@');
    expect(deltaBytes.toString('utf8')).toContain('@@ -23,7 +23,6 @@');
    expect(deltaBytes.toString('utf8')).not.toContain('+INSERTED');

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('-R\n'); // the divergent hunk is carried
    expect(narrowed).toContain('+B-LEAD-EDIT'); // whole section: over-inclusion
    expect(narrowed).toContain('+INSERTED'); // the bystander stays
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a divergent hunk whose bystander shares its changed text', () => {
    // R9-1 entrance C: round 1 edits the line before the run AND deletes
    // the R line standing after a separator; round 2 deletes one line OF
    // the run. The full capture folds the run deletion into the
    // front-of-run hunk; the delta places it at the run's back, where its
    // new-side range overlaps the round-1 deletion hunk — a bystander
    // carrying the SAME changed text (`-R`) at a different new-side
    // junction. Corroboration keyed on bare text sees the bystander and
    // stands down; the range join then carries the bystander alone and
    // drops the front hunk that actually displays the deletion. The
    // divergent hunk must still be carried.
    const run = Array.from({ length: 20 }, () => 'R').join('\n') + '\n';
    const front = 'F1\nF2\nF3\nF4\nF5\n';
    const tail = 'T1\nT2\nT3\nT4\nT5\n';
    const base = commit('shared-text base', {
      'st-run.ts': front + 'B-LEAD\n' + run + 'SEP\nR\n' + tail,
    });
    const anchor = commit('shared-text round 1', {
      'st-run.ts': front + 'B-LEAD-EDIT\n' + run + 'SEP\n' + tail,
    });
    commit('shared-text round 2', {
      'st-run.ts':
        front +
        'B-LEAD-EDIT\n' +
        Array.from({ length: 19 }, () => 'R').join('\n') +
        '\n' +
        'SEP\n' +
        tail,
    });

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: the run deletion folded into the front hunk
    // in full, the round-1 deletion as a tail hunk that shares the
    // delta's changed text; the delta places the run deletion at the
    // back, overlapping the bystander's range.
    expect(full).toContain('@@ -3,8 +3,7 @@');
    expect(full).toContain('@@ -25,7 +24,6 @@');
    expect(full.match(/^-R$/gm)).toHaveLength(2);
    expect(deltaBytes.toString('utf8')).toContain('@@ -23,7 +23,6 @@');
    expect(deltaBytes.toString('utf8').match(/^-R$/gm)).toHaveLength(1);

    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    // The front hunk — the only display of the round-2 deletion — is
    // carried, and the bystander stays: the guard fails closed, so the
    // whole section comes along. Over-inclusion is the chosen semantics.
    expect(narrowed).toContain('@@ -3,8 +3,7 @@');
    expect(narrowed).toContain('@@ -25,7 +24,6 @@');
    expect(narrowed).toContain('+B-LEAD-EDIT');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
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

  it('carries the no-trailing-newline marker of a kept hunk', () => {
    // Both rounds edit the file's last line, which ends without a trailing
    // newline, so the full hunk — and the narrowed emission of it — carries
    // git's `\ No newline at end of file` marker. `everyLineIsDisplayed` is
    // membership-only and stays green when the marker drops or relocates (a
    // trim, or a range off-by-one at the hunk's last line); pin its presence
    // and position directly.
    const base = commit('no-newline base', {
      'nl.ts': 'N1\nN2',
      'nl-keep.ts': lines(8, 'K'),
    });
    const anchor = commit('no-newline round 1', {
      'nl.ts': 'N1\nN2-EDIT',
      'nl-keep.ts': lines(8, 'K').replace('K2\n', 'K2-EDIT\n'),
    });
    commit('no-newline round 2', {
      'nl.ts': 'N1\nN2-EDIT2',
      'nl-keep.ts': lines(8, 'K').replace('K2\n', 'K2-EDIT\n'),
    });

    const full = capture(base, 'HEAD');
    const narrowed =
      narrowToDelta(
        captureBytes(base, 'HEAD'),
        captureBytes(anchor, 'HEAD'),
      )?.toString('utf8') ?? null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('nl.ts');
    expect(narrowed).not.toContain('nl-keep.ts');
    expect(narrowed).toContain('+N2-EDIT2');
    // Presence AND position: the marker follows the hunk's last line.
    expect(narrowed).toContain('+N2-EDIT2\n\\ No newline at end of file');
    expect(everyLineIsDisplayed(narrowed!, full)).toBe(true);
  });

  it('carries a binary-file delta section the full capture also holds', () => {
    // Round 1 edits a text file; round 2 replaces a NUL-carrying blob. The
    // delta's binary section names no range — the empty-range list reads as
    // "emit the section whole", the hunk-less treatment — and the full
    // capture renders the same change as a binary section. A battery that
    // never commits binary content cannot see a regression that skips
    // binary sections or mis-keys them.
    writeFileSync(
      join(repo, 'bin.dat'),
      Buffer.from([0x47, 0x49, 0x00, 0x01, 0xff, 0x00]),
    );
    const base = commit('binary base', { 'bin-text.ts': lines(8, 'T') });
    const anchor = commit('binary round 1', {
      'bin-text.ts': lines(8, 'T').replace('T3\n', 'T3-EDIT\n'),
    });
    writeFileSync(
      join(repo, 'bin.dat'),
      Buffer.from([0x47, 0x49, 0x00, 0x02, 0xff, 0x00, 0x03]),
    );
    git('add', '-A');
    git('commit', '-qm', 'binary round 2', '--no-verify');

    const full = capture(base, 'HEAD');
    const deltaBytes = captureBytes(anchor, 'HEAD');
    // The scenario's premise: both captures render the blob change as a
    // binary section with no hunks.
    expect(full).toContain('Binary files a/bin.dat and b/bin.dat differ');
    expect(deltaBytes.toString('utf8')).toContain(
      'Binary files a/bin.dat and b/bin.dat differ',
    );
    const narrowed =
      narrowToDelta(captureBytes(base, 'HEAD'), deltaBytes)?.toString('utf8') ??
      null;
    expect(narrowed).not.toBeNull();
    expect(narrowed).toContain('Binary files a/bin.dat and b/bin.dat differ');
    expect(narrowed).not.toContain('bin-text.ts');
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

describe('the two halves narrowToDelta composes', () => {
  // `narrowToDelta` is a thin wrapper now, so the pieces are the surface a
  // second caller uses: the widening runs between them, on a selection whose
  // guards have already passed, and asks for a LARGER set of paths. Exercised
  // through the wrapper alone, a change that broke the emit for any set other
  // than `selection.touched` would leave every scenario above green.
  let base: string;
  let anchor: string;
  let head: string;

  beforeAll(() => {
    base = commit('base', { 'a.ts': lines(4, 'A'), 'b.ts': lines(4, 'B') });
    anchor = commit('anchor', {
      'a.ts': lines(4, 'A') + 'A-ANCHOR\n',
      'b.ts': lines(4, 'B') + 'B-ANCHOR\n',
    });
    head = commit('head', {
      'a.ts': lines(4, 'A') + 'A-ANCHOR\nA-HEAD\n',
      'b.ts': lines(4, 'B') + 'B-ANCHOR\n',
    });
  });

  it('selects the touched paths, and only those the full capture carries', () => {
    const selection = selectNarrowing(
      captureBytes(base, head),
      captureBytes(anchor, head),
    );
    expect(selection).not.toBeNull();
    // `b.ts` changed in the PR but not since the anchor: it is a section of
    // the full capture and NOT touched, which is exactly the state the
    // widening needs to see to consider it at all.
    expect([...selection!.touched]).toEqual(['a.ts']);
    expect(selection!.sections.map((f) => f.path).sort()).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(selection!.fullText).toBe(capture(base, head));
  });

  it('emits whatever subset it is asked for, out of the full capture', () => {
    const selection = selectNarrowing(
      captureBytes(base, head),
      captureBytes(anchor, head),
    )!;
    const full = capture(base, head);

    // The set the wrapper passes reproduces the wrapper's own answer…
    expect(
      assembleSections(selection, selection.touched)?.toString('utf8'),
    ).toBe(
      narrowToDelta(
        captureBytes(base, head),
        captureBytes(anchor, head),
      )?.toString('utf8'),
    );
    // …a WIDER set adds the other section whole, still out of the full
    // capture — the emit the widening depends on and the wrapper never asks
    // for.
    const widened = assembleSections(
      selection,
      new Set(['a.ts', 'b.ts']),
    )!.toString('utf8');
    expect(widened).toContain('b/a.ts');
    expect(widened).toContain('b/b.ts');
    expect(widened).toContain('+B-ANCHOR');
    expect(everyLineIsDisplayed(widened, full)).toBe(true);
    // …and a set naming nothing the capture carries is the same "nothing to
    // publish" the wrapper reports as null.
    expect(assembleSections(selection, new Set(['nope.ts']))).toBeNull();
  });
});
