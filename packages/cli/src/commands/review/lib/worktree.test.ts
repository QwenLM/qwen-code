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
import { dirname, join } from 'node:path';
import { isolateHostGitConfig } from './test-utils.js';
import {
  discardWorktree,
  exposeDependencies,
  worktreeCreateFailureDetail,
  worktreeResidue,
} from './worktree.js';

describe('worktreeResidue', () => {
  let repo: string;
  // The tree under measurement is a LINKED worktree — the production shape:
  // fetch-pr creates the review worktree with `git worktree add`, so its
  // `.git` is a gitfile. The identity gate fails closed for anything else (a
  // planted repository, a main checkout), so a bare repo fixture could not
  // measure the healthy path.
  let tree: string;
  // Ambient host git config makes the fixture commit throw — a global
  // `commit.gpgsign` with no usable key, a `core.hooksPath` that prompts — and
  // the suite then fails for reasons the branch never touched (the incident
  // `isolateHostGitConfig` was written for). Every sibling real-git suite
  // isolates; these do too.
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

  const gitRepo = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: tree, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-residue-'));
    gitRepo('init', '-q', '-b', 'main');
    gitRepo('config', 'user.email', 't@t.t');
    gitRepo('config', 'user.name', 't');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    gitRepo('add', '-A');
    gitRepo('commit', '-qm', 'head');
    tree = join(repo, '.qwen', 'tmp', 'review-wt');
    mkdirSync(dirname(tree), { recursive: true });
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('is empty for the tree a review actually reads', () => {
    expect(worktreeResidue(tree)).toEqual({ paths: [], total: 0 });
  });

  it('names a modified file and an untracked probe — the live #9207 shape', () => {
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');
    const got = worktreeResidue(tree);
    expect(got.paths.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(got.total).toBe(2);
  });

  it('ignores what every review leaves behind', () => {
    // Agent 7 installs and builds in this tree. If that read as residue, every
    // reader of every review would be told to distrust its own worktree — the
    // warning that fires always is the warning nobody reads.
    mkdirSync(join(tree, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(tree, 'dist'), { recursive: true });
    writeFileSync(join(tree, 'dist', 'out.js'), 'built\n');
    expect(worktreeResidue(tree)).toEqual({ paths: [], total: 0 });
  });

  it('reports BOTH names of a rename — the restore needs the one that is gone', () => {
    // The destination is what sits in the tree; the original is what is missing
    // from it, and `git checkout HEAD -- <dest>` cannot restore a name the
    // report never yielded. Reporting only the destination left the reader with
    // a staged `D <orig>` it had never been told about.
    git('mv', 'a.ts', 'b.ts');
    expect(worktreeResidue(tree).paths.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('reports STAGED residue, which is the shape a probe leaves with `git add`', () => {
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(tree, 'staged-new.ts'), 'x\n');
    git('add', 'a.ts', 'staged-new.ts');
    expect(worktreeResidue(tree).paths.sort()).toEqual([
      'a.ts',
      'staged-new.ts',
    ]);
  });

  it('hands back names that survive being turned into commands', () => {
    // The paths become `git show HEAD:<path>` and `git checkout HEAD -- <path>`
    // for an agent to run, and porcelain's RENDERED form quotes a non-ASCII
    // name (`"caf\303\251.ts"`), which resolves to nothing on disk.
    writeFileSync(join(tree, 'café.ts'), 'x\n');
    const got = worktreeResidue(tree).paths;
    expect(got).toEqual(['café.ts']);
    // The real test of "usable": the name still resolves on disk.
    for (const p of got) expect(existsSync(join(tree, p))).toBe(true);
  });

  // `>` is in NTFS's reserved set, so the fixture cannot be created on Windows
  // — and the shape it pins (a filename containing porcelain's rename
  // separator) cannot exist there either, so skipping loses no coverage.
  it.skipIf(process.platform === 'win32')(
    'does not mistake a filename containing ` -> ` for a rename record',
    () => {
      writeFileSync(join(tree, 'a -> b.ts'), 'x\n');
      const got = worktreeResidue(tree).paths;
      expect(got).toEqual(['a -> b.ts']);
      expect(existsSync(join(tree, got[0]))).toBe(true);
    },
  );

  it('lists the files inside a new directory, not the directory', () => {
    // The contamination shape this exists to catch — an agent dropping probe
    // files into a folder of its own. `--untracked-files=normal` collapses it
    // to `probe_dir/`, and every recovery this pipeline prints
    // (`git show HEAD:`, `git checkout HEAD --`) fails on a directory.
    mkdirSync(join(tree, 'probe_dir'));
    writeFileSync(join(tree, 'probe_dir', 'probe.test.ts'), 'x\n');
    expect(worktreeResidue(tree).paths).toEqual(['probe_dir/probe.test.ts']);
  });

  it('caps the list but never hides that it capped it', () => {
    // Both renderers present `paths` as the dirty set. A silent truncation is a
    // verifier restoring the twelve it was shown and leaving the thirteenth in
    // the tree the next round reads.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(tree, `f${i}.ts`), 'x\n');
    }
    expect(worktreeResidue(tree).total).toBe(20);
    expect(worktreeResidue(tree).paths).toHaveLength(12);
    expect(worktreeResidue(tree, 3).paths).toHaveLength(3);
    expect(worktreeResidue(tree, 3).total).toBe(20);
  });

  it('says UNMEASURED, not clean, when git cannot answer', () => {
    // A diagnostic that throws fails the build it is only commenting on — but
    // one that returns "clean" for a check that never ran is worse: the
    // overload case (a status too big for the buffer) is the one where the tree
    // is dirtiest, and both renderers used to read the empty list as pristine.
    const gone = worktreeResidue(join(tree, 'no-such-dir'));
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
    expect(worktreeResidue(tree).unmeasured).toBeUndefined();
  });

  it('says UNMEASURED, not clean, when a repository is planted at the path', () => {
    // The concealment: `rm .git && git init && git add -A && git commit` over
    // the contamination answers a clean `git status` for a dirty tree, and no
    // local check can tell a planted repo from the tree it replaced — both
    // sides of every comparison resolve inside the plant. A genuine worktree
    // carries its `.git` as a gitFILE, so anything else fails closed.
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');
    rmSync(join(tree, '.git'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tree });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: tree });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tree });
    execFileSync('git', ['add', '-A'], { cwd: tree });
    execFileSync('git', ['commit', '-qm', 'conceal'], { cwd: tree });

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('not a gitfile');
    expect(existsSync(join(tree, '__probe__.test.ts'))).toBe(true);
  });

  it('says UNMEASURED for writes inside a committed submodule path', () => {
    // `git status` never looks inside a gitlink and untracked content there
    // does not dirty the superproject — the raw oracle the probe trusts is
    // blind there, so a non-empty gitlink directory is unmeasured, never clean.
    const sub = join(repo, 'sub-origin');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: sub });
    writeFileSync(join(sub, 's.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: sub });
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor',
      ],
      { cwd: tree },
    );
    git('commit', '-qm', 'add submodule');

    writeFileSync(join(tree, 'vendor', 'probe-cache.txt'), 'cache\n');

    const got = worktreeResidue(tree);
    expect(got.unmeasured).toContain('vendor');
    expect(got.unmeasured).toContain('cannot see inside');
  });

  it('still measures clean when the submodule is uninitialized', () => {
    // `worktree add` leaves submodules uninitialized — here not even a
    // directory at the gitlink — which is the healthy shape for a review
    // tree; it hides nothing, so a repo with submodules must not measure
    // unmeasured forever.
    const sub = join(repo, 'sub-origin');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: sub });
    writeFileSync(join(sub, 's.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: sub });
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor',
      ],
      { cwd: tree },
    );
    git('commit', '-qm', 'add submodule');
    const fresh = join(repo, 'nested', 'wt-sub');
    gitRepo('worktree', 'add', '--detach', '-q', fresh, 'HEAD');

    const got = worktreeResidue(fresh);
    expect(got.unmeasured).toBeUndefined();
    expect(got).toEqual({ paths: [], total: 0 });
  });

  it('says UNMEASURED for a NON-ASCII gitlink path, which quotepath renders unresolvable', () => {
    // The blind set is parsed from `ls-files` output: under default
    // `core.quotepath` git quotes a non-ASCII path into an octal-escape
    // spelling that never resolves on disk, so a rendered parse drops the
    // gitlink from the blind set and certifies a contaminated gitlink clean.
    const sub = join(repo, 'sub-origin-utf');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: sub });
    writeFileSync(join(sub, 's.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: sub });
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'café-mod',
      ],
      { cwd: tree },
    );
    git('commit', '-qm', 'add submodule');

    writeFileSync(join(tree, 'café-mod', 'probe-cache.txt'), 'cache\n');

    const got = worktreeResidue(tree);
    expect(got.unmeasured).toContain('café-mod');
    expect(got.unmeasured).toContain('cannot see inside');
  });

  it('fails closed for a degraded dir nested in a checkout — discovery walks up', () => {
    // The production shape the tmpdir fixture above cannot pin: review
    // worktrees sit INSIDE the user's checkout, so a directory whose `.git`
    // is gone does not fail `git status` — discovery walks up and exits 0
    // against the user's tree, answering with the user's own dirt.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    const degraded = join(repo, 'nested', 'degraded');
    mkdirSync(degraded, { recursive: true });

    const got = worktreeResidue(degraded);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('not a git worktree');

    // And a healthy NESTED worktree still measures — the guard must not read
    // the production shape itself as degraded.
    const nested = join(repo, 'nested', 'wt');
    git('worktree', 'add', '--detach', '-q', nested, 'HEAD');
    writeFileSync(join(nested, '__probe__.test.ts'), 'x');
    const healthy = worktreeResidue(nested);
    expect(healthy.unmeasured).toBeUndefined();
    expect(healthy.paths).toEqual(['__probe__.test.ts']);
  });

  it('excludes the pipeline’s install even when the COMMIT does not ignore it', () => {
    // The exclusion is the pipeline's invariant, not the commit's: a PR whose
    // `.gitignore` does not cover `node_modules` used to turn the review's
    // own install into residue, and every verifier's first act then pointed
    // at deleting the very tree its farm borrows from. Real residue beside
    // the install stays named.
    writeFileSync(join(tree, '.gitignore'), 'dist\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'loosen');
    mkdirSync(join(tree, 'node_modules', 'pkg-0'), { recursive: true });
    writeFileSync(join(tree, 'node_modules', 'pkg-0', 'index.js'), '1\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'x');

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual(['__probe__.test.ts']);
    expect(got.total).toBe(1);
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

  it('wipes a DANGLING symlink at the target instead of failing EEXIST forever', () => {
    // A PR can commit `node_modules` as a dangling symlink — force-add
    // defeats gitignore — and `checkout --force` / `clean -ffdx` both spare
    // the TRACKED link, so every reset recreates the shape. `existsSync`
    // read it as absent, skipped the wipe, and `mkdirSync` threw EEXIST on
    // every attempt: a permanently broken harness for every shard.
    const root = tmp('expose-dangling-root-');
    const probe = tmp('expose-dangling-probe-');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    symlinkSync(join(root, 'nowhere'), join(probe, 'node_modules'));

    const got = exposeDependencies(probe, root, { rebuild: true });

    expect(got).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(lstatSync(join(probe, 'node_modules')).isDirectory()).toBe(true);
    expect(existsSync(join(probe, 'node_modules', 'plain-pkg'))).toBe(true);
  });

  it('rebuild removes node_modules the farm does not recreate — planted or linked', () => {
    // Node resolves an INTERMEDIATE `packages/node_modules` before the root
    // farm, and a reused tree sees only this call between runs — so whatever
    // a previous run left at such a path decides every later verdict unless
    // the rebuild reaches it. A LINK named node_modules is the same hole one
    // redirection deeper.
    const root = tmp('expose-sweep-root-');
    const probe = tmp('expose-sweep-probe-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'node_modules', 'real-dep'), { recursive: true });
    mkdirSync(join(root, 'packages', 'cli', 'node_modules', 'nested'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@x/cli' }),
    );
    mkdirSync(join(probe, 'packages', 'cli'), { recursive: true });

    expect(exposeDependencies(probe, root, { rebuild: true })).toMatchObject({
      linked: 2,
    });

    mkdirSync(join(probe, 'packages', 'node_modules', 'shim'), {
      recursive: true,
    });
    mkdirSync(join(probe, 'tools', 'node_modules', 'stub'), {
      recursive: true,
    });
    mkdirSync(join(probe, 'linked'), { recursive: true });
    symlinkSync(
      join(root, 'node_modules'),
      join(probe, 'linked', 'node_modules'),
    );

    expect(exposeDependencies(probe, root, { rebuild: true })).toMatchObject({
      linked: 2,
    });

    expect(existsSync(join(probe, 'packages', 'node_modules'))).toBe(false);
    expect(existsSync(join(probe, 'tools', 'node_modules'))).toBe(false);
    expect(existsSync(join(probe, 'linked', 'node_modules'))).toBe(false);
    // The farm-owned paths were re-linked, not swept...
    expect(existsSync(join(probe, 'node_modules', 'real-dep'))).toBe(true);
    expect(
      existsSync(join(probe, 'packages', 'cli', 'node_modules', 'nested')),
    ).toBe(true);
    // ...and the link's target was never touched.
    expect(existsSync(join(root, 'node_modules', 'real-dep'))).toBe(true);
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

  it('unlinks a symlink at the tree path instead of deleting what it points at', () => {
    // `git worktree remove` resolves a symlink standing at the path and
    // force-removes whichever registered worktree it points at — a victim this
    // path never owned. The scratch-tree rebuild hands `discardWorktree` paths
    // its own gate admits can be symlinks; the unlink is the whole job for one.
    const victim = join(repo, 'victim');
    git(repo, 'worktree', 'add', '--detach', '-q', victim, 'HEAD');
    writeFileSync(join(victim, 'keep.txt'), 'must survive\n');
    const planted = join(repo, 'planted');
    symlinkSync(victim, planted, 'dir');

    discardWorktree(repo, planted);

    expect(existsSync(planted)).toBe(false);
    // The victim is still registered AND still on disk.
    expect(git(repo, 'worktree', 'list')).toContain('victim');
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
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
