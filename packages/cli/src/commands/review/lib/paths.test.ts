/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { basename, dirname, join, resolve } from 'node:path';
import {
  inertPath,
  tmpFile,
  probeWorktreePath,
  scratchLabel,
  scratchWorktreePath,
  scratchWorktreePrefix,
  worktreePath,
  PARSE_ARGS_REPORT,
} from './paths.js';

describe('PARSE_ARGS_REPORT', () => {
  it('is the literal path the skill tees to in Step 0', () => {
    // The skill's Step 0 hard-codes `.qwen/tmp/qwen-review-parse-args.json` in
    // its tee command. If this constant drifts from that literal the fallback
    // silently stops reading the report and the original bug returns.
    expect(PARSE_ARGS_REPORT).toBe(
      join('.qwen', 'tmp', 'qwen-review-parse-args.json'),
    );
  });
});

describe('tmpFile — target is a single safe component', () => {
  it('keeps ordinary labels intact', () => {
    expect(tmpFile('pr-6771', 'diff.txt')).toContain(
      'qwen-review-pr-6771-diff.txt',
    );
    expect(tmpFile('local', 'plan.json')).toContain(
      'qwen-review-local-plan.json',
    );
  });

  it('flattens a file-path target so its parent is not a missing directory', () => {
    // `src/foo.ts` used to make `.qwen/tmp/qwen-review-src/foo.ts-diff.txt`, whose
    // `src/` parent nobody created — ENOENT.
    const p = tmpFile('src/foo.ts', 'diff.txt');
    expect(p).not.toContain('src/foo.ts');
    expect(dirname(p)).toBe(join('.qwen', 'tmp'));
    // The separator is flattened to an underscore, so the target survives as a
    // single component directly under the temp dir.
    expect(basename(p)).toBe('qwen-review-src_foo.ts-diff.txt');
  });

  it('refuses to escape the temp dir with a crafted target', () => {
    const p = tmpFile('../../evil', 'diff.txt');
    expect(dirname(p)).toBe(join('.qwen', 'tmp'));
    expect(p).not.toContain('..');
    // The dot-segment traversal is stripped to a plain component, not nested.
    expect(basename(p)).toBe('qwen-review-evil-diff.txt');
  });
});

describe('probeWorktreePath', () => {
  it('appends -probe to an absolute worktree path', () => {
    const worktree = resolve('/a/b/review-pr-1');
    expect(probeWorktreePath(worktree)).toBe(`${worktree}-probe`);
  });

  it('resolves a relative worktree to absolute so it never depends on cwd', () => {
    // The probe drives `git worktree add` with the shared worktree as cwd, so a
    // relative probe path would resolve against that worktree and nest the probe
    // tree inside it. Absolute keeps it a sibling wherever it is called from.
    expect(probeWorktreePath('.qwen/tmp/review-pr-1')).toBe(
      `${resolve('.qwen/tmp/review-pr-1')}-probe`,
    );
  });

  it('is the single source of the -probe suffix both call sites share', () => {
    // cleanup.ts sweeps `probeWorktreePath(worktreePath(n))`; the probe creates
    // `probeWorktreePath(worktree)`. One helper, one suffix — they cannot drift.
    expect(probeWorktreePath(worktreePath(7))).toBe(
      `${resolve(worktreePath(7))}-probe`,
    );
  });
});

