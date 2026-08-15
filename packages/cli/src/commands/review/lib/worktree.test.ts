/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `worktreeResidue` against a real repo: what it must recognise is exactly what
// a live review put in front of an auditor — a modified source file and a probe
// test file that no commit contains (#9207) — and what it must stay quiet about
// is everything a normal review leaves behind, which is why the build outputs
// every review produces are gitignored.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeResidue } from './worktree.js';

describe('worktreeResidue', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qwen-residue-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'head');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('is empty for the tree a review actually reads', () => {
    expect(worktreeResidue(repo)).toEqual([]);
  });

  it('names a modified file and an untracked probe — the live #9207 shape', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(repo, '__probe__.test.ts'), 'it("x", () => {});');
    expect(worktreeResidue(repo).sort()).toEqual(['__probe__.test.ts', 'a.ts']);
  });

  it('ignores what every review leaves behind', () => {
    // Agent 7 installs and builds in this tree. If that read as residue, every
    // reader of every review would be told to distrust its own worktree — the
    // warning that fires always is the warning nobody reads.
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'out.js'), 'built\n');
    expect(worktreeResidue(repo)).toEqual([]);
  });

  it('reports the NEW path of a rename, not the arrow line', () => {
    git('mv', 'a.ts', 'b.ts');
    expect(worktreeResidue(repo)).toEqual(['b.ts']);
  });

  it('caps the list — it is rendered into a prompt, not a report', () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repo, `f${i}.ts`), 'x\n');
    }
    expect(worktreeResidue(repo)).toHaveLength(12);
    expect(worktreeResidue(repo, 3)).toHaveLength(3);
  });

  it('says "clean" rather than throwing when git cannot answer', () => {
    // A diagnostic that throws fails the build it is only commenting on.
    expect(worktreeResidue(join(repo, 'no-such-dir'))).toEqual([]);
    const notARepo = mkdtempSync(join(tmpdir(), 'qwen-not-a-repo-'));
    try {
      expect(worktreeResidue(notARepo)).toEqual([]);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
