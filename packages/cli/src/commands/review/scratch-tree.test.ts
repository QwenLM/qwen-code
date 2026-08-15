/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, for the same reason `base-tree`'s suite is: what
// breaks here is the worktree lifecycle — a detached add at the right SHA, a
// leftover from a crashed run, a reused tree that must come back PRISTINE — and
// none of that is exercised by mocking `spawnSync`.
//
// The invariant every test below is really about is the one the command exists
// for: after any of this, the shared review worktree is byte-for-byte what its
// commit says it is. A scratch tree that works but lets one write through is a
// scratch tree that has failed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScratchTree } from './scratch-tree.js';
import { scratchWorktreePath } from './lib/paths.js';

describe('runScratchTree', () => {
  let repo: string;
  let worktree: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const run = (label = 'verify--round-1--abc123') =>
    runScratchTree({ worktree, label });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qwen-scratch-tree-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('stands up a sibling tree at the commit under review', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    expect(r.path).toBe(
      scratchWorktreePath(worktree, 'verify--round-1--abc123'),
    );
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('places it BESIDE the review worktree, never inside it', () => {
    // Nested, every probe file would land in the tree this command exists to
    // keep clean — and in the PR's own diff with it.
    const r = run();
    expect(r.path!.startsWith(`${worktree}/`)).toBe(false);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
  });

  it('gives two labels two trees — one round runs its shards concurrently', () => {
    // A shared scratch tree would be the same race one level down: shard B
    // editing the file shard A is measuring.
    const a = run('verify--round-2--aaa');
    const b = run('verify--round-2--bbb');
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path!)).toBe(true);
    expect(existsSync(b.path!)).toBe(true);
  });

  it('refuses an empty label rather than defaulting to a shared tree', () => {
    const r = runScratchTree({ worktree, label: '  ' });
    expect(r.available).toBe(false);
    expect(r.note).toContain('--label is required');
  });

  it('cannot be steered out of the temp dir by a crafted label', () => {
    // The label arrives over a CLI flag. A traversal in it would aim both the
    // `git worktree add` and cleanup's later delete at another directory.
    const r = run('../../../../etc/passwd');
    expect(r.available).toBe(true);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
    expect(r.path).not.toContain('..');
  });

  it('hands back a PRISTINE tree on reuse — a stale mutant is a wrong verdict', () => {
    // The failure this closes: finding A's probe leaves a mutant behind, finding
    // B's probe runs against it, and the verdict carries a deterministic source
    // tag over contaminated code.
    const first = run();
    writeFileSync(join(first.path!, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(first.path!, '__probe__.test.ts'), 'it("x", () => {});');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(existsSync(join(second.path!, '__probe__.test.ts'))).toBe(false);
  });

  it('clears a leftover directory a crashed run left at the path', () => {
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'junk.txt'), 'from a run that died\n');

    const r = run();
    expect(r.available).toBe(true);
    expect(existsSync(join(tree, 'junk.txt'))).toBe(false);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  it('leaves the shared review worktree untouched by everything it does', () => {
    // The whole point, asserted directly.
    const r = run();
    writeFileSync(join(r.path!, 'a.ts'), 'export const x = 99;\n');
    writeFileSync(join(r.path!, 'probe.test.ts'), 'it("x", () => {});');

    expect(readFileSync(join(worktree, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('reports residue in the shared worktree — the tree others are reading', () => {
    // The cleanliness check: a verifier that wrote into the shared tree before
    // it had a scratch tree learns so at the moment it asks for one, instead of
    // a concurrent auditor discovering it as a phantom Critical.
    writeFileSync(join(worktree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');

    const r = run();
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(r.note).toContain('the shared review worktree is NOT clean');
    expect(r.note).toContain('__probe__.test.ts');
  });

  it('says nothing about residue when the shared worktree is clean', () => {
    const r = run();
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.note).not.toContain('NOT clean');
  });

  it('links the review worktree’s node_modules in, and says so', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules', '@scope', 'pkg'), {
      recursive: true,
    });

    const r = run();
    expect(r.dependencies).toEqual({ linked: 2, failed: 0 });
    expect(existsSync(join(r.path!, 'node_modules', 'vitest'))).toBe(true);
    expect(r.note).toContain('2 dependencies linked in');
  });

  it('says a harness will not start when there is nothing to link', () => {
    // Silence here would send the verifier hunting a mysterious
    // `vitest: not found` in a tree that was never the problem.
    const r = run();
    expect(r.dependencies).toBeNull();
    expect(r.note).toContain('no `node_modules`');
    expect(r.note).toContain('never in the review worktree');
  });

  it('is unavailable — not silently degraded — when there is no worktree', () => {
    const r = runScratchTree({
      worktree: join(repo, 'no', 'such', 'tree'),
      label: 'verify',
    });
    expect(r.available).toBe(false);
    expect(r.path).toBeUndefined();
    expect(r.note).toContain('does not exist');
  });
});