describe('scratchWorktreePath', () => {
  const worktree = resolve('/a/b/review-pr-1');

  it('names the tree after the agent that owns it', () => {
    // The label is what keeps concurrent verifier shards apart; a scratch tree
    // they share is the race the whole mechanism exists to remove.
    expect(scratchWorktreePath(worktree, 'verify--round-2--abc')).toBe(
      `${worktree}-scratch-verify--round-2--abc`,
    );
    expect(scratchWorktreePath(worktree, 'verify--round-2--abc')).not.toBe(
      scratchWorktreePath(worktree, 'verify--round-2--def'),
    );
  });

  it('resolves a relative worktree so the tree is a SIBLING, not a child', () => {
    // `git worktree add` runs with the review worktree as cwd. A relative path
    // would land the scratch tree inside the one tree it must never touch.
    expect(scratchWorktreePath('.qwen/tmp/review-pr-1', 'verify')).toBe(
      `${resolve('.qwen/tmp/review-pr-1')}-scratch-verify`,
    );
  });

  it('flattens a crafted label instead of following it out of the temp dir', () => {
    // The label reaches this over a CLI flag, and the path it builds is both
    // created by `git worktree add` and later DELETED by cleanup's sweep.
    const p = scratchWorktreePath(worktree, '../../../etc/passwd');
    expect(p).not.toContain('..');
    expect(dirname(p)).toBe(dirname(worktree));
    expect(p.startsWith(`${worktree}-scratch-`)).toBe(true);
  });

  it('caps a long label — the suffix rides on an already-deep path', () => {
    const p = scratchWorktreePath(worktree, 'v'.repeat(400));
    expect(basename(p).length).toBeLessThanOrEqual(
      'review-pr-1-scratch-'.length + 64,
    );
  });

  it('refuses a label that keeps no path-safe character', () => {
    // `???` and `!!!` are two different labels that flatten to nothing. A
    // fallback would name both trees after the prefix itself — one tree for
    // every shard whose label was unusable, and a path cleanup's prefix sweep
    // matches as a whole family.
    expect(() => scratchWorktreePath(worktree, '???')).toThrow(TypeError);
    expect(scratchLabel('???')).toBe('');
  });
});

describe('scratchWorktreePrefix', () => {
  it('is the exact infix cleanup sweeps on, not merely a prefix of the path', () => {
    // Asserting only `path.startsWith(prefix)` is a tautology — the path is
    // BUILT from the prefix — and it holds just as well for a broader prefix,
    // which is the dangerous direction: `cleanup` feeds this to a
    // `startsWith` filter over the temp dir and deletes every match, so a
    // prefix of `…/review-pr-7` alone would delete PR 70's live worktrees.
    expect(scratchWorktreePrefix(worktreePath(7))).toBe(
      `${resolve(worktreePath(7))}-scratch-`,
    );
    expect(
      scratchWorktreePath(worktreePath(70), 'x').startsWith(
        scratchWorktreePrefix(worktreePath(7)),
      ),
    ).toBe(false);
  });
});

describe('inertPath', () => {
  // The only sanitizer between a git-reported (PR- or agent-controlled) path
  // and three sinks that render it: a brief the agent treats as its whole
  // instructions, the roster's separator lines, and the orchestrator's
  // terminal. The character class IS the safety property.
  it('flattens everything that could act rather than name', () => {
    expect(inertPath('a\nb.ts')).toBe('a b.ts');
    expect(inertPath('a\u001b[31mb.ts')).toBe('a [31mb.ts');
    expect(inertPath('a`b.ts')).toBe('a b.ts');
    // The roster separator glyph — a filename must not be able to forge a
    // block boundary in the text an orchestrator pastes to an agent.
    expect(inertPath('a\u2500b.ts')).toBe('a b.ts');
    // Invisible formatting: a bidi override reverses the rendering of
    // everything after it, and a zero-width joiner hides characters inside a
    // path a reader is being asked to judge.
    expect(inertPath('a\u202eb.ts')).toBe('a b.ts');
    expect(inertPath('a\u200bb.ts')).toBe('a b.ts');
    expect(inertPath('a\ufeffb.ts')).toBe('a b.ts');
    // Line and paragraph separators open a new Markdown line like a newline.
    expect(inertPath('a\u2028b.ts')).toBe('a b.ts');
  });

  it('leaves an ordinary path exactly as it is', () => {
    // A sanitizer that mangles the common case makes every rendered path
    // unusable as the command argument the reader is told to run.
    expect(inertPath('packages/cli/src/a-b_c.test.ts')).toBe(
      'packages/cli/src/a-b_c.test.ts',
    );
    expect(inertPath('caf\u00e9.ts')).toBe('caf\u00e9.ts');
    expect(inertPath('my probe.ts')).toBe('my probe.ts');
  });
});
