/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { tmpFile, probeWorktreePath, worktreePath } from './paths.js';

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
    expect(p).toContain('.qwen/tmp/');
    // No path separator after the temp dir.
    expect(p.split('.qwen/tmp/')[1]).not.toContain('/');
  });

  it('refuses to escape the temp dir with a crafted target', () => {
    const p = tmpFile('../../evil', 'diff.txt');
    expect(p).toContain('.qwen/tmp/');
    expect(p).not.toContain('..');
    expect(p.split('.qwen/tmp/')[1]).not.toContain('/');
  });
});

describe('probeWorktreePath', () => {
  it('appends -probe to an absolute worktree path', () => {
    expect(probeWorktreePath('/a/b/review-pr-1')).toBe(
      '/a/b/review-pr-1-probe',
    );
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
