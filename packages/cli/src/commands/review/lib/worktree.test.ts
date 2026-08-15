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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exposeDependencies,
  worktreeCreateFailureDetail,
  worktreeResidue,
} from './worktree.js';

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
    expect(worktreeResidue(repo)).toEqual({ paths: [], total: 0 });
  });

  it('names a modified file and an untracked probe — the live #9207 shape', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(repo, '__probe__.test.ts'), 'it("x", () => {});');
    const got = worktreeResidue(repo);
    expect(got.paths.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(got.total).toBe(2);
  });

  it('ignores what every review leaves behind', () => {
    // Agent 7 installs and builds in this tree. If that read as residue, every
    // reader of every review would be told to distrust its own worktree — the
    // warning that fires always is the warning nobody reads.
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'out.js'), 'built\n');
    expect(worktreeResidue(repo)).toEqual({ paths: [], total: 0 });
  });

  it('reports the NEW path of a rename, not the arrow line', () => {
    git('mv', 'a.ts', 'b.ts');
    expect(worktreeResidue(repo).paths).toEqual(['b.ts']);
  });

  it('hands back names that survive being turned into commands', () => {
    // The paths become `git show HEAD:<path>` and `git checkout HEAD -- <path>`
    // for an agent to run. Porcelain's RENDERED form quotes a path with a space
    // or a non-ASCII byte and writes a rename as `orig -> new`, so a file named
    // `a -> b.ts` used to parse to `b.ts"` — a name matching nothing on disk.
    writeFileSync(join(repo, 'a -> b.ts'), 'x\n');
    writeFileSync(join(repo, 'café.ts'), 'x\n');
    const got = worktreeResidue(repo).paths.sort();
    expect(got).toEqual(['a -> b.ts', 'café.ts']);
    // The real test of "usable": every name still resolves on disk.
    for (const p of got) expect(existsSync(join(repo, p))).toBe(true);
  });

  it('lists the files inside a new directory, not the directory', () => {
    // The contamination shape this exists to catch — an agent dropping probe
    // files into a folder of its own. `--untracked-files=normal` collapses it
    // to `probe_dir/`, and every recovery this pipeline prints
    // (`git show HEAD:`, `git checkout HEAD --`) fails on a directory.
    mkdirSync(join(repo, 'probe_dir'));
    writeFileSync(join(repo, 'probe_dir', 'probe.test.ts'), 'x\n');
    expect(worktreeResidue(repo).paths).toEqual(['probe_dir/probe.test.ts']);
  });

  it('caps the list but never hides that it capped it', () => {
    // Both renderers present `paths` as the dirty set. A silent truncation is a
    // verifier restoring the twelve it was shown and leaving the thirteenth in
    // the tree the next round reads.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repo, `f${i}.ts`), 'x\n');
    }
    expect(worktreeResidue(repo).total).toBe(20);
    expect(worktreeResidue(repo).paths).toHaveLength(12);
    expect(worktreeResidue(repo, 3).paths).toHaveLength(3);
    expect(worktreeResidue(repo, 3).total).toBe(20);
  });

  it('says "clean" rather than throwing when git cannot answer', () => {
    // A diagnostic that throws fails the build it is only commenting on.
    expect(worktreeResidue(join(repo, 'no-such-dir'))).toEqual({
      paths: [],
      total: 0,
    });
    const notARepo = mkdtempSync(join(tmpdir(), 'qwen-not-a-repo-'));
    try {
      expect(worktreeResidue(notARepo)).toEqual({ paths: [], total: 0 });
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('exposeDependencies', () => {
  it('links top-level and scoped packages, counting what it linked', () => {
    const root = mkdtempSync(join(tmpdir(), 'expose-root-'));
    const probe = mkdtempSync(join(tmpdir(), 'expose-probe-'));
    const nm = join(root, 'node_modules');
    mkdirSync(join(nm, 'plain-pkg'), { recursive: true });
    mkdirSync(join(nm, '@scope', 'inner-pkg'), { recursive: true });
    // A non-directory entry is skipped — neither linked nor counted as a failure.
    writeFileSync(join(nm, 'stray-file'), 'x');

    const got = exposeDependencies(probe, root);

    expect(got).toEqual({ linked: 2, failed: 0, alreadyPresent: false });
    expect(readdirSync(join(probe, 'node_modules')).sort()).toEqual([
      '@scope',
      'plain-pkg',
    ]);
    expect(
      lstatSync(join(probe, 'node_modules', 'plain-pkg')).isSymbolicLink(),
    ).toBe(true);
    expect(
      lstatSync(
        join(probe, 'node_modules', '@scope', 'inner-pkg'),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  it('farms a workspace member’s own node_modules, which npm could not hoist', () => {
    // A version conflict leaves a package installed under the MEMBER, and Node
    // resolves it by walking up from the importing file — so a tree with only
    // the root farm fails to resolve exactly the package that could not be
    // hoisted. Measured on this repo: a scratch tree with 1 560 root packages
    // linked still could not resolve `@testing-library/react` for a UI probe.
    const root = mkdtempSync(join(tmpdir(), 'expose-ws-root-'));
    const probe = mkdtempSync(join(tmpdir(), 'expose-ws-probe-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'node_modules', 'hoisted'), { recursive: true });
    for (const member of ['cli', 'absent']) {
      mkdirSync(join(root, 'packages', member), { recursive: true });
      writeFileSync(
        join(root, 'packages', member, 'package.json'),
        JSON.stringify({ name: `@x/${member}` }),
      );
      mkdirSync(join(root, 'packages', member, 'node_modules', 'nested'), {
        recursive: true,
      });
    }
    // The probe tree holds one of the two members.
    mkdirSync(join(probe, 'packages', 'cli'), { recursive: true });

    const got = exposeDependencies(probe, root);

    expect(got).toEqual({ linked: 2, failed: 0, alreadyPresent: false });
    expect(existsSync(join(probe, 'node_modules', 'hoisted'))).toBe(true);
    expect(
      existsSync(join(probe, 'packages', 'cli', 'node_modules', 'nested')),
    ).toBe(true);
    // A member the tree does not contain gets nothing — creating its directory
    // would put a path in the tree that its commit does not have.
    expect(existsSync(join(probe, 'packages', 'absent'))).toBe(false);
  });

  it('leaves an already-built probe farm untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'expose-root-'));
    const probe = mkdtempSync(join(tmpdir(), 'expose-probe-'));
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    mkdirSync(join(probe, 'node_modules', 'standing-pkg'), { recursive: true });

    // `alreadyPresent` is the half `{0, 0}` alone cannot say: a farm that was
    // already standing and a source with nothing linkable read identically,
    // and the two want opposite things said to the verifier.
    expect(exposeDependencies(probe, root)).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: true,
    });
    expect(readdirSync(join(probe, 'node_modules'))).toEqual(['standing-pkg']);
  });

  it('does not call an EMPTY farm dir a standing farm', () => {
    // The dir a previous call created when the source held nothing linkable —
    // gitignored, so a scratch tree's reset spares it. Counting it as
    // "already in place" flips the note from "no harness will start here" to
    // "harness ready" with nothing having changed in between.
    const root = mkdtempSync(join(tmpdir(), 'expose-empty-root-'));
    const probe = mkdtempSync(join(tmpdir(), 'expose-empty-probe-'));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    mkdirSync(join(probe, 'node_modules'), { recursive: true });

    expect(exposeDependencies(probe, root)).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: false,
    });
  });
});

describe('worktreeCreateFailureDetail', () => {
  // The branch this string is built on fires only when `git worktree add` fails,
  // which no real-git test can force portably (the one lever — an unwritable
  // `.git/worktrees` — is bypassed by root and differs under CI's unprivileged
  // user). The composition is the part with logic in it, so it is pinned here.
  it('names the add failure, and folds in the sweep stderr that explains it', () => {
    const got = worktreeCreateFailureDetail(
      'probe',
      new Error("fatal: '/w/wt-probe' already exists"),
      "fatal: '/w/wt-probe' is not a working tree\n",
    );
    expect(got).toContain('probe worktree could not be created');
    expect(got).toContain("fatal: '/w/wt-probe' already exists");
    // The sweep is usually the explanation for the add failure — keep it.
    expect(got).toContain(
      "(stale-tree sweep also reported: fatal: '/w/wt-probe' is not a working tree)",
    );
  });

  it('omits the sweep clause when the sweep said nothing', () => {
    // The normal case: no stale tree, so the sweep is silent. A dangling empty
    // "(stale-tree sweep also reported: )" would be noise in the report.
    const got = worktreeCreateFailureDetail(
      'probe',
      new Error('disk full'),
      '   \n',
    );
    expect(got).toBe('probe worktree could not be created: disk full');
  });

  it('survives a non-Error throw', () => {
    expect(worktreeCreateFailureDetail('probe', 'boom', '')).toBe(
      'probe worktree could not be created: boom',
    );
  });
});
