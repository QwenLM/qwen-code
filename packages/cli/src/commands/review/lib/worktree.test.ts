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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHostGitConfig } from './test-utils.js';
import {
  discardWorktree,
  exposeDependencies,
  worktreeCreateFailureDetail,
  worktreeResidue,
} from './worktree.js';

describe('worktreeResidue', () => {
  let repo: string;
  // Ambient host git config makes the fixture commit throw — a global
  // `commit.gpgsign` with no usable key, a `core.hooksPath` that prompts — and
  // the suite then fails for reasons the branch never touched (the incident
  // `isolateHostGitConfig` was written for). Every sibling real-git suite
  // isolates; these do too.
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-residue-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'head');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

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

  it('reports BOTH names of a rename — the restore needs the one that is gone', () => {
    // The destination is what sits in the tree; the original is what is missing
    // from it, and `git checkout HEAD -- <dest>` cannot restore a name the
    // report never yielded. Reporting only the destination left the reader with
    // a staged `D <orig>` it had never been told about.
    git('mv', 'a.ts', 'b.ts');
    expect(worktreeResidue(repo).paths.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('reports STAGED residue, which is the shape a probe leaves with `git add`', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(repo, 'staged-new.ts'), 'x\n');
    git('add', 'a.ts', 'staged-new.ts');
    expect(worktreeResidue(repo).paths.sort()).toEqual([
      'a.ts',
      'staged-new.ts',
    ]);
  });

  it('hands back names that survive being turned into commands', () => {
    // The paths become `git show HEAD:<path>` and `git checkout HEAD -- <path>`
    // for an agent to run, and porcelain's RENDERED form quotes a non-ASCII
    // name (`"caf\\303\\251.ts"`), which resolves to nothing on disk.
    writeFileSync(join(repo, 'café.ts'), 'x\n');
    const got = worktreeResidue(repo).paths;
    expect(got).toEqual(['café.ts']);
    // The real test of "usable": the name still resolves on disk.
    for (const p of got) expect(existsSync(join(repo, p))).toBe(true);
  });

  // `>` is in NTFS's reserved set, so the fixture cannot be created on Windows
  // — and the shape it pins (a filename containing porcelain's rename
  // separator) cannot exist there either, so skipping loses no coverage.
  it.skipIf(process.platform === 'win32')(
    'does not mistake a filename containing ` -> ` for a rename record',
    () => {
      writeFileSync(join(repo, 'a -> b.ts'), 'x\n');
      const got = worktreeResidue(repo).paths;
      expect(got).toEqual(['a -> b.ts']);
      expect(existsSync(join(repo, got[0]))).toBe(true);
    },
  );

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

  it('says UNMEASURED, not clean, when git cannot answer', () => {
    // A diagnostic that throws fails the build it is only commenting on — but
    // one that returns "clean" for a check that never ran is worse: the
    // overload case (a status too big for the buffer) is the one where the tree
    // is dirtiest, and both renderers used to read the empty list as pristine.
    const gone = worktreeResidue(join(repo, 'no-such-dir'));
    expect(gone.paths).toEqual([]);
    expect(gone.unmeasured).toBeTruthy();
    const notARepo = mkdtempSync(join(tmpdir(), 'qwen-not-a-repo-'));
    try {
      expect(worktreeResidue(notARepo).unmeasured).toBeTruthy();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
    // A clean tree carries no reason — that is what makes the two states
    // distinguishable at the renderers.
    expect(worktreeResidue(repo).unmeasured).toBeUndefined();
  });
});

describe('exposeDependencies', () => {
  // Every fixture here mkdtemps; without this they accumulated in $TMPDIR on
  // every local and CI run, unlike the block above which cleans up.
  const made: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('links top-level and scoped packages, counting what it linked', () => {
    const root = tmp('expose-root-');
    const probe = tmp('expose-probe-');
    const nm = join(root, 'node_modules');
    mkdirSync(join(nm, 'plain-pkg'), { recursive: true });
    mkdirSync(join(nm, '@scope', 'inner-pkg'), { recursive: true });
    // A non-directory entry is skipped — neither linked nor counted as a failure.
    writeFileSync(join(nm, 'stray-file'), 'x');

    const got = exposeDependencies(probe, root);

    expect(got).toEqual({
      linked: 2,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(
      readdirSync(join(probe, 'node_modules'))
        .filter((e) => !e.startsWith('.'))
        .sort(),
    ).toEqual(['@scope', 'plain-pkg']);
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
    const root = tmp('expose-ws-root-');
    const probe = tmp('expose-ws-probe-');
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

    expect(got).toEqual({
      linked: 2,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(probe, 'node_modules', 'hoisted'))).toBe(true);
    expect(
      existsSync(join(probe, 'packages', 'cli', 'node_modules', 'nested')),
    ).toBe(true);
    // A member the tree does not contain gets nothing — creating its directory
    // would put a path in the tree that its commit does not have.
    expect(existsSync(join(probe, 'packages', 'absent'))).toBe(false);
  });

  it('leaves a farm THIS code built untouched, and rebuilds one it did not', () => {
    // The marker is the difference between "the packages I linked last time"
    // and "whatever a probe left in the one directory it is allowed to install
    // into". `alreadyPresent` off bare existence certified a planted module
    // stub as the dependency farm for every later probe in that tree.
    const root = tmp('expose-root-');
    const probe = tmp('expose-probe-');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });

    expect(exposeDependencies(probe, root)).toMatchObject({
      linked: 1,
      alreadyPresent: false,
    });
    // Second call over the farm it just built: reused, nothing re-linked.
    expect(exposeDependencies(probe, root)).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: true,
      selfLinked: 0,
    });

    // Now the planted shape: a `node_modules` this code did not build.
    const planted = tmp('expose-planted-');
    mkdirSync(join(planted, 'node_modules', 'planted-stub'), {
      recursive: true,
    });
    expect(exposeDependencies(planted, root)).toMatchObject({
      linked: 1,
      alreadyPresent: false,
    });
    expect(existsSync(join(planted, 'node_modules', 'planted-stub'))).toBe(
      false,
    );
    expect(existsSync(join(planted, 'node_modules', 'plain-pkg'))).toBe(true);
  });

  it('refuses a workspace member that escapes the tree', () => {
    // The member list comes from the ROOT MANIFEST OF THE CODE UNDER REVIEW,
    // and this loop deletes at the paths it names: `workspaces: [".."]`
    // resolved to a directory outside both trees — the same one for source and
    // target, since a scratch tree is a sibling — and the farm's opening wipe
    // took that directory's `node_modules`.
    const outer = tmp('expose-escape-');
    const root = join(outer, 'repo');
    const probe = join(outer, 'probe');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    mkdirSync(join(probe, 'node_modules'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['..'] }),
    );
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'x' }));
    mkdirSync(join(outer, 'node_modules', 'victim'), { recursive: true });

    const got = exposeDependencies(probe, root);

    expect(existsSync(join(outer, 'node_modules', 'victim'))).toBe(true);
    expect(got.failed).toBeGreaterThan(0);
  });

  it('refuses a workspace member that is a symlink out of the tree', () => {
    // A committed symlink at a member path is fully contained as a STRING, and
    // `readWorkspacePackages` follows it deliberately because npm does — so the
    // wipe lands at the link's target unless the containment check resolves.
    const outer = tmp('expose-symlink-');
    const root = join(outer, 'repo');
    const probe = join(outer, 'probe');
    const victim = join(outer, 'victim');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    mkdirSync(join(probe, 'packages'), { recursive: true });
    mkdirSync(join(root, 'packages'), { recursive: true });
    mkdirSync(join(victim, 'node_modules', 'real-dep'), { recursive: true });
    writeFileSync(join(victim, 'package.json'), JSON.stringify({ name: 'v' }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    symlinkSync(victim, join(root, 'packages', 'evil'), 'dir');
    symlinkSync(victim, join(probe, 'packages', 'evil'), 'dir');

    exposeDependencies(probe, root);

    expect(existsSync(join(victim, 'node_modules', 'real-dep'))).toBe(true);
  });

  it('never farms a tree into itself', () => {
    // The one guard between `exposeDependencies(x, x)` and deleting x's own
    // `node_modules` — both production callers pass distinct paths today, and
    // nothing pinned that they must.
    const root = tmp('expose-self-');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    expect(exposeDependencies(root, root)).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(root, 'node_modules', 'plain-pkg'))).toBe(true);
  });

  it('rebuilds a marked farm when the caller asks it to', () => {
    // The reuse path of a scratch tree cannot know what ran in that tree, so it
    // distrusts even a farm this code built — root AND per-member.
    const root = tmp('expose-rebuild-root-');
    const probe = tmp('expose-rebuild-probe-');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'cli', 'node_modules', 'nested'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@x/cli' }),
    );
    mkdirSync(join(probe, 'packages', 'cli'), { recursive: true });

    expect(exposeDependencies(probe, root)).toMatchObject({ linked: 2 });
    writeFileSync(
      join(probe, 'packages', 'cli', 'node_modules', 'planted.js'),
      'x',
    );

    expect(exposeDependencies(probe, root, { rebuild: true })).toMatchObject({
      linked: 2,
      alreadyPresent: false,
    });
    expect(
      existsSync(join(probe, 'packages', 'cli', 'node_modules', 'planted.js')),
    ).toBe(false);
  });

  it('skips a stray file under a scope directory, as it does at top level', () => {
    const root = tmp('expose-scope-stray-');
    const probe = tmp('expose-scope-probe-');
    mkdirSync(join(root, 'node_modules', '@scope', 'real-pkg'), {
      recursive: true,
    });
    writeFileSync(join(root, 'node_modules', '@scope', 'notes.md'), 'x');

    const got = exposeDependencies(probe, root);

    expect(got).toMatchObject({ linked: 1, failed: 0 });
    expect(existsSync(join(probe, 'node_modules', '@scope', 'real-pkg'))).toBe(
      true,
    );
    expect(existsSync(join(probe, 'node_modules', '@scope', 'notes.md'))).toBe(
      false,
    );
  });

  it('does not call an EMPTY farm dir a standing farm', () => {
    // The dir a previous call created when the source held nothing linkable —
    // gitignored, so a scratch tree's reset spares it. Counting it as
    // "already in place" flips the note from "no harness will start here" to
    // "harness ready" with nothing having changed in between.
    const root = tmp('expose-empty-root-');
    const probe = tmp('expose-empty-probe-');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    mkdirSync(join(probe, 'node_modules'), { recursive: true });

    expect(exposeDependencies(probe, root)).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
  });
});

