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
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isolateHostGitConfig } from './test-utils.js';
import {
  discardWorktree,
  exposeDependencies,
  localFilterBreach,
  localFilterCommands,
  localFilterIdentityMoved,
  localFilterRefusal,
  sanitizedGitEnv,
  worktreeCreateFailureDetail,
  worktreeResidue,
  type LocalFilterBaseline,
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

  it('never fires a planted fsmonitor from its own ignore probes', () => {
    // `check-ignore` and the pathspec'd `ls-files` both refresh the
    // index, and an index refresh fires a planted `core.fsmonitor` —
    // the measurement would become the very execution the probe exists
    // to report. The four status-side spawns carry the `-c` override;
    // this pins the two ignore-probe spawns that pre-dated it (probe,
    // git 2.39: both fired the marker).
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\njunk/\n');
    gitRepo('add', '-A');
    gitRepo('commit', '-qam', 'with-junk-ignored');
    gitRepo('worktree', 'remove', '--force', tree);
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
    // The residue shape that reaches the ignore probes at all: an
    // untracked file a COMMITTED rule hides from status.
    mkdirSync(join(tree, 'junk'));
    writeFileSync(join(tree, 'junk', 'y.txt'), 'residue\n');
    const marker = join(repo, 'FSM-FIRED');
    gitRepo('config', 'core.fsmonitor', `touch ${marker}`);

    const got = worktreeResidue(tree);

    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: [], total: 0 });
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

describe('localFilterCommands', () => {
  // The screen every checkout-authorising guard in this pipeline calls. These
  // fixtures hold the production shape: the tree under measurement is a LINKED
  // worktree (fetch-pr creates the review worktree with `git worktree add`),
  // sharing the main checkout's common dir — where the planting surface lives.
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
    // Created BEFORE any plant below, the way the review worktree exists
    // before a probe plants: a `worktree add` made after the plant copies
    // some shapes into the new tree and hides the gap these pin.
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('is empty when no local filter is defined', () => {
    expect(localFilterCommands(tree)).toEqual({
      keys: [],
      unclearable: [],
    });
  });

  it('names a filter planted directly into the common config', () => {
    gitRepo('config', 'filter.evil.smudge', 'touch /tmp/qwen-never');
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge'],
      unclearable: [],
    });
  });

  it('names keys git renders with a space or a newline intact', () => {
    // The `-z` record read: subsection names legally carry spaces and values
    // legally carry newlines, and the line-oriented `split(/\\s+/)[0]` parse
    // mangled both — truncating the first to a nonexistent `filter.my` and
    // recording the second value's continuation line as a phantom key. The
    // whole record up to the first newline is the key.
    gitRepo('config', 'filter.my filter.smudge', 'touch /tmp/x');
    gitRepo('config', 'filter.evil.smudge', 'first\nsecond');
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.my filter.smudge', 'filter.evil.smudge'],
      unclearable: [],
    });
  });

  it('follows a benign include to its target and clears it', () => {
    // Standard GitHub Actions checkouts carry ambient `includeIf.gitdir:`
    // credential directives whose targets hold only an `http.extraheader`
    // authorization header and no filters. Refusing on ANY directive wedged
    // every checkout on such a runner — the exact false-positive class the
    // screen exists to avoid — so the directive is resolved to its target
    // and refused only when the closure defines filter keys. Conditions are
    // never evaluated: reading every target regardless is the fail-safe
    // reading (see the includeIf arms below).
    const outside = join(mkdtempSync(join(tmpdir(), 'qwen-include-')), 'cfg');
    writeFileSync(
      outside,
      '[http]\n\textraheader = Authorization: Basic dG9rZW4=\n',
    );
    gitRepo('config', 'include.path', outside);

    expect(localFilterCommands(tree)).toEqual({
      keys: [],
      unclearable: [],
    });

    rmSync(dirname(outside), { recursive: true, force: true });
  });

  it('follows an include to a filter and names both', () => {
    // The planted shape the outright refusal used to catch unread: the
    // directive's target holds the filter. The refusal names the filter key
    // the checkout would execute and the directive that reaches it.
    const outside = join(mkdtempSync(join(tmpdir(), 'qwen-include-')), 'cfg');
    writeFileSync(
      outside,
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );
    gitRepo('config', 'include.path', outside);

    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge', 'include.path'],
      unclearable: [],
    });

    rmSync(dirname(outside), { recursive: true, force: true });
  });

  it('follows includes transitively, cycle-guarded', () => {
    // A chain: config.worktree -> A -> B holding the filter, and a cycle
    // (A -> B -> A) that must terminate and clear because neither link
    // reaches a filter. The ENTRY directive sits in `config.worktree` —
    // with the extension off, git's own reads never touch that file, so
    // the cycle cannot poison the ambient config read every git spawn in
    // the screen performs (a cycle in the common config itself makes
    // EVERY git command in the repository fatal — nothing runs, and the
    // screen's empty answer is the loud failure's own).
    // Forward slashes on every interpolated path: `join()` yields
    // backslashes on Windows, and git's config parser rejects them in
    // hand-written config text (probe, git 2.43: `fatal: bad config line
    // 2`), turning the fixture's own `config.worktree` into an
    // unclearable candidate — while git accepts `/` separators there on
    // every platform.
    const fwd = (p: string) => p.replace(/\\/g, '/');
    writeFileSync(
      join(repo, '.git', 'config.worktree'),
      '[include]\n\tpath = ' +
        fwd(join(repo, '.git', 'include-chain-entry')) +
        '\n',
    );
    const dir = mkdtempSync(join(tmpdir(), 'qwen-include-chain-'));
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(
      join(repo, '.git', 'include-chain-entry'),
      `[include]\n\tpath = ${fwd(a)}\n`,
    );
    writeFileSync(a, `[include]\n\tpath = ${fwd(b)}\n`);
    writeFileSync(b, `[include]\n\tpath = ${fwd(a)}\n`);

    expect(localFilterCommands(tree)).toEqual({
      keys: [],
      unclearable: [],
    });

    // The same chain with the filter planted at the far end.
    writeFileSync(
      b,
      `[include]\n\tpath = ${fwd(a)}\n[filter "deep"]\n\tsmudge = x\n`,
    );
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.deep.smudge', 'include.path'],
      unclearable: [],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  // Windows-only shape skipped there: getpwnam never rejects `~user`,
  // git-for-windows falls back to the running user, and the value this
  // fixture pins expands to a path git reads — the refusal this test
  // pins on POSIX never fires. What Windows gets instead is the
  // discovery-failure refusal below answering the same plant.
  it.skipIf(process.platform === 'win32')(
    'fails closed on an include target it cannot resolve',
    () => {
      // An include whose directive names nothing the screen can resolve —
      // here a `~user` home form: git expands it through getpwnam, which no
      // portable Node call this screen can make does — cannot be vouched
      // for, and is refused like a plant, never skipped. The user is REAL
      // (this process's own): a nonexistent user is the same class but
      // never reaches the screen, because git rejects the unexpandable
      // line as bad config and every git read of the file dies.
      gitRepo(
        'config',
        'include.path',
        `~${userInfo().username}/qwen-never-resolved`,
      );
      const got = localFilterCommands(tree);
      expect(got.keys).toEqual(['include.path']);
      expect(got.unclearable).toHaveLength(1);
      expect(got.unclearable[0]).toContain('include.path');
    },
  );

  // The resolver's other unprovable shapes — each one a value the old
  // trim+resolve mapped to a different file (or none) than the git that
  // then ran the checkout (probe, git 2.39: every shape screened clean
  // with the plant standing in the checkout's own config read). A
  // benign include in one of these shapes costs a refusal — the same
  // fail-safe trade the `~user` test above pins — never an execution.
  it('fails closed on an include value carrying edge whitespace', () => {
    // `git config` stores the quoted trailing space verbatim
    // (`path = "inc "`), and git resolves include targets byte-exact —
    // while the screen's old trim resolved `inc`, a different,
    // nonexistent file it then skipped as clean.
    gitRepo('config', 'include.path', 'inc ');
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual(['include.path']);
    expect(got.unclearable).toHaveLength(1);
    expect(got.unclearable[0]).toContain('include.path');
  });

  it('fails closed on an include value git interpolates', () => {
    // `%(prefix)` is git's own interpolation at read time; this screen
    // has no prefix to evaluate it against, and a lexical pass-through
    // resolved a path nothing reads while git read the expanded one.
    gitRepo('config', 'include.path', '%(prefix)/etc/qwen-never');
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual(['include.path']);
    expect(got.unclearable).toHaveLength(1);
  });

  it('fails closed on an include value with a .. segment', () => {
    // The kernel resolves symlinked path components BEFORE applying
    // `..`, while `resolve()` collapses the segment lexically — with a
    // link anywhere in the prefix the two reach different files.
    gitRepo('config', 'include.path', '../qwen-never');
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual(['include.path']);
    expect(got.unclearable).toHaveLength(1);
  });

  it('fails closed on an include value carrying bytes utf8 cannot decode', () => {
    // The screen reads config output as utf8, and a byte it cannot
    // decode arrives as U+FFFD — no spelling of such a value resolves on
    // disk, while git resolves the ORIGINAL bytes. The directive is
    // written raw: no argv path can carry an invalid byte to `git
    // config`.
    appendFileSync(
      join(repo, '.git', 'config'),
      Buffer.from('[include]\n\tpath = inc\xFF\n', 'binary'),
    );
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual(['include.path']);
    expect(got.unclearable).toHaveLength(1);
  });

  it('fails closed when the repository cannot be discovered', () => {
    // Discovery that dies — a toggler swapping the screened tree's
    // `.git` pointer between the screen's spawns and the guarded
    // checkout, a transient spawn failure under load — used to return
    // the empty screen, which every caller reads as "proceed": the one
    // answer the screen's contract never gives. An undiscoverable
    // repository is an unclearable one, refused like a plant.
    writeFileSync(join(tree, '.git'), 'gitdir: /nonexistent-admin-dir\n');
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual([]);
    expect(got.unclearable).toHaveLength(1);
    expect(localFilterRefusal(tree, 'a guarded checkout')).not.toBeNull();
  });

  it('the paired re-read catches a plant that erases itself before it runs', () => {
    // The refusal captured the screened files' state beside a clean
    // screen; a set+unset landing between the two reads leaves the
    // config's CONTENT exactly as it was — the re-read's key scan sees
    // nothing — but the file's mtime is not what the screen recorded.
    const captured: { baseline: LocalFilterBaseline | null } = {
      baseline: null,
    };
    expect(localFilterRefusal(tree, 'a guarded checkout', captured)).toBe(null);
    gitRepo('config', 'filter.evil.smudge', 'touch /tmp/qwen-never');
    gitRepo('config', '--unset', 'filter.evil.smudge');
    // Without the baseline the self-erasing plant sails through: the
    // point-in-time re-read has nothing to name.
    expect(localFilterBreach(tree, 'the guarded checkout')).toBeNull();
    const breach = localFilterBreach(
      tree,
      'the guarded checkout',
      captured.baseline,
    );
    expect(breach).not.toBeNull();
    expect(breach!).toContain('may have EXECUTED');
    expect(breach!).toContain('changed');
  });

  it('refuses when a config directory cannot be enumerated — EACCES is not "nothing registered"', () => {
    // The screen discovers candidates by listing directories; a catch that
    // read EVERY enumeration failure as "no worktrees here" failed OPEN:
    // an execute-only (`--x`) directory defeats readdirSync (needs read)
    // while git's path-based reads through it still succeed (need only
    // execute) — the plant inside screened clean and fired on the checkout
    // (probe, git 2.39: readdir EACCES, path read and stat through the
    // mode-100 dir both fine).
    const worktreesDir = join(repo, '.git', 'worktrees');
    chmodSync(worktreesDir, 0o100);
    try {
      const got = localFilterCommands(tree);
      expect(got.keys).toEqual([]);
      expect(got.unclearable).toHaveLength(1);
      expect(got.unclearable[0]).toContain(worktreesDir);
      expect(got.unclearable[0]).toContain('cannot list');
      expect(localFilterRefusal(tree, 'a guarded checkout')).not.toBeNull();
    } finally {
      chmodSync(worktreesDir, 0o755);
    }
  });

  it('refuses when the modules dir cannot be enumerated, and still clears an absent one', () => {
    // The twin catch under the submodule walk gets the same split: only
    // ENOENT genuinely means "no (further) submodules".
    const modulesDir = join(repo, '.git', 'modules');
    mkdirSync(modulesDir);
    chmodSync(modulesDir, 0o100);
    try {
      const got = localFilterCommands(tree);
      expect(got.keys).toEqual([]);
      expect(got.unclearable).toHaveLength(1);
      expect(got.unclearable[0]).toContain(modulesDir);
    } finally {
      chmodSync(modulesDir, 0o755);
    }
    // ENOENT stays the clean answer: nothing registered is nothing to
    // clear (rmSync the dir, so the next line is the missing shape).
    rmSync(modulesDir, { recursive: true, force: true });
    expect(localFilterCommands(tree)).toEqual({ keys: [], unclearable: [] });
  });

  it('refuses on a non-directory where a config directory should be', () => {
    // ENOTDIR is the shape that needs no permissions at all: a file where
    // `worktrees/` should be. A repository with no linked worktrees keeps
    // a working main checkout, so this screens the MAIN path.
    const other = mkdtempSync(join(tmpdir(), 'qwen-filter-notdir-'));
    try {
      const g = (...args: string[]) =>
        execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(other, 'a.ts'), 'x\n');
      g('add', '-A');
      g('commit', '-qm', 'head');
      writeFileSync(join(other, '.git', 'worktrees'), 'a file, not a dir\n');
      const got = localFilterCommands(other);
      expect(got.keys).toEqual([]);
      expect(got.unclearable).toHaveLength(1);
      expect(got.unclearable[0]).toContain('cannot list');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // GNU `touch -d @<epoch>.<ns>` is what restores a plant's mtime
  // BYTE-EXACT: `utimesSync` cannot — a Date truncates sub-ms, and a
  // float seconds lands ~100 ns off (both measured) — so the witness
  // needs the real binary, which the Windows/macOS runners do not carry.
  it.skipIf(process.platform !== 'linux')(
    'the paired re-read catches a plant that restores content and mtime byte-exact',
    () => {
      // The changed-file half used to compare mtime + size only: a fired
      // plant with arbitrary shell writes its change back (`truncate` +
      // `touch -d`) and leaves both EXACT — clean over the execution
      // (probe: mtime/size equal after the restore, ctime still advanced;
      // `utimensat` cannot set ctime, and a utimes call advances it).
      const f = join(repo, '.git', 'config.worktree');
      writeFileSync(f, 'AB\n');
      const captured: { baseline: LocalFilterBaseline | null } = {
        baseline: null,
      };
      expect(localFilterRefusal(tree, 'a guarded checkout', captured)).toBe(
        null,
      );
      const was = statSync(f, { bigint: true });
      writeFileSync(f, 'XY\n'); // same size, different bytes
      const s = was.mtimeNs / 1000000000n;
      const ns = (was.mtimeNs % 1000000000n).toString().padStart(9, '0');
      execFileSync('touch', ['-d', `@${s}.${ns}`, f]);
      // Compare the ns values: the bigint stat's `mtimeMs` truncates the
      // fraction, so it is not the byte-exact the plant restores.
      expect(statSync(f, { bigint: true }).mtimeNs).toBe(was.mtimeNs);
      const breach = localFilterBreach(
        tree,
        'the guarded checkout',
        captured.baseline,
      );
      expect(breach).not.toBeNull();
      expect(breach!).toContain('may have EXECUTED');
    },
  );

  it('a baseline at mtime -1 is a real stat, not the vanish sentinel', () => {
    // The old `-1` sentinel collided with a real stat:
    // `utimesSync(file, new Date(-1))` produces exactly `-1`
    // (live-measured), and git reads a pre-epoch-mtime config normally —
    // so a file baselined at -1 and DELETED after the plant fired read
    // as "nothing happened". The vanished flag is the sentinel now.
    const f = join(repo, '.git', 'config.worktree');
    writeFileSync(f, '[core]\n');
    utimesSync(f, new Date(-1), new Date(-1));
    expect(statSync(f).mtimeMs).toBe(-1);
    const captured: { baseline: LocalFilterBaseline | null } = {
      baseline: null,
    };
    expect(localFilterRefusal(tree, 'a guarded checkout', captured)).toBe(null);
    rmSync(f);
    const breach = localFilterBreach(
      tree,
      'the guarded checkout',
      captured.baseline,
    );
    expect(breach).not.toBeNull();
    expect(breach!).toContain('changed');
    // Name the SENTINEL file itself: under the old `-1` logic an
    // unrelated vanished entry can supply a spurious "changed", while
    // the -1-mtime file sails through.
    expect(breach!).toContain(f);
  });

  it('the paired re-read catches a candidate that APPEARED inside the window', () => {
    // The screen used to skip candidates absent at screen time before
    // recording the baseline, so a config.worktree CREATED after the
    // screen, EXECUTED by the guarded checkout, and still standing at the
    // re-read was invisible to both halves. Absence is baselined now, and
    // the appearance is the change — whatever the file holds (a benign
    // `[core]` here: the appearing itself is what the checkout saw).
    const f = join(repo, '.git', 'config.worktree');
    const captured: { baseline: LocalFilterBaseline | null } = {
      baseline: null,
    };
    expect(localFilterRefusal(tree, 'a guarded checkout', captured)).toBe(null);
    writeFileSync(f, '[core]\n');
    const breach = localFilterBreach(
      tree,
      'the guarded checkout',
      captured.baseline,
    );
    expect(breach).not.toBeNull();
    expect(breach!).toContain('changed');
    // And absent on BOTH sides is still nothing happening.
    rmSync(f);
    expect(
      localFilterBreach(tree, 'the guarded checkout', captured.baseline),
    ).toBeNull();
  });

  it('the paired re-read catches a swapped .git pointer — identity is pinned', () => {
    // Every half below the re-read resolves through whichever repository
    // the `.git` pointer names NOW, so a swap redirects the authorised
    // checkout into an armed repository while every read answers clean —
    // unless the baseline's identity is compared first.
    const other = mkdtempSync(join(tmpdir(), 'qwen-filter-swap-'));
    try {
      const g = (...args: string[]) =>
        execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(other, 'a.ts'), 'x\n');
      g('add', '-A');
      g('commit', '-qm', 'head');
      const captured: { baseline: LocalFilterBaseline | null } = {
        baseline: null,
      };
      expect(localFilterRefusal(tree, 'a guarded checkout', captured)).toBe(
        null,
      );
      expect(localFilterIdentityMoved(tree, captured.baseline)).toBe(false);
      writeFileSync(join(tree, '.git'), `gitdir: ${join(other, '.git')}\n`);
      expect(localFilterIdentityMoved(tree, captured.baseline)).toBe(true);
      const breach = localFilterBreach(
        tree,
        'the guarded checkout',
        captured.baseline,
      );
      expect(breach).not.toBeNull();
      expect(breach!).toContain('swapped .git pointer');
      // Without the baseline there is nothing to compare — the caller
      // never paired a screen, so the identity half stays quiet.
      expect(localFilterIdentityMoved(tree, null)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses on includeIf directives the screening tree cannot evaluate', () => {
    // Two live-reproduced entrances (probe, git 2.39): (a) a `gitdir` arm
    // aimed at a SIBLING worktree's admin dir — the screening tree's read
    // never matches it, the authorised `worktree add`'s does, and its
    // initial checkout executes the planted smudge; (b) an `onbranch` arm
    // aimed at the user's own branch — every screen runs detached, so the
    // condition never matches any of them, and the plant fires later on the
    // user's own branched checkout. The screen now reads the targets
    // unCONDITIONALLY — both arms are refused because the target holds a
    // filter, never because the condition was judged.
    const outside = join(mkdtempSync(join(tmpdir(), 'qwen-includeif-')), 'cfg');
    writeFileSync(outside, '[filter "evil"]\n\tsmudge = touch /tmp/x\n');

    gitRepo(
      'config',
      `includeIf.gitdir:${join(repo, '.git', 'worktrees')}/review-*.path`,
      outside,
    );
    expect(localFilterCommands(tree)).toEqual({
      keys: [
        'filter.evil.smudge',
        `includeif.gitdir:${join(repo, '.git', 'worktrees')}/review-*.path`,
      ],
      unclearable: [],
    });
    gitRepo(
      'config',
      '--unset',
      `includeIf.gitdir:${join(repo, '.git', 'worktrees')}/review-*.path`,
    );

    gitRepo('config', 'includeIf.onbranch:main.path', outside);
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge', 'includeif.onbranch:main.path'],
      unclearable: [],
    });

    rmSync(dirname(outside), { recursive: true, force: true });
  });

  it("reads the MAIN worktree's config.worktree when screening a linked one", () => {
    // With `extensions.worktreeConfig` on, the main worktree's per-worktree
    // config is `<common>/config.worktree`. A linked screening worktree's
    // candidates covered `<common>/config`, its own `config.worktree` and every
    // `<common>/worktrees/*/config.worktree` — but never that file. The screen
    // reported clean through the whole review while the plant fired on the
    // user's own later main-worktree checkouts — the persistence outcome the
    // screen exists to refuse (probe: merged read from the main worktree sees
    // the filter, a dirty-then-restore checkout there executes it). Refusing
    // on a key some git versions would not honour is the screen's fail-safe
    // posture everywhere else.
    gitRepo('config', 'core.repositoryformatversion', '1');
    gitRepo('config', 'extensions.worktreeConfig', 'true');
    writeFileSync(
      join(repo, '.git', 'config.worktree'),
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );

    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge'],
      unclearable: [],
    });
  });

  it('reads submodule configs under the common dir', () => {
    // A checkout run with `submodule.recurse=true` — one more key a probe
    // writes, which the filter regex never matches — recurses into every
    // initialised submodule and executes the filters THAT config defines
    // (probe: restore-shape checkout over a dirty submodule file creates the
    // marker; worktree add does not recurse). Those configs live under the
    // common dir and were never candidates: `<common>/modules/<name>/` for
    // the main worktree, `<common>/worktrees/<label>/modules/<name>/` for a
    // linked one (a `submodule update --init` run inside the tree lands the
    // gitdir there). Refusing on the filter they execute, wherever it is
    // planted, keeps the screen's posture; the recurse key itself stays
    // legal. The recurse key is the plant's other half but is NOT refused —
    // a user may set it deliberately — so this pins only the filter half.
    const subRepo = mkdtempSync(join(tmpdir(), 'qwen-sub-'));
    const g = (...a: string[]) =>
      execFileSync('git', a, { cwd: subRepo, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 't');
    writeFileSync(join(subRepo, 's.txt'), 'sub\n');
    g('add', '-A');
    g('commit', '-qm', 'sub');

    // `.qwen/` ignored, or the `add -A` below stages the screening
    // worktree (it sits inside the fixture repo) as an embedded gitlink and
    // every later `submodule` command dies on the url-less entry.
    writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        subRepo,
        'sub',
      ],
      { cwd: repo, encoding: 'utf8' },
    );
    gitRepo('add', '-A');
    gitRepo('commit', '-qm', 'with-submodule');
    // Re-point the screening tree at the new HEAD so it carries the gitlink.
    execFileSync('git', ['worktree', 'remove', '--force', tree], {
      cwd: repo,
      encoding: 'utf8',
    });
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
    // Init inside the LINKED tree: the submodule's gitdir lands at
    // `<common>/worktrees/<label>/modules/sub`.
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '-q',
      ],
      { cwd: tree, encoding: 'utf8' },
    );

    // A plant in the linked tree's submodule config...
    const linkedSub = join(
      repo,
      '.git',
      'worktrees',
      basename(tree),
      'modules',
      'sub',
      'config',
    );
    execFileSync(
      'git',
      ['config', '--file', linkedSub, 'filter.evil.smudge', 'x'],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge'],
      unclearable: [],
    });
    execFileSync(
      'git',
      ['config', '--file', linkedSub, '--unset', 'filter.evil.smudge'],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );

    // ...and one in the main worktree's `<common>/modules/sub/config`.
    const mainSub = join(repo, '.git', 'modules', 'sub', 'config');
    execFileSync(
      'git',
      ['config', '--file', mainSub, 'filter.evil.clean', 'x'],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.clean'],
      unclearable: [],
    });

    rmSync(subRepo, { recursive: true, force: true });
  });

  it('reads NESTED submodule configs under the common dir', () => {
    // The depth-2 twin of the test above: superproject -> submodule A ->
    // submodule B lands B's gitdir at `<common>/worktrees/<label>/modules/
    // <a>/modules/<b>/`, and a checkout run with `submodule.recurse=true`
    // recurses to that depth and executes the filters planted in B's
    // config. One `readdirSync` level of enumeration never saw it (probe,
    // git 2.43: the depth-2 plant screened clean through a restore-shape
    // checkout that created the marker), so the walk descends transitively.
    const subA = mkdtempSync(join(tmpdir(), 'qwen-suba-'));
    const subB = mkdtempSync(join(tmpdir(), 'qwen-subb-'));
    const ga = (...a: string[]) =>
      execFileSync('git', a, { cwd: subA, encoding: 'utf8' }).trim();
    const gb = (...a: string[]) =>
      execFileSync('git', a, { cwd: subB, encoding: 'utf8' }).trim();
    gb('init', '-q', '-b', 'main');
    gb('config', 'user.email', 't@t.t');
    gb('config', 'user.name', 't');
    writeFileSync(join(subB, 'b.txt'), 'b\n');
    gb('add', '-A');
    gb('commit', '-qm', 'b');
    ga('init', '-q', '-b', 'main');
    ga('config', 'user.email', 't@t.t');
    ga('config', 'user.name', 't');
    writeFileSync(join(subA, 'a.txt'), 'a\n');
    ga('add', '-A');
    ga('commit', '-qm', 'a');
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subB, 'b'],
      { cwd: subA, encoding: 'utf8' },
    );
    ga('add', '-A');
    ga('commit', '-qm', 'a-with-b');

    writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subA, 'a'],
      { cwd: repo, encoding: 'utf8' },
    );
    gitRepo('add', '-A');
    gitRepo('commit', '-qm', 'with-nested-submodules');
    execFileSync('git', ['worktree', 'remove', '--force', tree], {
      cwd: repo,
      encoding: 'utf8',
    });
    gitRepo('worktree', 'add', '--detach', '-q', tree, 'HEAD');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '--recursive',
        '-q',
      ],
      { cwd: tree, encoding: 'utf8' },
    );

    // B's gitdir: `<common>/worktrees/<label>/modules/a/modules/b/`.
    const nestedConfig = join(
      repo,
      '.git',
      'worktrees',
      basename(tree),
      'modules',
      'a',
      'modules',
      'b',
      'config',
    );
    execFileSync(
      'git',
      ['config', '--file', nestedConfig, 'filter.evil.smudge', 'x'],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(localFilterCommands(tree)).toEqual({
      keys: ['filter.evil.smudge'],
      unclearable: [],
    });

    rmSync(subA, { recursive: true, force: true });
    rmSync(subB, { recursive: true, force: true });
  });

  it('fails closed when the matching output overflows the buffer', () => {
    // The ENOBUFS half of the screen's fail-closed discipline, reproduced
    // against the SAME 64 MiB ceiling it now passes: one armed filter
    // beside enough junk `[filter "jN"] smudge` sections to drown the
    // spawn's buffer. `spawnSync` kills the child at the ceiling — which a
    // `continue` read as "this file matched nothing", screening the armed
    // filter clean through the very checkout the screen guarded (measured
    // live at the old 1 MiB default). The kill is a failure to CLEAR the
    // file, never a clean answer.
    const lines: string[] = [];
    const value = 'x'.repeat(50);
    for (let n = 0; n < 950_000; n++) {
      lines.push(`[filter "j${n}"]\n\tsmudge = ${value}\n`);
    }
    lines.push('[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n');
    writeFileSync(join(repo, '.git', 'config'), lines.join(''));

    const got = localFilterCommands(tree);
    expect(got.unclearable).toHaveLength(1);
    expect(got.unclearable[0]).toContain(join(repo, '.git', 'config'));
    expect(localFilterRefusal(tree, 'x')).not.toBeNull();
  }, 120_000);

  it('fails closed on a candidate file it cannot read', () => {
    // A malformed candidate — here the main worktree's `config.worktree`,
    // read unconditionally although the extension is off — is a file the
    // screen cannot clear; git's own read of it would fail loudly, and the
    // screen's answer is a refusal, never a `continue`.
    writeFileSync(
      join(repo, '.git', 'config.worktree'),
      '[filter "evil"\n\tsmudge = x\n',
    );
    const got = localFilterCommands(tree);
    expect(got.keys).toEqual([]);
    expect(got.unclearable).toHaveLength(1);
    expect(got.unclearable[0]).toContain('config.worktree');
  });

  it('terminates through a planted symlink cycle under modules — and still reads real configs', () => {
    // The old depth cap bounded recursion DEPTH but not total work: five
    // links in `modules/` resolving back to the dir above branched the
    // walk exponentially (≈ n^16 calls toward the cap of 16) and
    // OOM-crashed the process in place of the refusal the screen exists
    // to give — a denial of the whole review run planted by the very
    // artifact the screen polices, persisting in the user's `.git` across
    // retries. Deduping visited directories by realpath makes the walk
    // acyclic regardless of branching; a real config beside the cycle must
    // still be read.
    const modules = join(repo, '.git', 'modules');
    mkdirSync(modules, { recursive: true });
    for (let i = 0; i < 5; i++) {
      // `..` from inside `modules/` names the common dir, so
      // `modules/loopN/modules` resolves back to `modules` itself.
      symlinkSync('..', join(modules, `loop${i}`));
    }
    mkdirSync(join(modules, 'real'), { recursive: true });
    writeFileSync(
      join(modules, 'real', 'config'),
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );

    const got = localFilterCommands(tree);
    expect(got.keys).toEqual(['filter.evil.smudge']);
    expect(got.unclearable).toEqual([]);
  });

  // A newline is a legal character in a repository's path (the user's own
  // clone location — not attacker-controlled), and the screen's discovery
  // used to split one two-flag `rev-parse` output on newlines: such a path
  // parsed into fragments, every candidate landed under a nonexistent
  // directory, and the screen answered clean with the plant standing.
  it.skipIf(process.platform === 'win32')(
    'screens a repository whose path legally contains a newline',
    () => {
      const oddRoot = join(
        mkdtempSync(join(tmpdir(), 'qwen-odd-')),
        'foo\nbar',
      );
      mkdirSync(oddRoot, { recursive: true });
      const oddRepo = join(oddRoot, 'repo');
      const g = (...a: string[]) =>
        execFileSync('git', a, { cwd: oddRepo, encoding: 'utf8' }).trim();
      try {
        execFileSync('git', ['init', '-q', '-b', 'main', oddRepo], {
          cwd: oddRoot,
        });
        g('config', 'user.email', 't@t.t');
        g('config', 'user.name', 't');
        writeFileSync(join(oddRepo, 'a.txt'), 'a\n');
        g('add', '-A');
        g('commit', '-qm', 'head');
        const oddTree = join(oddRoot, 'wt');
        g('worktree', 'add', '--detach', '-q', oddTree, 'HEAD');
        // Planted in the common config, screened FROM the linked worktree:
        // discovery's output is absolute there, and carries the newline.
        g('config', 'filter.evil.smudge', 'touch /tmp/qwen-never');

        expect(localFilterCommands(oddTree)).toEqual({
          keys: ['filter.evil.smudge'],
          unclearable: [],
        });
      } finally {
        rmSync(oddRoot, { recursive: true, force: true });
      }
    },
  );

  it('gives each config source a fresh include-depth budget, the way git does', () => {
    // git resets its depth-10 budget per top-level config source and skips
    // `includeIf` directives whose condition does not match; the screen
    // walks every target regardless of condition, and the old shared
    // membership set let a never-matching DECOY directive consume the
    // budget — it walked the candidate's chain once, deep, and the
    // first-scan collapse then skipped the candidate file's OWN depth-0
    // scan outright, truncating a closure git re-reads fresh at the
    // checkout being authorised. A full bypass with a static plant,
    // live-reproduced on git 2.43. Tracking the shallowest depth each
    // file was scanned at re-scans it with a fresh budget instead.
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const adminConfigWorktree = join(
      repo,
      '.git',
      'worktrees',
      basename(tree),
      'config.worktree',
    );
    // The decoy: a never-matching includeIf in the common config names the
    // admin dir's config.worktree DIRECTLY. The screen walks it at depth 1
    // and its chain z1..z9 at depths 2..10 — z10 lands beyond the cap and
    // nothing is recorded — while git skips the condition and never reads
    // the decoy at all.
    gitRepo(
      'config',
      'includeIf.gitdir:/nonexistent-xyz/.path',
      adminConfigWorktree,
    );
    // The candidate's OWN chain: config.worktree -> z1..z9 -> z10 holding
    // the filter. On its fresh depth-0 scan z10 lands at depth 10 —
    // exactly git's limit — and is honoured.
    const zDir = mkdtempSync(join(tmpdir(), 'qwen-real-chain-'));
    for (let i = 1; i < 10; i++) {
      writeFileSync(
        join(zDir, `z${i}`),
        `[include]\n\tpath = ${fwd(join(zDir, `z${i + 1}`))}\n`,
      );
    }
    writeFileSync(
      join(zDir, 'z10'),
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );
    writeFileSync(
      adminConfigWorktree,
      `[include]\n\tpath = ${fwd(join(zDir, 'z1'))}\n`,
    );

    const got = localFilterCommands(tree);
    expect(got.unclearable).toEqual([]);
    expect(got.keys).toContain('filter.evil.smudge');
    expect(localFilterRefusal(tree, 'x')).not.toBeNull();

    rmSync(zDir, { recursive: true, force: true });
  });
});
