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
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  localFilterRefusal,
  sanitizedGitEnv,
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
  const realPath = process.env['PATH'] ?? '';

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
    process.env['PATH'] = realPath;
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

  it('sees residue a committed whitelist .gitignore hides from status', () => {
    // The untracked view cannot come from `status` alone: `status` honors
    // ignore rules the contaminator controls, and a PR can commit a
    // whitelist-form `.gitignore` (`*` with `!`-negations) under which probe
    // residue stays invisible to it. The ignore-INDEPENDENT listing merged
    // into the answer is what keeps the tripwire sighted.
    writeFileSync(join(tree, '.gitignore'), '*\n!.gitignore\n!a.ts\n');
    git('add', '-f', '.gitignore');
    git('commit', '-qm', 'whitelist');
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');

    // The blindness this closes: `status` exits 0 with zero bytes.
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');

    const got = worktreeResidue(tree);
    expect(got.paths).toEqual(['__probe__.test.ts']);
    expect(got.total).toBe(1);
    expect(got.unmeasured).toBeUndefined();
  });

  it('keeps the pipeline’s OWN build output out of the ignore-independent view', () => {
    // Measured, not hypothesised: on a healthy review worktree of this repo,
    // after the `npm ci` and build the pipeline itself runs there, `git status`
    // reported NOTHING and the ignore-independent listing reported 3 957 paths
    // — coverage HTML, `.tsbuildinfo`, husky's installed hooks. Every one of
    // them reached every verifier as residue to `rm`, and real contamination
    // would have been three lines inside that. The rule that separates them is
    // WHO WROTE THE IGNORE RULE, not what it matches.
    writeFileSync(
      join(tree, '.gitignore'),
      'node_modules\ndist\ncoverage/\n*.tsbuildinfo\n',
    );
    git('add', '.gitignore');
    git('commit', '-qm', 'ordinary ignore rules');
    mkdirSync(join(tree, 'coverage', 'lcov-report'), { recursive: true });
    writeFileSync(
      join(tree, 'coverage', 'lcov-report', 'index.html'),
      '<html>',
    );
    writeFileSync(join(tree, 'tsconfig.tsbuildinfo'), '{}');
    // husky's `prepare` hook, which `npm ci` runs: an untracked directory
    // hidden by an untracked `.gitignore` of its own, so no rule the commit
    // carries covers it and only the pipeline-footprint list can.
    mkdirSync(join(tree, '.husky', '_'), { recursive: true });
    writeFileSync(join(tree, '.husky', '_', '.gitignore'), '*\n');
    writeFileSync(join(tree, '.husky', '_', 'pre-commit'), '#!/bin/sh\n');
    // ...and one real leftover standing in the middle of all of it.
    writeFileSync(join(tree, '__probe__.test.ts'), 'x');

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual(['__probe__.test.ts']);
    expect(got.total).toBe(1);
    expect(got.unmeasured).toBeUndefined();
  });

  it('does not let a wildcard-only rule vouch, however it is spelled', () => {
    // `?` matches any single character, so `?*` is `*` with extra steps — and
    // the first cut of the catch-all check recognised only the pure `*`/`**`
    // spellings. A rule that names nothing cannot vouch for what it hides, and
    // this shape needs no execution at all: it is committed content.
    writeFileSync(join(tree, '.gitignore'), '?*\n');
    git('add', '-f', '.gitignore');
    git('commit', '-qm', 'whitelist, spelled sideways');
    writeFileSync(join(tree, 'payload.log'), 'residue');

    // The blindness this closes: `status` exits 0 with zero bytes.
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');

    expect(worktreeResidue(tree).paths).toEqual(['payload.log']);
  });

  it('stops believing a committed ignore file once the TREE has edited it', () => {
    // Tracked is not unchanged. `ls-files` answers "is this path in the
    // index", so a `.gitignore` the commit carries goes on vouching for rules
    // appended to it after the checkout — the provenance test's own premise,
    // read one word too loosely.
    writeFileSync(join(tree, '.gitignore'), 'node_modules\ndist\ncoverage/\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'ordinary rules');
    appendFileSync(join(tree, '.gitignore'), 'payload.log\n');
    writeFileSync(join(tree, 'payload.log'), 'residue');

    const got = worktreeResidue(tree);

    // Both: the edited rule file, and what it was hiding.
    expect(got.paths.sort()).toEqual(['.gitignore', 'payload.log']);
  });

  it('sees residue hidden by an ignore rule the COMMIT does not carry', () => {
    // The other half of the same rule. A `.gitignore` written after the
    // checkout, and a line appended to the common repo's `info/exclude`, are
    // the two ways to hide a probe's leftovers from `status` without touching
    // the commit — so neither is allowed to vouch for what it hides.
    mkdirSync(join(tree, 'probe_dir'));
    writeFileSync(join(tree, 'probe_dir', '.gitignore'), '*\n');
    writeFileSync(join(tree, 'probe_dir', 'probe.test.ts'), 'x');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'sneaked/\n');
    mkdirSync(join(tree, 'sneaked'));
    writeFileSync(join(tree, 'sneaked', 'leftover.txt'), 'x');

    // The blindness this closes: `status` exits 0 with zero bytes.
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');

    const got = worktreeResidue(tree);

    expect(got.paths.sort()).toEqual([
      'probe_dir/.gitignore',
      'probe_dir/probe.test.ts',
      'sneaked/leftover.txt',
    ]);
    expect(got.unmeasured).toBeUndefined();
  });

  // A `git` shim needs a shell script, which Windows cannot execute as a bare
  // `git` on PATH; the behaviour it pins is platform-independent.
  it.skipIf(process.platform === 'win32')(
    'says UNMEASURED, not clean, when the index-bit oracle cannot run',
    () => {
      // The three oracles above return `unmeasured` when their git call fails;
      // this one used to fall THROUGH to the clean return, because its guard
      // asked for `status === 0` and read a failure as "no bits found". The
      // tree it then certified pristine is the one whose index bits it could
      // not read — precisely the tree that can be carrying a mutant `status`
      // is unable to see. Only `ls-files -v` is broken here: the shim proves
      // the earlier oracles still answered, so the verdict comes from this
      // call and not from a repo the test broke wholesale.
      const shim = mkdtempSync(join(tmpdir(), 'qwen-git-shim-'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shim, 'git'),
        `#!/bin/sh\nls=0; v=0\nfor a in "$@"; do\n  [ "$a" = ls-files ] && ls=1\n  [ "$a" = -v ] && v=1\ndone\n[ "$ls$v" = 11 ] && exit 128\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(tree, '__probe__.test.ts'), 'x');
      process.env['PATH'] = `${shim}:${realPath}`;

      const got = worktreeResidue(tree);

      expect(got.unmeasured).toContain('ls-files exited 128');
      // The paths measured before the failure are still handed over: an
      // unmeasured verdict withholds the certificate, not the evidence.
      expect(got.paths).toEqual(['__probe__.test.ts']);
      expect(got.total).toBe(1);
    },
  );
});

describe('worktreeResidue — the blind sets', () => {
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-blind-'));
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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports UNMEASURED for a gitlink it cannot read, not clean',
    () => {
      // The filter that decides "nothing to hide there" used to answer the same
      // way for an ABSENT directory (the shape `worktree add` leaves — genuinely
      // clean) and an unreadable one, which is a place neither `git status` nor
      // this probe can see.
      const wt = join(repo, 'wt');
      git(repo, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
      // A committed gitlink, made unreadable in the worktree.
      const sub = join(repo, 'sub-origin');
      mkdirSync(sub, { recursive: true });
      git(sub, 'init', '-q', '-b', 'main');
      git(sub, 'config', 'user.email', 't@t.t');
      git(sub, 'config', 'user.name', 't');
      writeFileSync(join(sub, 's.txt'), 'x\n');
      git(sub, 'add', '-A');
      git(sub, 'commit', '-qm', 'one');
      git(
        repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor',
      );
      git(repo, 'commit', '-qm', 'sub');
      git(wt, 'checkout', '--detach', '-q', git(repo, 'rev-parse', 'main'));
      mkdirSync(join(wt, 'vendor'), { recursive: true });
      chmodSync(join(wt, 'vendor'), 0o000);
      try {
        expect(worktreeResidue(wt).unmeasured).toBeTruthy();
      } finally {
        chmodSync(join(wt, 'vendor'), 0o755);
      }
    },
  );

  // Linux only, and not as a convenience: APFS and NTFS both REFUSE a filename
  // that is not valid UTF-8, so the fixture cannot be created there at all
  // (`mkdir` fails ENOENT on macOS) — and the shape it pins cannot exist on
  // those filesystems either, so skipping loses no coverage. The repo's
  // convention for a POSIX-only fixture is `skipIf`; this one is narrower than
  // POSIX.
  it.skipIf(process.platform !== 'linux')(
    'reports UNMEASURED for a gitlink whose name carries invalid UTF-8 bytes',
    () => {
      // `encoding: 'utf8'` renders an undecodable byte as U+FFFD, and no
      // spelling of such a name resolves on disk — so the directory cannot
      // be proved empty. Dropping the entry from the blind set certified a
      // contaminated gitlink clean.
      const wt = join(repo, 'wt');
      git(repo, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
      const sub = join(repo, 'sub-origin-bad');
      mkdirSync(sub, { recursive: true });
      git(sub, 'init', '-q', '-b', 'main');
      git(sub, 'config', 'user.email', 't@t.t');
      git(sub, 'config', 'user.name', 't');
      writeFileSync(join(sub, 's.txt'), 'x\n');
      git(sub, 'add', '-A');
      git(sub, 'commit', '-qm', 'one');
      const sha = git(sub, 'rev-parse', 'HEAD');
      // A raw 0xFF byte in the gitlink's name. Stdin carries it as a Buffer
      // because a JS string would re-encode it as VALID UTF-8 — `--cacheinfo`
      // cannot, its path arrives through argv.
      const rawName = Buffer.from('ev\xffil', 'latin1');
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: repo,
        input: Buffer.concat([
          Buffer.from(`160000 ${sha}\t`),
          rawName,
          Buffer.from('\n'),
        ]),
      });
      git(repo, 'commit', '-qm', 'gitlink');
      git(wt, 'checkout', '--detach', '-q', git(repo, 'rev-parse', 'main'));
      // Contamination inside the raw-byte directory. Buffer paths, because
      // the name does not survive a round-trip through JS strings.
      const rawDir = Buffer.concat([Buffer.from(`${wt}/`), rawName]);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(
        Buffer.concat([rawDir, Buffer.from('/probe-cache.txt')]),
        'cache\n',
      );

      expect(worktreeResidue(wt).unmeasured).toBeTruthy();
    },
  );
});

describe('worktreeResidue — index bits', () => {
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-bits-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it.each(['--skip-worktree', '--assume-unchanged'])(
    'reports UNMEASURED when %s hides a tracked edit',
    (bit) => {
      // `git status` answers clean for a file carrying either bit, however
      // edited it is — so a reader would be told the shared tree is pristine
      // while it carries a mutant. The scratch tree's reset already refuses to
      // certify around this; the reader-side oracle owes the same answer.
      const wt = join(repo, 'wt');
      git(repo, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
      git(wt, 'update-index', bit, 'a.ts');
      writeFileSync(join(wt, 'a.ts'), 'MUTANT\n');

      expect(git(wt, 'status', '--porcelain')).toBe(''); // the blindness
      expect(worktreeResidue(wt).unmeasured).toBeTruthy();
    },
  );
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

  it('COUNTS a node_modules link that resolves out of the tree', () => {
    // The in-tree half of this branch discloses and the outside half was a
    // silent `continue`, so `{linked: n, failed: 0}` was reported while a
    // committed `vendor -> ../stash` (mode 120000, no execution anywhere) kept
    // a `node_modules` alive under the target: Node realpaths the importing
    // file, so imports under the link resolve in the stash and decide every
    // later run. The state is outside the tree and cannot be wiped from here —
    // counting it is what the contract promises.
    const root = tmp('escape-root-');
    const probe = tmp('escape-probe-');
    const stash = tmp('escape-stash-');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    mkdirSync(join(stash, 'node_modules', 'evil'), { recursive: true });
    mkdirSync(join(probe, 'node_modules'), { recursive: true });
    writeFileSync(join(probe, 'node_modules', '.qwen-review-farm'), root);
    symlinkSync(stash, join(probe, 'vendor'));

    const got = exposeDependencies(probe, root, { rebuild: true });

    expect(got.failed).toBe(1);
    // ...and the link itself is untouched, because it is not this tree's.
    expect(lstatSync(join(probe, 'vendor')).isSymbolicLink()).toBe(true);
  });

  it('does not let `workspaces: ["."]` widen the self-link whitelist', () => {
    // npm accepts a root manifest declaring itself a workspace and creates the
    // self-link, so no planted symlink is needed: `containedIn(root, '.')`
    // answers the root, and the whole shared review worktree would enter the
    // whitelist — after which ANY node_modules link resolving anywhere inside
    // it is mirrored into the disposable tree as a read-write channel back.
    const root = tmp('selfws-root-');
    const probe = tmp('selfws-probe-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['.'] }),
    );
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(root, join(root, 'node_modules', 'r'));
    writeFileSync(join(root, 'secret.txt'), 'shared worktree content\n');

    const got = exposeDependencies(probe, root, { rebuild: true });

    // The self-link naming the ROOT is not mirrored as a member self-link.
    expect(got.selfLinked).toBe(0);
    expect(existsSync(join(probe, 'node_modules', 'r', 'secret.txt'))).toBe(
      false,
    );
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

  it('refuses node_modules symlink entries that escape the farm', () => {
    // Force-add defeats gitignore, so the commit controls which symlink
    // entries stand under `node_modules` — and a mirrored escape link is a
    // write channel from the disposable tree to wherever it points,
    // re-established on every rebuild. Only entries resolving inside a
    // borrowed `node_modules` (and npm's workspace self-links) may pass.
    const outer = tmp('expose-escape-entry-');
    const root = join(outer, 'repo');
    const probe = join(outer, 'probe');
    mkdirSync(probe, { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'tracked.ts'), 'x\n');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    symlinkSync(join(root, 'src'), join(root, 'node_modules', 'evil'), 'dir');
    symlinkSync(outer, join(root, 'node_modules', 'outside'), 'dir');

    const got = exposeDependencies(probe, root);

    expect(got).toEqual({
      linked: 1,
      failed: 2,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(probe, 'node_modules', 'plain-pkg'))).toBe(true);
    expect(existsSync(join(probe, 'node_modules', 'evil'))).toBe(false);
    expect(existsSync(join(probe, 'node_modules', 'outside'))).toBe(false);
  });

  it('refuses an escaping scope directory, whose entries resolve out of the farm', () => {
    // The scoped branch's hole is one level up: a scope DIRECTORY that is
    // itself an escape link. The containment check sees it at the top level
    // — the link's resolution is what is asked — and mirrors nothing of it.
    const outer = tmp('expose-escape-scope-');
    const root = join(outer, 'repo');
    const probe = join(outer, 'probe');
    mkdirSync(probe, { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'tracked.ts'), 'x\n');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    symlinkSync(join(root, 'src'), join(root, 'node_modules', '@evil'), 'dir');

    const got = exposeDependencies(probe, root);

    expect(got).toEqual({
      linked: 1,
      failed: 1,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(probe, 'node_modules', '@evil'))).toBe(false);
  });

  it('still mirrors npm workspace self-links, counting them as such', () => {
    // The containment gate must not close the shape the farm exists to
    // borrow: npm links every workspace member into the root `node_modules`,
    // and those links resolve outside it by construction.
    const root = tmp('expose-selflink-root-');
    const probe = tmp('expose-selflink-probe-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@x/core' }),
    );
    mkdirSync(join(root, 'node_modules', '@x'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'core'),
      join(root, 'node_modules', '@x', 'core'),
      'dir',
    );

    const got = exposeDependencies(probe, root);

    expect(got).toMatchObject({ linked: 1, failed: 0, selfLinked: 1 });
    expect(
      lstatSync(join(probe, 'node_modules', '@x', 'core')).isSymbolicLink(),
    ).toBe(true);
  });

  it('does not count a phantom failure when the tree path is spelled through a symlink', () => {
    // macOS's `/var` vs `/private/var` is the production shape; a symlinked
    // ancestor reproduces it on Linux. The disclosure loop presents
    // realpath'd spellings of what it finds, `owned` held only the caller's,
    // and the farm this call just re-linked counted a failure on every
    // rebuild.
    const outer = tmp('expose-spelling-');
    const root = join(outer, 'dep-root');
    mkdirSync(join(root, 'node_modules', 'plain-pkg'), { recursive: true });
    mkdirSync(join(outer, 'real-probe'), { recursive: true });
    symlinkSync(join(outer, 'real-probe'), join(outer, 'alias-probe'), 'dir');
    // A link resolving back into the tree: what reaches the disclosure loop.
    symlinkSync('.', join(outer, 'real-probe', 'selfie'), 'dir');

    const got = exposeDependencies(join(outer, 'alias-probe'), root, {
      rebuild: true,
    });

    expect(got).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
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

  it("clears its OWN entry by the tree's pointer, not by scanning gitdir files", () => {
    // The reverse scan reads `<id>/gitdir` files, which anything running as the
    // user can rewrite — so a sibling's entry can be made to name this path and
    // the cleanup would delete the SIBLING's registration. The tree's own
    // `.git` pointer is the trustworthy direction, and it is read before
    // anything is removed.
    const mine = join(repo, 'mine');
    const other = join(repo, 'other');
    git(repo, 'worktree', 'add', '--detach', '-q', mine, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '-q', other, 'HEAD');
    const common = git(
      repo,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    // Aim `other`'s entry at `mine`, the way tampering would.
    for (const id of readdirSync(join(common, 'worktrees'))) {
      const gitdirFile = join(common, 'worktrees', id, 'gitdir');
      if (readFileSync(gitdirFile, 'utf8').includes(`${other}/.git`)) {
        writeFileSync(gitdirFile, `${mine}/.git\n`);
      }
    }

    discardWorktree(repo, mine);

    // `mine` is gone and `other`'s registration survived the tampering.
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(common, 'worktrees'))).toBe(true);
    expect(readdirSync(join(common, 'worktrees')).length).toBe(1);
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

describe('sanitizedGitEnv', () => {
  it('drops config injection as well as discovery redirects', () => {
    // Dropping `GIT_DIR` and keeping `GIT_CONFIG_*` is a gate on the front door
    // with the window open: `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_0` sets any
    // key for the run, and `core.fsmonitor`/`filter.*` are command execution.
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = '/tmp/elsewhere/.git';
      process.env['GIT_CONFIG_COUNT'] = '1';
      process.env['GIT_CONFIG_KEY_0'] = 'core.fsmonitor';
      process.env['GIT_CONFIG_VALUE_0'] = 'touch /tmp/pwned';
      process.env['GIT_CONFIG_GLOBAL'] = '/tmp/evil-global';
      process.env['GIT_CONFIG_PARAMETERS'] = "'core.pager=cat'";
      process.env['PATH'] = saved['PATH'];

      const env = sanitizedGitEnv();

      for (const key of [
        'GIT_DIR',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_PARAMETERS',
      ]) {
        expect(env[key]).toBeUndefined();
      }
      // And it is still the caller's environment otherwise.
      expect(env['PATH']).toBe(saved['PATH']);
    } finally {
      process.env = saved;
    }
  });

  it('drops a case VARIANT too, and turns replacement objects off', () => {
    // Windows env lookup is case-insensitive, so `git_dir` reaches the child
    // exactly as `GIT_DIR` does while an exact-case delete on a plain object
    // removes neither — the model this list is copied from
    // (`config/shared-env-keys.ts`) folds case for this reason. And
    // `refs/replace` redirects OBJECT lookup: one `git replace <sha> <evil>`
    // in the common dir makes every `checkout --detach <sha>` here materialise
    // someone else's tree while `rev-parse <sha>` still answers the original.
    const saved = { ...process.env };
    try {
      process.env['git_dir'] = '/tmp/elsewhere/.git';
      process.env['Git_Config_Count'] = '1';
      process.env['git_config_key_0'] = 'core.fsmonitor';
      process.env['GIT_ssh_COMMAND'] = 'touch /tmp/pwned';

      const env = sanitizedGitEnv();

      for (const key of [
        'git_dir',
        'Git_Config_Count',
        'git_config_key_0',
        'GIT_ssh_COMMAND',
      ]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env['GIT_NO_REPLACE_OBJECTS']).toBe('1');
    } finally {
      process.env = saved;
    }
  });

  it('drops the variables git EXECUTES, which are the most direct route', () => {
    // Closing redirection and config injection and leaving these open is the
    // same window one wall over: `GIT_SSH_COMMAND` and `GIT_EXTERNAL_DIFF` ARE
    // a command, `GIT_EXEC_PATH` moves git's own subcommand and remote-helper
    // lookup, `GIT_TEMPLATE_DIR` plants hooks for the next `init`. The repo
    // blocks exactly this family for session subprocesses already
    // (`config/shared-env-keys.ts`), and a review's git calls run as the same
    // user with the same inheritance — a reviewer's shell profile is enough.
    const saved = { ...process.env };
    try {
      const family = [
        'GIT_SSH_COMMAND',
        'GIT_SSH',
        'GIT_EXEC_PATH',
        'GIT_TEMPLATE_DIR',
        'GIT_ASKPASS',
        'GIT_PROXY_COMMAND',
        'GIT_EDITOR',
        'GIT_SEQUENCE_EDITOR',
        'GIT_EXTERNAL_DIFF',
        'XDG_CONFIG_HOME',
      ];
      for (const key of family) process.env[key] = '/tmp/attacker';

      const env = sanitizedGitEnv();

      for (const key of family) expect(env[key]).toBeUndefined();
    } finally {
      process.env = saved;
    }
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

describe('localFilterRefusal', () => {
  // Real repo + linked worktree: the production shape fetch-pr screens
  // against. The screen's whole job is what a REAL `git config --file` sees,
  // so a mocked spawn could not measure it.
  let repo: string;
  let tree: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

  const gitRepo = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-filter-screen-'));
    gitRepo('init', '-q', '-b', 'main');
    gitRepo('config', 'user.email', 't@t.t');
    gitRepo('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    gitRepo('add', '-A');
    gitRepo('commit', '-qm', 'head');
    tree = join(repo, '.qwen', 'tmp', 'review-wt');
    mkdirSync(dirname(tree), { recursive: true });
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
  });

  afterEach(() => {
    gitIsolation.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('answers null on a clean repository', () => {
    expect(localFilterRefusal(tree, 'the probe checkout')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'fails CLOSED on a non-regular candidate file — the FIFO shape',
    () => {
      // The weaponized shape is a FIFO: it passes existsSync and
      // accessSync(R_OK), and the `--file` spawn carries no timeout a writer
      // would answer, so one `mkfifo`+rename into the never-wiped common dir
      // blocks every later review before its first checkout. The gate that
      // closes it refuses EVERY non-regular file; a symlink to /dev/null
      // exercises that same gate without hanging this test the way a real
      // FIFO hangs the mutant. Planted in a fake worktree admin entry, the
      // way a probe plants it: the screen readdirs every registered
      // worktree's admin dir (git honours those files only with
      // extensions.worktreeConfig on; the screen reads them always).
      const admin = join(repo, '.git', 'worktrees', 'planted');
      mkdirSync(admin, { recursive: true });
      symlinkSync('/dev/null', join(admin, 'config.worktree'));

      const r = localFilterRefusal(tree, 'the probe checkout');

      expect(r).not.toBeNull();
      expect(r).toContain('not a regular file');
      expect(r).toContain(join(admin, 'config.worktree'));
      expect(r).toContain('the probe checkout');
    },
  );

  it('refuses an include directive — the screen cannot see what it expands', () => {
    // `--file` does not expand `include.path`/`includeIf.*.path` while the
    // checkout's merged read DOES: a filter planted behind the include
    // below is invisible to the screen and EXECUTES in the certified
    // checkout (measured live). Until the origin-scoped follow-up lands,
    // any include directive in the candidates refuses fail-closed.
    const behind = join(repo, 'behind-include.config');
    writeFileSync(
      behind,
      `[filter "evil"]\n\tsmudge = touch ${join(repo, 'PWNED')}\n`,
    );
    appendFileSync(
      join(repo, '.git', 'config'),
      `[include]\n\tpath = ${behind}\n`,
    );

    const r = localFilterRefusal(tree, 'the probe checkout');

    expect(r).not.toBeNull();
    expect(r).toContain('include directive');
    expect(r).toContain('include.path');
    expect(r).toContain('the probe checkout');
  });

  it('refuses an includeIf directive too — the other spelling of the same hole', () => {
    // The regex's `includeif\..+\.path` alternative had no witness: dropping
    // it left the suite green while a `[includeIf "gitdir:…"]` plant passed
    // the screen and EXECUTED behind the checkout's merged read. The screen
    // reads the directive's key whatever its condition, so the plant shape is
    // the include test's with the conditional spelling.
    const behind = join(repo, 'behind-includeif.config');
    writeFileSync(
      behind,
      `[filter "evil"]\n\tsmudge = touch ${join(repo, 'PWNED')}\n`,
    );
    appendFileSync(
      join(repo, '.git', 'config'),
      `[includeIf "gitdir:${repo}/"]\n\tpath = ${behind}\n`,
    );

    const r = localFilterRefusal(tree, 'the probe checkout');

    expect(r).not.toBeNull();
    expect(r).toContain('include directive');
    expect(r).toContain('includeif.');
  });

  it('names a key whose subsection carries whitespace — never a truncated fragment', () => {
    // `--get-regexp` prints `key value` per line, and taking the first
    // whitespace token truncated such a key to a fragment that exists nowhere
    // verbatim and deduped distinct directives together; `--name-only` prints
    // one bare key per line, so the whole line is the key.
    appendFileSync(
      join(repo, '.git', 'config'),
      `[filter "my lfs"]\n\tsmudge = touch ${join(repo, 'PWNED')}\n`,
    );

    const r = localFilterRefusal(tree, 'the probe checkout');

    expect(r).not.toBeNull();
    expect(r).toContain('filter.my lfs.smudge');
  });

  it('flattens control characters a planted key carries — the catch is inert', () => {
    // A caught attacker still controls the bytes naming the catch: a config
    // subsection may hold any byte but NUL and newline, so an ESC sequence
    // rides `--get-regexp` intact. `inertPath` must flatten it before the
    // refusal reaches the terminal and the report.
    appendFileSync(
      join(repo, '.git', 'config'),
      `[filter "evil\u001b[31m"]\n\tsmudge = touch ${join(repo, 'PWNED')}\n`,
    );

    const r = localFilterRefusal(tree, 'the probe checkout');

    expect(r).not.toBeNull();
    expect(r).not.toContain('\u001b');
    expect(r).toContain('filter.evil [31m.smudge');
  });

  it('caps the enumeration a padded config hands it — the refusal stays actable', () => {
    // test-efficacy re-embeds the full refusal in every probe's detail, so an
    // unbounded key list multiplies into megabytes of report; the message
    // names the first few pairs and counts the rest.
    const padding = Array.from(
      { length: 12 },
      (_, i) => `[filter "pad${i}"]\n\tsmudge = x`,
    ).join('\n');
    appendFileSync(join(repo, '.git', 'config'), `${padding}\n`);

    const r = localFilterRefusal(tree, 'the probe checkout');

    expect(r).not.toBeNull();
    expect(r).toContain('filter.pad0.smudge');
    expect(r).toContain('\u2026 and 4 more filter keys');
    expect(r).not.toContain('filter.pad8.smudge');
  });

  it.skipIf(process.platform === 'win32')(
    'fails CLOSED when the repository path contains a newline — never certifies a misparse',
    () => {
      // `rev-parse` prints the two paths as two stdout lines; a newline in a
      // directory component splits one answer across two lines, every
      // candidate misresolves, and the old parse certified a checkout it had
      // read nothing of. The trigger is the user's own filesystem layout —
      // newlines are legal in directory names on POSIX, only Windows forbids
      // them, hence the skip — and the screen's contract is never to fail
      // open. Separate fixture: the shared one cannot carry the newline.
      const base = mkdtempSync(join(tmpdir(), 'qwen-filter-nl-'));
      const nlRepo = join(base, 'x\ny');
      mkdirSync(nlRepo, { recursive: true });
      const g = (...args: string[]) =>
        execFileSync('git', args, { cwd: nlRepo, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(nlRepo, 'a.ts'), 'export const x = 1;\n');
      g('add', '-A');
      g('commit', '-qm', 'head');
      g('config', 'filter.evil.smudge', `touch ${join(base, 'PWNED')}`);
      const nlTree = join(nlRepo, 'wt');
      g('worktree', 'add', '--detach', '-q', nlTree, 'HEAD');
      try {
        const r = localFilterRefusal(nlTree, 'the probe checkout');
        expect(r).not.toBeNull();
        expect(r).toContain('could not be parsed');
        expect(r).toContain('the probe checkout');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