describe('discardWorktree', () => {
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-discard-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('clears a LOCKED leftover instead of wedging the path forever', () => {
    // `worktree remove --force` refuses a locked entry and `prune` skips it, so
    // without the unlock every later `add` at that path fatals "missing but
    // locked" — for every disposable tree of that review, until a human
    // intervenes. Probe code has a shell in these trees, so the lock is one
    // `touch` away.
    const tree = join(repo, 'wt');
    git(repo, 'worktree', 'add', '--detach', '-q', tree, 'HEAD');
    git(repo, 'worktree', 'lock', tree);

    discardWorktree(repo, tree);

    // The path is free: a fresh add succeeds where it used to fatal.
    git(repo, 'worktree', 'add', '--detach', '-q', tree, 'HEAD');
    expect(existsSync(join(tree, 'a.ts'))).toBe(true);
  });

  it('drops only its OWN registration, never a sibling worktree', () => {
    // The prune this replaced was repo-wide: it deregistered any entry whose
    // directory was momentarily absent — another shard's `worktree add`
    // mid-flight, or the user's worktree on an unmounted volume.
    const mine = join(repo, 'mine');
    const other = join(repo, 'other');
    git(repo, 'worktree', 'add', '--detach', '-q', mine, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '-q', other, 'HEAD');
    // The sibling's directory is gone — exactly what a repo-wide prune eats.
    rmSync(other, { recursive: true, force: true });

    discardWorktree(repo, mine);

    expect(git(repo, 'worktree', 'list')).toContain(other);
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
