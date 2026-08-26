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
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isolateHostGitConfig } from './test-utils.js';
import {
  adminEntryInsideReviewTmp,
  untrustedGitfile,
  discardWorktree,
  exposeDependencies,
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
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-residue-')));
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

  // A completely genuine forge territory — `git init` with the
  // contamination committed, plus a linked worktree of it — built outside the
  // repo. Both redirect tests stand one up before planting their divergent
  // links; one builder means an isolation fix lands once, not once per test.
  const forgeTerritory = (outside: string, wtName: string) => {
    const forgeRepo = join(outside, 'forge');
    mkdirSync(forgeRepo);
    const fgit = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=t@t.t',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: forgeRepo, encoding: 'utf8' },
      );
    fgit('init', '-q', '-b', 'main', '--template=', '.');
    writeFileSync(join(forgeRepo, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(forgeRepo, '__probe__.test.ts'), 'probe');
    fgit('add', '-A');
    fgit('commit', '-qm', 'the mutant, committed', '--no-verify');
    fgit('worktree', 'add', '--detach', '-q', join(outside, wtName), 'HEAD');
    return join(outside, wtName);
  };

  it('is empty for the tree a review actually reads', () => {
    const head = git('rev-parse', 'HEAD');
    expect(worktreeResidue(tree, 12, head)).toEqual({ paths: [], total: 0 });
    // Unpinned, the same empty measurement is refused, not certified: a
    // forged pair answers clean too, and nothing local tells the two apart
    // (#9557) — so a caller without the fetched sha gets unmeasured, never
    // clean.
    expect(worktreeResidue(tree).unmeasured).toContain('brought no record');
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
    expect(worktreeResidue(tree, 12, git('rev-parse', 'HEAD'))).toEqual({
      paths: [],
      total: 0,
    });
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
    expect(
      worktreeResidue(tree, 12, git('rev-parse', 'HEAD')).unmeasured,
    ).toBeUndefined();
  });

  it('says UNMEASURED for a gitfile swapped at a repo that answers for this path', () => {
    // The identity gate reads `--show-toplevel`, which prints the directory the
    // `.git` FILE sits in — whatever that file points at. A repository whose
    // `core.worktree` names this tree answers with this path, so the gate saw
    // itself while every command after it would measure the plant's index.
    // Measured in round 1: through discovery the swap certified a mutant
    // clean.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    // Genuine first, so the fixture is known to be measurable at all.
    expect(worktreeResidue(tree).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    gitRepo('config', 'core.worktree', tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    // The shape with NO admin entry gets its own reason: a main checkout has
    // no `gitdir` file to "not point back", and the triager hunting one is
    // the confusion the distinct message exists to spare.
    expect(got.unmeasured).toContain('no admin entry');
  });

  it('says UNMEASURED for a forged admin entry when the caller pins the expected head', () => {
    // The round trip proves only that the admin entry the gitfile names SAYS
    // this tree is its worktree — and a same-user planter writes both halves
    // of the pair: a repo carrying the contamination as committed content,
    // and an admin entry whose `gitdir` file is hand-written to name this
    // tree (four small writes). The gate then passes end-to-end and the pin
    // measures the forge's index. Measured: without the caller's anchor the
    // swap below answers clean with the mutant on disk. The anchor is the
    // one thing the forge cannot reproduce — committing the contamination
    // moves its HEAD off the fetched sha.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const expected = git('rev-parse', 'HEAD');
    // A genuine tree with the right sha still measures: the anchor must not
    // become a refusal of its own — in either case, the caller's guard
    // admits an uppercase sha and the pin folds case on BOTH sides.
    expect(worktreeResidue(tree, 12, expected).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);
    expect(
      worktreeResidue(tree, 12, expected.toUpperCase()).paths.sort(),
    ).toEqual(['__probe__.test.ts', 'a.ts']);

    // The forge: the contamination committed into the REAL repository — its
    // HEAD moves off the fetched sha — and an admin entry hand-written
    // beside the tree's own. Same common dir, so every shape check passes;
    // only the pin can still tell the entry from the one `worktree add`
    // wrote.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(repo, '__probe__.test.ts'), 'probe');
    gitRepo('add', 'a.ts', '__probe__.test.ts');
    gitRepo('commit', '-qm', 'the mutant, as if it were the commit');
    const forgedHead = gitRepo('rev-parse', 'HEAD');
    const admin = join(repo, '.git', 'worktrees', 'evil');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(tree, '.git')}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'HEAD'), `${forgedHead}\n`);
    copyFileSync(join(repo, '.git', 'index'), join(admin, 'index'));
    writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`);

    // Unpinned, the forge's index answers clean — and an unanchored clean
    // verdict is exactly the one the probe refuses (#9557).
    const unpinned = worktreeResidue(tree);
    expect(unpinned.paths).toEqual([]);
    expect(unpinned.unmeasured).toContain('brought no record');

    // Pinned to the fetched sha: the forge's HEAD is the mutant's commit.
    const pinned = worktreeResidue(tree, 12, expected);
    expect(pinned.paths).toEqual([]);
    expect(pinned.unmeasured).toContain('not the fetched PR head');

    // And a pinned identity whose HEAD cannot be read gets its own reason —
    // the gate passed, so "not a git worktree" would misname it. An unborn
    // HEAD (a ref to a branch with no commit) keeps discovery alive while
    // the pinned `rev-parse HEAD` fails — a garbage HEAD file would fail
    // discovery itself and land in the outer catch instead.
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/nope\n');
    expect(worktreeResidue(tree, 12, expected).unmeasured).toContain(
      'could not read its own HEAD',
    );
  });

  it('says UNMEASURED for a gitfile borrowing a SIBLING worktree’s admin entry', () => {
    // The mismatch arm of the round trip: a real admin entry — a sibling's —
    // whose `gitdir` file names the sibling's `.git`, not this tree's.
    // `--show-toplevel` prints the directory the gitfile sits in, so the
    // self-equality passes while the round trip catches the borrow. The arm
    // needs its own witness: negating the comparison ships green without this
    // test — measured, the gate then passes and certifies a tree measured
    // against the sibling's index.
    const sibling = join(repo, '.qwen', 'tmp', 'sibling-wt');
    gitRepo('worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    const admin = readFileSync(join(sibling, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`);

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('does not point back');
  });

  it('says UNMEASURED — not "not a git worktree" — for a dangling backpointer', () => {
    // The admin entry's `gitdir` file names a path that does not exist — a
    // crash mid-`worktree add`, a cleanup gone wrong, a sloppy forge. `git
    // rev-parse` still exits 0 in that state, so the path IS a worktree with
    // an admin entry; an ENOENT out of the round-trip comparison must not
    // land in the outer catch and be reported as the much vaguer "not a git
    // worktree". Unresolvable is "does not point back" — same refusal.
    const admin = readFileSync(join(tree, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    writeFileSync(join(admin, 'gitdir'), `${join(repo, 'gone', '.git')}\n`);

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('does not point back');
  });

  it('accepts a backpointer spelled through a link that resolves at this tree', () => {
    // The round trip's LEFT side is attacker-written, so its normalisation is
    // load-bearing: a `gitdir` file spelled through a link that RESOLVES at
    // this tree's `.git` does point back at this tree, and refusing it would
    // fail closed on a shape that names the right tree. Measured: removing
    // the realpathSync from the comparison flips this probe from clean to
    // unmeasured — the witness that a spelling and a resolution are being
    // compared, not two spellings.
    const alias = join(repo, 'alias');
    symlinkSync(tree, alias);
    const admin = readFileSync(join(tree, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    writeFileSync(join(admin, 'gitdir'), `${join(alias, '.git')}\n`);

    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));

    expect(got.unmeasured).toBeUndefined();
    expect(got.paths).toEqual(['__probe__.test.ts']);
  });

  it('says UNMEASURED when an ancestor of the tree is a symlink into forge territory', () => {
    // A link planted at any ancestor below the checkout — here `.qwen/tmp`,
    // the directory the pipeline itself names — redirects the chdir into
    // territory holding a completely genuine `git init` + `worktree add`
    // pair with the contamination COMMITTED: no forged admin entry, the
    // round trip is real git state, and every check resolves THROUGH the
    // link and agrees with itself. Measured: the redirect certified the
    // mutant clean before the walk.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    expect(worktreeResidue(tree).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-redirect-')));
    try {
      forgeTerritory(outside, 'review-wt');

      // The attack: the ancestor becomes a link into that territory.
      rmSync(dirname(tree), { recursive: true, force: true });
      symlinkSync(outside, dirname(tree));

      const got = worktreeResidue(tree);

      expect(got.paths).toEqual([]);
      // The walk refuses it: the territory's common dir is no ancestor of
      // the spelled path, so the walk lstats every component up to the
      // root and finds the planted link on the way.
      expect(got.unmeasured).toContain('resolves through a symlink');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('measures a healthy tree spelled through a symlink ABOVE the repository root', () => {
    // The containment gate holds the caller's spelling against git's
    // PHYSICAL common dir, so a checkout reached through a link above the
    // repository — `/tmp` on every macOS box, a linked home — failed the
    // literal test and was refused on every run: the note nobody reads, on
    // a shape the walk deliberately does not look at (above the root is the
    // user's own layout, not anything a probe can plant). The resolution is
    // contained, so the healthy shape must measure.
    const head = git('rev-parse', 'HEAD');
    const aliasHome = mkdtempSync(join(tmpdir(), 'qwen-spell-'));
    const alias = join(aliasHome, 'alias');
    symlinkSync(dirname(repo), alias);
    const spelled = join(alias, basename(repo), '.qwen', 'tmp', 'review-wt');
    try {
      expect(worktreeResidue(spelled, 12, head)).toEqual({
        paths: [],
        total: 0,
      });
      // And the measurement is the tree's, not the spelling's: residue
      // written at the physical path is named through the alias.
      writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
      expect(worktreeResidue(spelled, 12, head).paths).toEqual([
        '__probe__.test.ts',
      ]);
    } finally {
      rmSync(aliasHome, { recursive: true, force: true });
    }
  });

  it('says UNMEASURED when an INTERMEDIATE ancestor is a symlink the earlier gates cannot see', () => {
    // The walk's own witness: the sibling redirect shape refuses at the
    // walk itself (its common dir is no ancestor, so the walk climbs to
    // the root and meets the link), the leaf-link shape refuses at the
    // leaf lstat, and deleting the walk turns the redirect test red —
    // before the containment refusal was removed it shipped green
    // (measured). This shape passes every gate above it: the leaf is a
    // real directory, the self-equality holds because both sides resolve
    // through the same link, and the moved tree's gitfile still names the
    // REAL repo's admin entry, so the common dir is the repo and the
    // tree's literal path runs under it. Only the walk can refuse it.
    expect(worktreeResidue(tree, 12, git('rev-parse', 'HEAD'))).toEqual({
      paths: [],
      total: 0,
    });

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-walk-')));
    try {
      // Move the worktree out and plant a link at its parent pointing after
      // it. The moved tree keeps naming its original admin entry — spelled
      // absolutely, because its old relative spelling no longer resolves from
      // outside the repo.
      renameSync(tree, join(outside, 'review-wt'));
      writeFileSync(
        join(outside, 'review-wt', '.git'),
        `gitdir: ${join(repo, '.git', 'worktrees', 'review-wt')}\n`,
      );
      rmSync(dirname(tree), { recursive: true, force: true });
      symlinkSync(outside, dirname(tree));

      const got = worktreeResidue(tree);

      expect(got.paths).toEqual([]);
      expect(got.unmeasured).toContain('resolves through a symlink');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('says UNMEASURED when the tree path itself is a symlink into forge territory', () => {
    // The same concealment one hop closer: the LEAF replaced by a link.
    // `spawnSync` chdirs through it, `--show-toplevel` answers the physical
    // forge path, and both sides of the self-equality resolve through the
    // same link, while the pin would freeze the forge's identity. Measured:
    // the redirect certified the mutant clean before the leaf check.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    expect(worktreeResidue(tree).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-redirect-')));
    try {
      const forgedTree = forgeTerritory(outside, 'leaf-wt');

      // The attack: the leaf becomes a link into that territory.
      rmSync(tree, { recursive: true, force: true });
      symlinkSync(forgedTree, tree);

      const got = worktreeResidue(tree);

      expect(got.paths).toEqual([]);
      expect(got.unmeasured).toContain('resolves through a symlink');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

    const got = worktreeResidue(fresh, 12, gitRepo('rev-parse', 'HEAD'));
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
    const healthy = worktreeResidue(nested, 12, git('rev-parse', 'HEAD'));
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

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
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

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));

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

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));

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

  it('says UNMEASURED for a sha-less caller even when a dirty decoy is present', () => {
    // The no-record refusal cannot be conditional on the measured list being
    // empty: a forged pair can commit the contamination and leave an
    // unrelated untracked decoy, and the decoy alone is what the
    // measurement then reports — the committed contamination is by
    // construction absent from any residue list. Dirty paths still point at
    // the tree either way, so they are kept for diagnostics; the clean
    // certificate is what the unanchored identity forfeits.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    git('add', 'a.ts');
    git('commit', '-qm', 'the mutant, committed');
    writeFileSync(join(tree, 'dirty-decoy.txt'), 'decoy\n');

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual(['dirty-decoy.txt']);
    expect(got.total).toBe(1);
    expect(got.unmeasured).toContain('brought no record');
  });

  // Windows filesystems refuse a `\n` inside a name, so the fixture the
  // misparse needs cannot exist there — the same convention as the other
  // POSIX-only shapes in this suite.
  it.skipIf(process.platform === 'win32')(
    'measures a worktree below a directory whose name carries a newline',
    () => {
      // The discovery answers are three arbitrary filesystem paths, so a
      // newline-delimited parse of one combined answer misreads any
      // directory that carries one: extra records, misassigned
      // gitdir/commondir, and a genuine worktree reported as not one. Each
      // value gets its own query.
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-nl-')));
      try {
        const nlRepo = join(home, 'dir\nwith-newline', 'repo');
        mkdirSync(nlRepo, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: nlRepo });
        execFileSync('git', ['config', 'user.email', 't@t.t'], {
          cwd: nlRepo,
        });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: nlRepo });
        writeFileSync(join(nlRepo, 'a.ts'), 'x\n');
        execFileSync('git', ['add', '-A'], { cwd: nlRepo });
        execFileSync('git', ['commit', '-qm', 'head'], { cwd: nlRepo });
        const wt = join(nlRepo, '.qwen', 'tmp', 'review-wt');
        mkdirSync(dirname(wt), { recursive: true });
        execFileSync('git', ['worktree', 'add', '--detach', '-q', wt, 'HEAD'], {
          cwd: nlRepo,
        });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: wt,
          encoding: 'utf8',
        }).trim();

        expect(worktreeResidue(wt, 12, head)).toEqual({
          paths: [],
          total: 0,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('measures a review worktree under a checkout that is itself a linked worktree', () => {
    // `fetch-pr` creates the review worktree from the process cwd with no
    // main-checkout requirement, so the cwd may itself be a linked worktree:
    // the review tree's common dir then belongs to the MAIN checkout, whose
    // parent is a sibling of the tree's path, not an ancestor. The identity
    // checks — round trip, sha pin, the symlink walk — all hold that shape,
    // so the measurement must answer rather than refuse.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-sib-')));
    try {
      const main = join(home, 'main');
      mkdirSync(main);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: main });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: main });
      writeFileSync(join(main, 'a.ts'), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: main });
      execFileSync('git', ['commit', '-qm', 'head'], { cwd: main });
      const sib = join(home, 'sib');
      execFileSync('git', ['worktree', 'add', '--detach', '-q', sib, 'HEAD'], {
        cwd: main,
      });
      const wt = join(sib, '.qwen', 'tmp', 'review-wt');
      mkdirSync(dirname(wt), { recursive: true });
      execFileSync('git', ['worktree', 'add', '--detach', '-q', wt, 'HEAD'], {
        cwd: sib,
      });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: wt,
        encoding: 'utf8',
      }).trim();

      expect(worktreeResidue(wt, 12, head)).toEqual({ paths: [], total: 0 });
      // And the measurement is the tree's: residue written there is named.
      writeFileSync(join(wt, '__probe__.test.ts'), 'probe');
      expect(worktreeResidue(wt, 12, head).paths).toEqual([
        '__probe__.test.ts',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('measures a review worktree of a --separate-git-dir checkout', () => {
    // In the layout `git init --separate-git-dir` creates, the common dir
    // intentionally lives outside the checkout, so its parent is no
    // ancestor of the review tree's path — a supported repository shape the
    // probe must measure, not refuse.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-sep-')));
    try {
      const checkout = join(home, 'checkout');
      const gitDir = join(home, 'elsewhere', 'repo.git');
      mkdirSync(join(home, 'elsewhere'));
      execFileSync('git', [
        'init',
        '-q',
        '-b',
        'main',
        `--separate-git-dir=${gitDir}`,
        checkout,
      ]);
      execFileSync('git', ['config', 'user.email', 't@t.t'], {
        cwd: checkout,
      });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: checkout });
      writeFileSync(join(checkout, 'a.ts'), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: checkout });
      execFileSync('git', ['commit', '-qm', 'head'], { cwd: checkout });
      const wt = join(checkout, '.qwen', 'tmp', 'review-wt');
      mkdirSync(dirname(wt), { recursive: true });
      execFileSync('git', ['worktree', 'add', '--detach', '-q', wt, 'HEAD'], {
        cwd: checkout,
      });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: wt,
        encoding: 'utf8',
      }).trim();

      expect(worktreeResidue(wt, 12, head)).toEqual({ paths: [], total: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('worktreeResidue — the blind sets', () => {
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-blind-')));
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
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-bits-')));
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

    // Git prints worktree paths forward-slashed on Windows; `other` is a
    // backslash `join` there. Compare slash-normalized (identity on POSIX).
    expect(git(repo, 'worktree', 'list').replace(/\\/g, '/')).toContain(
      other.replace(/\\/g, '/'),
    );
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

const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

describe('untrustedGitfile', () => {
  const made: string[] = [];
  const tmp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-gitfile-')));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A REAL repository with a real linked worktree under `.qwen/tmp` — the
   * pipeline's own geometry. Real, because the gate asks git to resolve the
   * pointer rather than parsing it, so a fixture git cannot read proves
   * nothing about either answer.
   */
  const pipelineTree = () => {
    const repo = tmp();
    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'config', 'user.email', 't@t.t');
    g(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-q', '-m', 'init');
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(dirname(tree), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
    return { repo, tree, mount: () => join(repo, '.qwen', 'tmp') };
  };

  it('ADMITS an intact pipeline gitfile', () => {
    // The admit path, which nothing exercised: every refusal case would also
    // refuse under a mutation that breaks the resolution, so only asserting
    // the admit tells a working gate from one that refuses everything.
    const { tree, mount } = pipelineTree();
    expect(untrustedGitfile(tree, mount)).toBeNull();
  });

  it('refuses a pointer git resolves INTO the mount, however it is spelled', () => {
    // Spelled with a non-breaking space, which JS `trim()` strips and git's
    // `read_gitfile` does not — the divergence that let the first cut resolve
    // the REAL entry, outside the mount, and admit a tree git resolves to a
    // planted one inside it. The gate asks git now, so the spelling stops
    // mattering: whatever git answers is what gets located.
    const { repo, tree, mount } = pipelineTree();
    const planted = join(repo, '.qwen', 'tmp', '.evil-git');
    const real = readFileSync(join(tree, '.git'), 'utf8')
      .trim()
      .replace('gitdir: ', '');
    cpSync(real, planted, { recursive: true });
    writeFileSync(join(planted, 'commondir'), `${join(repo, '.git')}\n`);
    writeFileSync(join(planted, 'gitdir'), `gitdir: ${join(tree, '.git')}\n`);
    writeFileSync(join(tree, '.git'), `gitdir: ${planted}\n`);
    expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
  });

  it('refuses a `.git` that is not the pipeline gitfile at all', () => {
    // `rm .git && git init .` inside the mount: a repository of the writer's
    // own, which skips every gate written for the gitfile shape.
    const { tree, mount } = pipelineTree();
    rmSync(join(tree, '.git'), { force: true });
    execFileSync('git', ['init', '-q'], { cwd: tree });
    expect(untrustedGitfile(tree, mount)).toContain('not the gitfile');
  });

  it('follows GIT through a spelling only git and JS read differently', () => {
    // The divergence that made parsing here unsafe: JS `trim()` strips U+00A0,
    // git's `read_gitfile` trims only C-locale space. Spelled with a leading
    // NBSP, the pointer resolves — in Node — to the REAL entry outside the
    // mount and would be admitted, while git reads the NBSP as part of a
    // RELATIVE path and lands on the planted entry inside the mount, which is
    // what the checkout would then run through.
    const { repo, tree, mount } = pipelineTree();
    const real = readFileSync(join(tree, '.git'), 'utf8')
      .trim()
      .replace('gitdir: ', '');
    // The planted entry sits where git will look: under the tree, at a name
    // beginning with the NBSP.
    const planted = join(tree, `\u00a0${real}`);
    mkdirSync(dirname(planted), { recursive: true });
    cpSync(real, planted, { recursive: true });
    writeFileSync(join(planted, 'commondir'), `${join(repo, '.git')}\n`);
    writeFileSync(join(planted, 'gitdir'), `gitdir: ${join(tree, '.git')}\n`);
    writeFileSync(join(tree, '.git'), `gitdir: \u00a0${real}\n`);

    // Node would resolve the real entry here; git resolves the planted one.
    expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
  });

  itWhereContainmentExists(
    "takes git's answer unedited, trailing NBSP and all",
    () => {
      // The trap the ASK GIT fix walked back into: `.trim()` on git's stdout
      // removes U+00A0 too, so an entry whose directory NAME ends in one is
      // resolved by git with it and judged here without it — and a twin of
      // that name minus the character, symlinked outside the mount, is what
      // the judgment then lands on. Only the terminator may be stripped.
      const { repo, tree, mount } = pipelineTree();
      const real = readFileSync(join(tree, '.git'), 'utf8')
        .trim()
        .replace('gitdir: ', '');
      const planted = join(repo, '.qwen', 'tmp', 'entry\u00a0');
      const twin = join(repo, '.qwen', 'tmp', 'entry');
      cpSync(real, planted, { recursive: true });
      writeFileSync(join(planted, 'commondir'), `${join(repo, '.git')}\n`);
      writeFileSync(join(planted, 'gitdir'), `gitdir: ${join(tree, '.git')}\n`);
      // The twin points OUTSIDE the mount; trimming the NBSP lands here.
      symlinkSync(repo, twin);
      writeFileSync(join(tree, '.git'), `gitdir: ${planted}\n`);

      expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
    },
  );

  it('says nothing about a tree that does not exist yet', () => {
    // `--resume` asks about a worktree before deciding whether to build one.
    // Absence is that caller's question; answering it here refused every
    // ordinary resume — 26 of them, measured.
    const { repo, mount } = pipelineTree();
    expect(
      untrustedGitfile(join(repo, '.qwen', 'tmp', 'review-pr-999'), mount),
    ).toBeNull();
  });

  it('says nothing at all outside a mount', () => {
    // A plain checkout's `.git` IS a directory; refusing that would refuse
    // every ordinary repository.
    const repo = tmp();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect(untrustedGitfile(repo, () => null)).toBeNull();
  });
});

describe('adminEntryInsideReviewTmp', () => {
  const made: string[] = [];
  const tmp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-admin-')));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an entry planted inside the mounted directory', () => {
    // The shape the round-trip gate cannot see: the writer chose BOTH the
    // gitfile's target and that target's backpointer, so the two agree, no
    // symlink is involved, and `--show-toplevel` still names the tree. Only
    // the entry's location tells them apart.
    const repo = tmp();
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1-probe');
    const planted = join(repo, '.qwen', 'tmp', '.evil-git');
    mkdirSync(tree, { recursive: true });
    mkdirSync(planted, { recursive: true });
    expect(
      adminEntryInsideReviewTmp(
        planted,
        () => join(repo, '.qwen', 'tmp'),
        tree,
      ),
    ).toBe(true);
  });

  it('counts the mount root itself, and a child that looks like an escape', () => {
    // The two shapes a hand-rolled prefix test gets wrong, and both are places
    // a planted entry can actually sit. The mount ROOT is as writable as
    // anything under it, and `..evil-git` is a legal filename whose relative
    // path starts with the characters an escape would.
    const repo = tmp();
    const mount = join(repo, '.qwen', 'tmp');
    const tree = join(mount, 'review-pr-1-probe');
    const oddly = join(mount, '..evil-git');
    mkdirSync(tree, { recursive: true });
    mkdirSync(oddly, { recursive: true });
    expect(adminEntryInsideReviewTmp(mount, () => mount, tree)).toBe(true);
    expect(adminEntryInsideReviewTmp(oddly, () => mount, tree)).toBe(true);
    // ...while a genuine sibling of the mount is still outside.
    const outside = join(repo, '.qwen', 'review-leases');
    mkdirSync(outside, { recursive: true });
    expect(adminEntryInsideReviewTmp(outside, () => mount, tree)).toBe(false);
  });

  it('admits the real admin entry, which lives under the repository git dir', () => {
    const repo = tmp();
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1-probe');
    const real = join(repo, '.git', 'worktrees', 'review-pr-1-probe');
    mkdirSync(tree, { recursive: true });
    mkdirSync(real, { recursive: true });
    expect(
      adminEntryInsideReviewTmp(real, () => join(repo, '.qwen', 'tmp'), tree),
    ).toBe(false);
  });

  it('refuses rather than guesses when the entry cannot be resolved', () => {
    // Fails CLOSED: "not inside" would be a guess, and the guess that lets a
    // planted entry through is the one that ends in host execution.
    const repo = tmp();
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1-probe');
    mkdirSync(tree, { recursive: true });
    expect(
      adminEntryInsideReviewTmp(
        join(repo, 'gone'),
        () => join(repo, '.qwen', 'tmp'),
        tree,
      ),
    ).toBe(true);
  });

  it('has nothing to say about a tree outside any mounted directory', () => {
    // A local checkout is never mounted, so there is no writable surface for
    // this question to be about — and answering `true` there would refuse
    // every ordinary repository.
    const repo = tmp();
    expect(adminEntryInsideReviewTmp(repo, () => null, repo)).toBe(false);
  });
});
