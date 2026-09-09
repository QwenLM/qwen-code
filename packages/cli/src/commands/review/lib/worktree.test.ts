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
import { execFileSync, spawnSync } from 'node:child_process';
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  adminEntryOf,
  isolateHostGitConfig,
  plantAdminEntry,
} from './test-utils.js';
import {
  adminEntryInsideReviewTmp,
  checkoutFilterCommands,
  discardWorktree,
  exposeDependencies,
  filterBlankEnv,
  filterCommandsIn,
  insideReviewTmpLexically,
  localFilterCommands,
  mountNullKind,
  mountRootFor,
  parseTrustedConfigRecords,
  redirectedAncestor,
  sanitizedGitEnv,
  unmountableRootSpelling,
  untrustedGitfile,
  untrustedRepositoryFrom,
  worktreeCreateFailureDetail,
  worktreeResidue,
} from './worktree.js';

// On Windows `mountRootFor` refuses every absolute path (a drive letter is a
// colon), so containment cannot exist there and the gates stay silent by
// design — a case asserting a REFUSAL has no answer to assert on that lane.
const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

// One case below plants a name holding a raw invalid-UTF-8 byte, which only a
// filesystem that stores such names allows — NTFS is UTF-16 and APFS rejects
// invalid UTF-8 with EILSEQ, so the shape the case pins cannot exist there
// (and neither can the attack: the plant itself is uncreateable).
const itWhereRawByteNamesExist = it.skipIf(process.platform !== 'linux');

// Replaces a gitfile that `git worktree add` created. On Windows git marks
// the linked worktree's `.git` hidden, and opening a hidden file for truncate
// (writeFileSync's CREATE_ALWAYS) fails with EPERM — so unlink first and let
// the rewrite create a fresh, unhidden file.
function overwriteGitfile(gitfilePath: string, content: string): void {
  rmSync(gitfilePath, { force: true });
  writeFileSync(gitfilePath, content);
}

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

  it('blanks a repo-local content filter on the measurement — the status neither runs it nor loses the measurement', () => {
    // `status` REFRESHES the index, and a stat-stale tracked file whose
    // attributes select a filter refreshes THROUGH that filter's `clean`
    // command — measured live on git 2.43 and 2.47 through the exact residue
    // invocation, which then reported the tree clean. The `-c` blanks close
    // the two channels a fixed key names (`core.fsmonitor`, `core.hooksPath`);
    // a filter's key is the planter's to name, so the names are READ first
    // (the repo-local config files, includes followed) and every one found
    // is blanked on the `status` spawn itself (`filterBlankEnv`) — not
    // refused: a repository whose own config defines a filter (git-lfs
    // `--local`, git-crypt) keeps its residue measurement, where a refusal
    // left it unmeasured for good. So the probe file beside the plant is
    // still NAMED. The plant is two writes into the common dir: the config
    // key and one attributes line in `info/attributes`.
    const marker = join(repo, 'PWNED-clean');
    gitRepo('config', 'filter.evil.clean', `touch ${marker} && cat`);
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=evil\n',
    );
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(tree, 'a.ts'), stale, stale);
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: ['__probe__.test.ts'], total: 1 });
  });

  it('blanks the `process` filter too — the long-running protocol serves the same refresh', () => {
    // `filter.<name>.process` is the third command a filter key can carry,
    // and the one a screen written for `smudge|clean` alone misses: git
    // spawns it for the refresh exactly as it spawns `clean` (the marker
    // appears even when the protocol handshake then fails, measured live).
    // Marked REQUIRED, as git-lfs marks its own: an emptied required filter
    // fails the command instead of skipping it, so the blank sets
    // `required=false` beside it, and the measurement still lands.
    const marker = join(repo, 'PWNED-process');
    gitRepo('config', 'filter.evil.process', `sh -c 'touch ${marker}; cat'`);
    gitRepo('config', 'filter.evil.required', 'true');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=evil\n',
    );
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(tree, 'a.ts'), stale, stale);

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: [], total: 0 });
  });

  it('follows include.path — a filter reached only through an include is the same plant', () => {
    // `git config --file` does not expand `include.path`: a planter commits
    // `[filter "evil"] clean = …` in an innocuous file and adds ONE include
    // line to the repo-local config, and a --file read listed the directive
    // while the `status` refresh ran the command (measured). The screen
    // follows the include the way git does — relative to the including
    // FILE (`.git/config`), never to a cwd — and blanks what it delivers.
    const marker = join(repo, 'PWNED-included');
    writeFileSync(
      join(repo, 'innocuous.cfg'),
      `[filter "evil"]\n\tclean = touch ${marker} && cat\n`,
    );
    gitRepo('config', 'include.path', '../innocuous.cfg');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=evil\n',
    );
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(tree, 'a.ts'), stale, stale);

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: [], total: 0 });
  });

  it('blanks a globally exempt filter during the residue measurement', () => {
    const marker = join(repo, 'PWNED-global-included');
    const globalConfig = join(gitIsolation.home, '.gitconfig');
    writeFileSync(
      globalConfig,
      `[filter "evil"]\n\tclean = touch ${marker} && cat\n`,
    );
    gitRepo('config', 'include.path', globalConfig);
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=evil\n',
    );
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(tree, 'a.ts'), stale, stale);

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: [], total: 0 });
  });

  it('refuses a dangling include rather than reading it as "no filters"', () => {
    // git ignores an include whose target is missing; a screen that did the
    // same would certify a config whose payload file lands one step later.
    gitRepo('config', 'include.path', '../not-there.cfg');
    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('not-there.cfg');
  });

  it('screens a config whose filter listing overflows the 1 MiB spawn default', () => {
    // The screen's stdout is sized by the file the planter writes: past
    // Node's default `maxBuffer`, `spawnSync` answers ENOBUFS with no stdout,
    // and a screen that `continue`d on that read the file as filter-free
    // while the refresh ran the planted command (measured at 1.01 MiB).
    const marker = join(repo, 'PWNED-overflow');
    gitRepo('config', 'filter.evil.clean', `touch ${marker} && cat`);
    const pad = 'x'.repeat(10_000);
    let padding = '';
    for (let i = 0; i < 120; i++) {
      padding += `[filter "pad${i}"]\n\tclean = ${pad}\n`;
    }
    appendFileSync(join(repo, '.git', 'config'), padding);
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=evil\n',
    );
    const stale = new Date(Date.now() + 60_000);
    utimesSync(join(tree, 'a.ts'), stale, stale);

    const got = worktreeResidue(tree, 12, git('rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(got).toEqual({ paths: [], total: 0 });
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

  it('gives a mount that is NO repository the walk-up reason, not the gate’s', () => {
    // The location gate below fails closed on a git it could not run, and a
    // genuine "not a repository" is not that: it belongs to the walk-up check,
    // whose reason says what was actually found. Folding the two would report
    // a `.git` gitfile that does not exist — and would refuse a directory the
    // caller's own error path already owns.
    const root = mkdtempSync(join(tmpdir(), 'qwen-plain-'));
    const plain = join(root, '.qwen', 'tmp', 'x');
    mkdirSync(plain, { recursive: true });
    try {
      const got = worktreeResidue(plain);
      expect(got.paths).toEqual([]);
      expect(got.unmeasured).toBeTruthy();
      expect(got.unmeasured).not.toContain('could not resolve its own git dir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The common-dir reason is the LOCATION gate's, and on Windows
  // `mountRootFor` refuses every absolute path (a drive letter is the colon it
  // refuses), so no location gate speaks there and the identity gate answers
  // instead. Gated rather than branched on `process.platform` inside one
  // assertion, so each lane asserts one unconditional expectation — gating
  // case by case inside a shared assertion is how the same lane surfaced four
  // times in this pull request.
  it.skipIf(process.platform === 'win32')(
    'says UNMEASURED for a gitfile swapped at a repo that answers for this path',
    () => {
      // The identity gate reads `--show-toplevel`, which prints the directory
      // the `.git` FILE sits in — whatever that file points at. A repository
      // whose `core.worktree` names this tree answers with this path, so the
      // gate saw itself while every command after it would measure the plant's
      // index. Measured in round 1: through discovery the swap certified a
      // mutant clean.
      writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
      writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
      // Genuine first, so the fixture is known to be measurable at all.
      expect(worktreeResidue(tree).paths.sort()).toEqual([
        '__probe__.test.ts',
        'a.ts',
      ]);

      gitRepo('config', 'core.worktree', tree);
      overwriteGitfile(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);

      const got = worktreeResidue(tree);

      expect(got.paths).toEqual([]);
      // Inside a mount the common-dir gate answers this shape first, and with
      // the more useful reason: it says what the pointer IS (the repository's
      // own common dir) rather than what the entry behind it lacks.
      expect(got.unmeasured).toContain('common dir');
    },
  );

  it('says UNMEASURED for that swap outside a mount, where no location gate speaks', () => {
    // The identity gate's own reason is what answers where the location gates
    // say nothing — outside a mount, where the same swap is a stale pointer
    // rather than a plantable one, and on Windows, where `mountRootFor`
    // refuses every absolute path and the gated case above takes this route.
    // A main checkout has no `gitdir` file to "not point back", and the
    // triager hunting one is the confusion the distinct message exists to
    // spare.
    const outside = join(repo, 'wt-outside');
    gitRepo('worktree', 'add', '--detach', '-q', outside, 'HEAD');
    gitRepo('config', 'core.worktree', outside);
    overwriteGitfile(join(outside, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    expect(worktreeResidue(outside).unmeasured).toContain('no admin entry');
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
    overwriteGitfile(join(tree, '.git'), `gitdir: ${admin}\n`);

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
    // self-equality would pass while the round trip catches the borrow. Inside
    // a mount the LOCATION gate's own round-trip (`untrustedPointer`, R23-2)
    // speaks first; this residue's identical check stays the answer outside
    // one. Either way the verdict is a refusal, and removing the round trip
    // from both layers turns this red — measured, the gate then passes and
    // certifies a tree measured against the sibling's index.
    const sibling = join(repo, '.qwen', 'tmp', 'sibling-wt');
    gitRepo('worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    const admin = readFileSync(join(sibling, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    overwriteGitfile(join(tree, '.git'), `gitdir: ${admin}\n`);

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toMatch(
      /does not point back|a different tree's admin entry/,
    );
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
      // The location gate answers this shape FIRST now: a symlinked
      // `.qwen/tmp` is a REFUSED mount, and "inside the review temp dir by
      // spelling with no mount root" fails closed — reading the refusal as
      // "nothing to police" was the fail-open inversion that let the
      // measurement run through the redirect. (The walk below refuses it
      // too, one check later; the intermediate-ancestor case keeps that arm
      // witnessed, where the mount answers and only the walk can see the
      // link.)
      expect(got.unmeasured).toContain('review temp dir');
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
    // The walk's own witness. The sibling redirect shape (a link AT
    // `.qwen/tmp`) is now refused by the location gate before the walk runs —
    // a refused mount fails closed — and the leaf-link shape refuses at the
    // leaf lstat. What remains the walk's alone is a link BETWEEN the mount
    // root and the leaf: `.qwen/tmp` itself stays real, so the mount answers
    // and the gate passes, and deleting the walk turns this test red. The
    // shape passes every other check: the leaf is a real directory, the
    // self-equality holds because both sides resolve through the same link,
    // and the moved tree's gitfile still names the REAL repo's admin entry,
    // so the common dir is the repo and the tree's literal path runs under
    // it. Only the walk can refuse it.
    expect(worktreeResidue(tree, 12, git('rev-parse', 'HEAD'))).toEqual({
      paths: [],
      total: 0,
    });

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-walk-')));
    try {
      // Move the worktree out and re-hang it one level deeper, behind a link
      // planted INSIDE the mount. The moved tree keeps naming its original
      // admin entry — spelled absolutely, because its old relative spelling
      // no longer resolves from outside the repo — and the entry's own
      // backpointer is updated to the moved tree, so the location gate's
      // round trip agrees and only the walk can see the link. (Without that
      // update the gate refuses first — an owner it cannot resolve does not
      // point back — and the walk's arm loses its witness.)
      renameSync(tree, join(outside, 'review-wt'));
      overwriteGitfile(
        join(outside, 'review-wt', '.git'),
        `gitdir: ${join(repo, '.git', 'worktrees', 'review-wt')}\n`,
      );
      writeFileSync(
        join(repo, '.git', 'worktrees', 'review-wt', 'gitdir'),
        `${join(outside, 'review-wt', '.git')}\n`,
      );
      symlinkSync(outside, join(dirname(tree), 'link'));
      const spelled = join(dirname(tree), 'link', 'review-wt');

      const got = worktreeResidue(spelled);

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

  it.skipIf(process.platform === 'win32')(
    'says UNMEASURED when the location gate cannot resolve, and never reaches status',
    () => {
      // The gate above asks `rev-parse --absolute-git-dir` and read EVERY null
      // as "no objection" — so a git that timed out, failed to spawn, or died
      // on any other fatal fell through to the `status` below, which refreshes
      // the index and runs whatever clean filter the resolved repository
      // configures. Its own 30s budget is a quarter of the protected
      // commands' and the spawns below carry none at all, so a config sized
      // between the two was measured reaching host-side filter execution.
      // Only that one call is broken here: the shim proves the rest of the
      // probe still answers, so the verdict comes from this gate and not from
      // a repo the test broke wholesale.
      const shim = mkdtempSync(join(tmpdir(), 'qwen-git-shim-'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      const statusRan = join(shim, 'status-ran');
      writeFileSync(
        join(shim, 'git'),
        `#!/bin/sh\nfor a in "$@"; do\n  [ "$a" = --absolute-git-dir ] && { echo "fatal: simulated config parse failure" >&2; exit 128; }\n  [ "$a" = status ] && echo x >> "${statusRan}"\ndone\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      process.env['PATH'] = `${shim}:${realPath}`;

      const got = worktreeResidue(tree);

      expect(got.paths).toEqual([]);
      expect(got.unmeasured).toContain('could not resolve its own git dir');
      // The point of failing closed, and the half a message assertion cannot
      // show: the measurement that would have run the plant's filter never ran.
      expect(existsSync(statusRan)).toBe(false);
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

  it('sweeps the registration git counter-suffixed on a basename collision (R32-12)', () => {
    // `get_preferred_worktree_name` appends a counter whenever
    // `<common>/worktrees/<basename>` is already taken, so two trees sharing
    // a basename register as `wt` and `wt1` — the shape the nested/dogfood
    // geometry produces (an inner review's `review-pr-N` beside the outer
    // one), and one a leftover from a crashed run makes MORE likely, not
    // less. Narrowing the reverse scan to the bare basename skipped `wt1`,
    // the entry this tree actually owns, leaving it behind after `rmSync`
    // had taken the directory: the "missing but already registered" wedge
    // this function exists to prevent, and one re-running cleanup cannot
    // clear.
    const first = join(repo, 'a', 'wt');
    const second = join(repo, 'b', 'wt');
    git(repo, 'worktree', 'add', '--detach', '-q', first, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '-q', second, 'HEAD');
    const common = git(
      repo,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    // The premise, pinned rather than assumed: git really did suffix the id,
    // so this case is about the scan's grammar and not about the fixture.
    expect(readdirSync(join(common, 'worktrees')).sort()).toEqual([
      'wt',
      'wt1',
    ]);
    // The shape the reverse scan exists for: the tree's own pointer is
    // unreadable, so `adminDirOf` answers null and `worktree remove` fails.
    writeFileSync(join(second, '.git'), 'not a gitfile\n');

    discardWorktree(repo, second);

    // Its own registration is gone; the sibling that legitimately holds the
    // bare basename is untouched...
    expect(readdirSync(join(common, 'worktrees'))).toEqual(['wt']);
    // ...and the path is reusable, which is what the wedge took away.
    expect(() =>
      git(repo, 'worktree', 'add', '--detach', '-q', second, 'HEAD'),
    ).not.toThrow();
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

describe('filterCommandsIn — the include walk', () => {
  // The screen read directly, on config files git never opens as a
  // repository: what git refuses outright (a directory or an unparsable
  // include target is `fatal: bad config line` for EVERY git command in
  // that repository, measured) cannot reach the screen through a
  // repository, so the screen's own fail-closed answers for those targets
  // are pinned here, beside the expansions it must make.
  let dir: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-filter-screen-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('follows an include relative to the INCLUDING file and reports what it delivers', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(
      join(dir, 'sub', 'payload.cfg'),
      '[filter "evil"]\n\tprocess = evil-filter\n',
    );
    writeFileSync(join(dir, 'config'), '[include]\n\tpath = sub/payload.cfg\n');
    expect(filterCommandsIn(dir, dir)).toEqual({
      filters: ['filter.evil.process'],
      exempt: [],
      unread: [],
      dangling: [],
    });
  });

  it('exempts an exact global-config origin, but not a repo-controlled alias to it', () => {
    const globalConfig = join(gitIsolation.home, '.gitconfig');
    writeFileSync(
      globalConfig,
      '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n' +
        '[include]\n\tpath = /missing/user-owned.cfg\n',
    );
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${globalConfig}\n`);
    const exact = filterCommandsIn(dir, dir);
    expect(exact.filters).toEqual([]);
    expect(exact.exempt).toEqual(['filter.lfs.clean']);
    expect(exact.dangling).toEqual([]);

    // Canonical target equality is not enough: a path the repository controls
    // can be repointed after the screen. Only the spelling Git reaches through
    // the user's own config graph is the user's contract.
    const alias = join(dir, 'global-alias.cfg');
    symlinkSync(globalConfig, alias);
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${alias}\n`);
    expect(filterCommandsIn(dir, dir).filters).toEqual(['filter.lfs.clean']);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a POSIX backslash distinct from the global-config separator spelling',
    () => {
      const xdgConfig = join(gitIsolation.home, '.config', 'git', 'config');
      mkdirSync(dirname(xdgConfig), { recursive: true });
      writeFileSync(xdgConfig, '[filter "lfs"]\n\tclean = git-lfs clean\n');
      const payload = join(gitIsolation.home, '.config', 'git\\config');
      writeFileSync(payload, '[filter "lfs"]\n\tclean = evil-clean\n');
      execFileSync('git', [
        'config',
        '--file',
        join(dir, 'config'),
        'include.path',
        payload,
      ]);

      expect(filterCommandsIn(dir, dir).filters).toEqual(['filter.lfs.clean']);
    },
  );

  it('recognises the XDG global config as a user-owned origin', () => {
    const xdgConfig = join(gitIsolation.home, '.config', 'git', 'config');
    mkdirSync(dirname(xdgConfig), { recursive: true });
    writeFileSync(xdgConfig, '[filter "xdg"]\n\tsmudge = xdg-filter\n');
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${xdgConfig}\n`);

    expect(filterCommandsIn(dir, dir).filters).toEqual([]);
  });

  it('follows includes in the active global graph before exempting an origin', () => {
    const included = join(gitIsolation.home, 'filters.inc');
    writeFileSync(included, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      `[include]\n\tpath = ${included}\n`,
    );
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${included}\n`);

    expect(filterCommandsIn(dir, dir).filters).toEqual([]);
  });

  it('does not trust a source behind an inactive global includeIf', () => {
    const payload = join(gitIsolation.home, 'conditional.cfg');
    writeFileSync(payload, '[filter "conditional"]\n\tclean = cat\n');
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      `[includeIf "gitdir:/does-not-match/"]\n\tpath = ${payload}\n`,
    );
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${payload}\n`);

    expect(filterCommandsIn(dir, dir).filters).toEqual([
      'filter.conditional.clean',
    ]);
  });

  it('evaluates global includeIf against the linked tree and rejects repo-owned origins', () => {
    const repo = join(dir, 'repo');
    const tree = join(dir, 'linked');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    git(repo, 'worktree', 'add', '--detach', '-q', tree, 'HEAD');
    const commonDir = git(
      tree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    const gitDir = git(
      tree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    const userFilter = join(gitIsolation.home, 'user-filter.cfg');
    writeFileSync(userFilter, '[filter "user"]\n\tclean = cat\n');
    git(repo, 'config', 'include.path', userFilter);
    const globalIncludeIf = (condition: string, target: string) =>
      `[includeIf ${JSON.stringify(condition)}]\n` +
      `\tpath = ${JSON.stringify(target)}\n`;

    // This condition holds in the main checkout but not in the linked tree.
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      globalIncludeIf(`gitdir:${join(repo, '.git')}`, userFilter),
    );
    expect(filterCommandsIn(commonDir, gitDir).filters).toEqual([
      'filter.user.clean',
    ]);

    // A directory condition active for both trees grants the user-owned file.
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      globalIncludeIf(`gitdir:${dir}/`, userFilter),
    );
    expect(filterCommandsIn(commonDir, gitDir).filters).toEqual([]);

    // Scope alone is insufficient: an active global include can point back
    // into content controlled by the reviewed repository.
    const trackedFilter = join(repo, 'shared-filter.cfg');
    writeFileSync(trackedFilter, '[filter "tracked"]\n\tclean = cat\n');
    git(repo, 'add', 'shared-filter.cfg');
    git(repo, 'commit', '-qm', 'tracked filter fixture');
    git(repo, 'config', '--replace-all', 'include.path', trackedFilter);
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      globalIncludeIf(`gitdir:${dir}/`, trackedFilter),
    );
    expect(filterCommandsIn(commonDir, gitDir).filters).toEqual([
      'filter.tracked.clean',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'accounts for a failed global/system origin read',
    () => {
      const globalConfig = join(gitIsolation.home, '.gitconfig');
      writeFileSync(globalConfig, '[filter "lfs"]\n\tclean = cat\n');
      writeFileSync(
        join(dir, 'config'),
        `[include]\n\tpath = ${globalConfig}\n`,
      );
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = join(dir, 'shim');
      mkdirSync(shimDir);
      const shim = join(shimDir, 'git');
      writeFileSync(
        shim,
        '#!/bin/sh\n' +
          'for arg do\n' +
          '  [ "$arg" = "--show-scope" ] && exit 129\n' +
          'done\n' +
          `exec ${JSON.stringify(realGit)} "$@"\n`,
      );
      chmodSync(shim, 0o755);
      const savedPath = process.env['PATH'];
      try {
        process.env['PATH'] = `${shimDir}:${savedPath ?? ''}`;
        const screen = filterCommandsIn(dir, dir);
        expect(screen.filters).toEqual(['filter.lfs.clean']);
        expect(screen.unread.join(' ')).toContain('git config exited 129');
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
      }
    },
  );

  it('parses system-scope origins through the same trusted-record seam', () => {
    const systemConfig =
      process.platform === 'win32'
        ? 'C:/ProgramData/Git/config'
        : '/etc/gitconfig';
    expect(
      parseTrustedConfigRecords(
        `system\0file:${systemConfig}\0filter.lfs.clean\ngit-lfs clean\0`,
      ),
    ).toEqual([
      {
        scope: 'system',
        file: systemConfig,
        key: 'filter.lfs.clean',
      },
    ]);
  });

  it('names a relocated XDG global slot that the sanitized read cannot attribute', () => {
    const xdg = join(gitIsolation.home, 'relocated-xdg');
    const xdgConfig = join(xdg, 'git', 'config');
    mkdirSync(dirname(xdgConfig), { recursive: true });
    writeFileSync(xdgConfig, '[filter "xdg"]\n\tclean = cat\n');
    writeFileSync(join(dir, 'config'), `[include]\n\tpath = ${xdgConfig}\n`);
    const saved = process.env['XDG_CONFIG_HOME'];
    try {
      process.env['XDG_CONFIG_HOME'] = xdg;
      const screen = filterCommandsIn(dir, dir);
      expect(screen.filters).toEqual(['filter.xdg.clean']);
      expect(screen.unread.join(' ')).toContain('relocated XDG global config');
    } finally {
      if (saved === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = saved;
    }
  });

  it('resolves a relative include against the path git OPENED, not its realpath', () => {
    // git resolves a relative include against the including file's spelled
    // path: a symlinked `.git/config` includes beside the LINK. A walk that
    // resolved against the realpath read a different (clean) file than the
    // one git executes — measured with the real function.
    const elsewhere = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-filter-screen-else-')),
    );
    try {
      writeFileSync(join(elsewhere, 'cfg'), '[include]\n\tpath = inc\n');
      writeFileSync(
        join(elsewhere, 'inc'),
        '[filter "decoy"]\n\tclean = cat\n',
      );
      writeFileSync(join(dir, 'inc'), '[filter "evil"]\n\tclean = cat\n');
      symlinkSync(join(elsewhere, 'cfg'), join(dir, 'config'));
      expect(filterCommandsIn(dir, dir)).toEqual({
        filters: ['filter.evil.clean'],
        exempt: [],
        unread: [],
        dangling: [],
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reads with the common dir as cwd, so a target outside the repository never triggers discovery there', () => {
    // An include target beside a dangling gitfile made `git config --file`
    // discover a repository in that foreign directory and exit 128 — a
    // false "could not be read" over a file that defines no filter at all.
    const elsewhere = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-filter-screen-foreign-')),
    );
    try {
      writeFileSync(join(elsewhere, '.git'), 'gitdir: /nowhere/at/all\n');
      writeFileSync(join(elsewhere, 'x.cfg'), '[filter "x"]\n\tclean = cat\n');
      writeFileSync(
        join(dir, 'config'),
        `[include]\n\tpath = ${join(elsewhere, 'x.cfg')}\n`,
      );
      expect(filterCommandsIn(dir, dir)).toEqual({
        filters: ['filter.x.clean'],
        exempt: [],
        unread: [],
        dangling: [],
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('expands ~/ against the home directory, and follows an includeIf whose condition is false', () => {
    // The screen answers what the file CAN deliver: an `includeIf` whose
    // `gitdir:` holds nowhere today is one `git init` away from holding.
    writeFileSync(
      join(gitIsolation.home, 'inc.cfg'),
      '[filter "home"]\n\tclean = cat\n',
    );
    writeFileSync(
      join(dir, 'config'),
      '[includeIf "gitdir:/nowhere/"]\n\tpath = ~/inc.cfg\n',
    );
    expect(filterCommandsIn(dir, dir)).toEqual({
      filters: ['filter.home.clean'],
      exempt: [],
      unread: [],
      dangling: [],
    });
  });

  it('refuses an include target that is not a regular file — git answers exit 1 for it, like "no match"', () => {
    // `git config --file <dir>` exits 1 with a `warning: unable to access`
    // (measured, git 2.47): the status alone cannot tell it from an empty
    // match, so the walk checks what git would open before it reads.
    mkdirSync(join(dir, 'a-directory.cfg'));
    writeFileSync(join(dir, 'config'), '[include]\n\tpath = a-directory.cfg\n');
    const { filters, unread } = filterCommandsIn(dir, dir);
    expect(filters).toEqual([]);
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain('a-directory.cfg');
  });

  it('refuses an include target git cannot parse', () => {
    writeFileSync(join(dir, 'broken.cfg'), 'garbage [[[ = \n');
    writeFileSync(join(dir, 'config'), '[include]\n\tpath = broken.cfg\n');
    const { filters, unread } = filterCommandsIn(dir, dir);
    expect(filters).toEqual([]);
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain('broken.cfg');
  });

  it("refuses another user's ~user/ target and a nesting past git's own limit", () => {
    writeFileSync(join(dir, 'config'), '[include]\n\tpath = ~nobody/x.cfg\n');
    expect(filterCommandsIn(dir, dir).unread.join(' ')).toContain(
      '~nobody/x.cfg',
    );
    // Twelve links deep: git itself dies at eleven (`exceeded maximum
    // include depth (10)`), so the walk refuses there instead of reading on.
    for (let i = 0; i <= 12; i++) {
      writeFileSync(
        join(dir, i === 0 ? 'config' : `d${i}.cfg`),
        `[include]\n\tpath = d${i + 1}.cfg\n`,
      );
    }
    writeFileSync(join(dir, 'd13.cfg'), '[filter "deep"]\n\tclean = cat\n');
    const deep = filterCommandsIn(dir, dir);
    expect(deep.unread.join(' ')).toContain("past git's include limit");
    expect(deep.filters).not.toContain('filter.deep.clean');
  });

  it('refuses an include fan-out past its file cap — the walk is planter-priced', () => {
    // N includes are N spawns; 2 000 held the walk for 29 s (measured).
    let lines = '';
    for (let i = 0; i < 70; i++) {
      writeFileSync(
        join(dir, `f${i}.cfg`),
        i === 0 ? '[filter "first"]\n\tclean = cat\n' : '',
      );
      lines += `\tpath = f${i}.cfg\n`;
    }
    writeFileSync(join(dir, 'config'), `[include]\n${lines}`);
    const { filters, unread } = filterCommandsIn(dir, dir);
    expect(filters).toEqual(['filter.first.clean']);
    expect(unread.join(' ')).toContain('fan-out past 64 files');
  });

  it('blanks every name it was handed through the env pair, `=` in a name included', () => {
    // `-c` splits at the first `=`, so a filter a planter named `a=b` cannot
    // be blanked by it; GIT_CONFIG_KEY_n/VALUE_n carry any name the config
    // parser accepts. Four keys per name: the three commands emptied and
    // `required` false, so an emptied REQUIRED filter (git-lfs's) skips
    // instead of failing the command.
    const env = filterBlankEnv(['filter.a=b.clean', 'filter.evil.process']);
    expect(env['GIT_CONFIG_COUNT']).toBe('8');
    expect(env['GIT_CONFIG_KEY_0']).toBe('filter.a=b.clean');
    expect(env['GIT_CONFIG_VALUE_0']).toBe('');
    expect(env['GIT_CONFIG_KEY_3']).toBe('filter.a=b.required');
    expect(env['GIT_CONFIG_VALUE_3']).toBe('false');
    expect(env['GIT_CONFIG_KEY_6']).toBe('filter.evil.process');
    expect(filterBlankEnv([])).toEqual({});
  });

  it('localFilterCommands: a discovery that fails is a hit, and a newline in the path does not mis-pair the dirs', () => {
    // The old wrapper answered `[]` — "no filters" — when rev-parse failed,
    // and split one newline-delimited answer for two flags, so a directory
    // named with a newline paired the wrong dirs and screened nothing.
    expect(localFilterCommands(dir).join(' ')).toContain(
      'could not be resolved',
    );
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-filter-nl-')));
    try {
      const repo = join(base, 'a\nb', 'repo');
      mkdirSync(repo, { recursive: true });
      const g = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.ts'), 'x\n');
      g('add', '-A');
      g('commit', '-qm', 'head');
      const wt = join(repo, '.qwen', 'tmp', 'wt');
      mkdirSync(dirname(wt), { recursive: true });
      g('worktree', 'add', '--detach', '-q', wt, 'HEAD');
      g('config', 'filter.evil.smudge', 'touch PWNED');
      expect(localFilterCommands(wt)).toEqual(['filter.evil.smudge']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('checkoutFilterCommands: a dangling include is not a hit, and localFilterCommands still reports it', () => {
    // The two consumers ask different questions and the difference IS the fix.
    // `actions/checkout` with persisted credentials writes `includeIf
    // "gitdir:…"` directives into the repository-local config whose target is a
    // per-job file, gone by the next job; on a persistent runner the directives
    // accumulate in a reused `.git/config`. git ignores a dangling include, so
    // a checkout the screen is about to authorise executes nothing from it —
    // while the residue measurement, which hands back a result the rest of the
    // review acts on, keeps refusing on it.
    //
    // Measured before this split: `localFilterCommands` returned 2 hits on a
    // repository defining NO content filter, so all four efficacy screens
    // refused and the phase shipped zero evidence while telling the reader the
    // repository "defines content filter(s)".
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-dangling-')));
    try {
      const repo = join(base, 'repo');
      mkdirSync(repo, { recursive: true });
      const g = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.ts'), 'x\n');
      g('add', '-A');
      g('commit', '-qm', 'head');
      // The runner's shape, both directives: the plain form and the wildcard
      // form git writes for linked worktrees. Neither condition can match this
      // tree, and that is deliberately NOT what the assertion turns on — the
      // screen does not evaluate includeIf conditions, because a match test
      // against only the screened tree's own gitdir would re-open the creation
      // path, where `worktree add` registers a NEW admin entry. What it asks is
      // whether the target exists.
      appendFileSync(
        join(repo, '.git', 'config'),
        '[includeIf "gitdir:/github/workspace/.git"]\n' +
          '\tpath = /github/runner_temp/git-credentials.config\n' +
          '[includeIf "gitdir:/github/workspace/.git/worktrees/*"]\n' +
          '\tpath = /github/runner_temp/git-credentials.config\n',
      );

      expect(checkoutFilterCommands(repo)).toEqual([]);
      // Unchanged for the consumer that refuses on any hit.
      expect(localFilterCommands(repo)).toHaveLength(2);
      expect(localFilterCommands(repo).join(' ')).toContain(
        'git-credentials.config',
      );
      // And the structured answer says which half they came from: nothing is
      // defined and nothing was unreadable, so both are `dangling`.
      const screen = filterCommandsIn(join(repo, '.git'), join(repo, '.git'));
      expect(screen.filters).toEqual([]);
      expect(screen.unread).toEqual([]);
      expect(screen.dangling).toHaveLength(2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('follows an include whose `..` the KERNEL resolves through a symlink, not lexically', () => {
    // `<dir>/link` is a symlink, and `include.path = link/../evil.cfg` names a
    // payload ONE LEVEL ABOVE the link's target. git concatenates and lets the
    // kernel resolve, so it reads that payload; a lexical collapse — `resolve()`
    // or `join()`, and plain `realpathSync` too, which normalizes before
    // consulting a symlink — looks for `<dir>/evil.cfg` instead, finds nothing,
    // and files a file git really reads as MISSING. Measured both ways: git's
    // own merged read lists the payload's `filter.evil.smudge` while the
    // collapsed walk answered `filters: []` with the payload in `dangling`, and
    // a restore-shaped checkout then executed it on the host.
    //
    // That is the entrance the `dangling` bucket opened. The divergence itself
    // predates it, but `unread` is refused by every consumer while `dangling`
    // is the one answer a checkout site may drop — so moving this case between
    // the two buckets is what turned a refusal into a certification of clean
    // over a filter nobody read.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-lexdiv-')));
    try {
      mkdirSync(join(outside, 'sub'), { recursive: true });
      writeFileSync(
        join(outside, 'evil.cfg'),
        '[filter "evil"]\n\tsmudge = cat\n',
      );
      symlinkSync(join(outside, 'sub'), join(dir, 'link'));
      writeFileSync(
        join(dir, 'config'),
        '[include]\n\tpath = link/../evil.cfg\n',
      );

      const screen = filterCommandsIn(dir, dir);
      expect(screen.filters).toEqual(['filter.evil.smudge']);
      // The point of the fix: this is NOT a missing target, so it must not land
      // in the one bucket a checkout site is allowed to drop.
      expect(screen.dangling).toEqual([]);
      expect(screen.unread).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('files a resolution failure that is NOT ENOENT as unread, so a checkout site refuses on it', () => {
    // `dangling` is the only answer a caller may drop, so ENOENT has to be the
    // only way in. The shape that decides it is `ENAMETOOLONG` — a short
    // spelled path whose RESOLVED path exceeds PATH_MAX, where `realpathSync`
    // throws and git still reads the file — but that fixture is PATH_MAX-sized
    // and so platform-sized (1024 on macOS, 4096 on Linux). This pins the errno
    // gate with a symlink loop instead: deterministic, and it fails resolution
    // for a reason that is not "absent". A bare `catch` here filed every errno
    // as missing, which is how the gate came to be load-bearing.
    symlinkSync('loop', join(dir, 'loop'));
    writeFileSync(join(dir, 'config'), '[include]\n\tpath = loop\n');

    const screen = filterCommandsIn(dir, dir);
    expect(screen.filters).toEqual([]);
    expect(screen.dangling).toEqual([]);
    expect(screen.unread).toHaveLength(1);
    expect(screen.unread[0]).toContain('could not be resolved');
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
      // The one config key with an environment spelling of its own: it
      // decides what a bare `git init` creates, and a sha256 store beside a
      // sha1 source cannot read the source's objects through an alternates
      // pointer.
      process.env['GIT_DEFAULT_HASH'] = 'sha256';
      process.env['GIT_CEILING_DIRECTORIES'] = '/tmp/elsewhere';
      process.env['PATH'] = saved['PATH'];

      const env = sanitizedGitEnv();

      for (const key of [
        'GIT_DIR',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_PARAMETERS',
        'GIT_DEFAULT_HASH',
        'GIT_CEILING_DIRECTORIES',
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

// Every case in this block builds a layout under `.qwen/tmp` and asks a
// question that only has an answer where containment can exist. On Windows
// `mountRootFor` refuses every absolute path (a drive letter is a colon), so
// the gate never speaks — and the fixtures cannot even be built there: a
// planted name carrying a drive letter mid-path is rejected by NTFS. Gated as
// a BLOCK, because gating case by case is how the same lane surfaced four
// times in this pull request.
describe('untrustedGitfile', () => {
  // Real git runs here, so the host's own config must not reach it — the same
  // isolation every other real-git describe in this file installs. Without it
  // a host carrying `commit.gpgsign=true` and no usable key fails the fixture
  // commit and the whole block goes red for a reason unrelated to the gate.
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
  });
  afterEach(() => gitIsolation.dispose());

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
   * nothing about either answer. `repo` is parameterised so one case can
   * build the same layout under a colon-bearing checkout (the POSIX spelling
   * of the Windows shape).
   */
  const pipelineTree = (repo: string = tmp()) => {
    mkdirSync(repo, { recursive: true });
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

  itWhereContainmentExists('ADMITS an intact pipeline gitfile', () => {
    // The admit path, which nothing exercised: every refusal case would also
    // refuse under a mutation that breaks the resolution, so only asserting
    // the admit tells a working gate from one that refuses everything.
    const { tree, mount } = pipelineTree();
    expect(untrustedGitfile(tree, mount)).toBeNull();
  });

  itWhereContainmentExists(
    'refuses a pointer git resolves INTO the mount, however it is spelled',
    () => {
      // Spelled with a non-breaking space, which JS `trim()` strips and git's
      // `read_gitfile` does not — the divergence that let the first cut resolve
      // the REAL entry, outside the mount, and admit a tree git resolves to a
      // planted one inside it. The gate asks git now, so the spelling stops
      // mattering: whatever git answers is what gets located.
      const { repo, tree, mount } = pipelineTree();
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );
      expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    "refuses a gitfile borrowing a SIBLING worktree's legitimate admin entry",
    () => {
      // The third shape (R23-2): the entry is REAL — outside the mount, so
      // the location question passes, and not the common dir, so the shape
      // question passes — but it belongs to a sibling, and every command
      // through it measures and mutates THAT tree. Only the entry's own
      // `gitdir` backpointer names its owner, so the round-trip is the arm
      // that speaks here: removed, this tree is admitted and the assertion
      // goes red.
      const { repo, tree, mount } = pipelineTree();
      const sibling = join(repo, '.qwen', 'tmp', 'review-pr-2');
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', sibling, 'HEAD'],
        {
          cwd: repo,
        },
      );
      const admin = readFileSync(join(sibling, '.git'), 'utf8')
        .trim()
        .replace(/^gitdir:\s*/, '');
      writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`);
      expect(untrustedGitfile(tree, mount)).toContain(
        "a different tree's admin entry",
      );
    },
  );

  itWhereRawByteNamesExist(
    'refuses a gitfile whose target git prints and JS cannot read alike (invalid UTF-8, R8-2)',
    () => {
      // The gitfile names a planted entry under a RAW 0xFF byte in its path.
      // Node's `encoding: 'utf8'` render of git's byte-exact answer maps that
      // byte to U+FFFD — and the decoy planted under the U+FFFD spelling, a
      // symlink to the tree's REAL admin entry (outside the mount), is what
      // the location question would then judge: outside, admitted, while
      // every gated command resolves the raw-byte plant inside the mount.
      // A lossy answer counts as not given, so the gate refuses; without the
      // U+FFFD guard every question below passes (the round-trip included —
      // the decoy's backpointer is the real entry's) and this returns null.
      const { repo, tree, mount } = pipelineTree();
      const tmpRoot = join(repo, '.qwen', 'tmp');
      const common = join(tmpRoot, '.evil-common');
      execFileSync('git', ['init', '-q', common]);
      const evil = Buffer.concat([
        Buffer.from(`${tmpRoot}/ent`),
        Buffer.from([0xff]),
        Buffer.from('ry'),
      ]);
      mkdirSync(evil);
      writeFileSync(
        Buffer.concat([evil, Buffer.from('/commondir')]),
        `${common}\n`,
      );
      const decoy = join(tmpRoot, 'ent�ry');
      symlinkSync(adminEntryOf(tree), decoy);
      writeFileSync(
        join(tree, '.git'),
        Buffer.concat([Buffer.from('gitdir: '), evil, Buffer.from('\n')]),
      );
      expect(untrustedGitfile(tree, mount)).toContain('could not resolve');
    },
  );

  itWhereContainmentExists(
    'refuses a `.git` that is not the pipeline gitfile at all',
    () => {
      // `rm .git && git init .` inside the mount: a repository of the writer's
      // own, which skips every gate written for the gitfile shape.
      const { tree, mount } = pipelineTree();
      rmSync(join(tree, '.git'), { force: true });
      execFileSync('git', ['init', '-q'], { cwd: tree });
      expect(untrustedGitfile(tree, mount)).toContain('not the gitfile');
    },
  );

  itWhereContainmentExists(
    'follows GIT through a spelling only git and JS read differently',
    () => {
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
      writeFileSync(join(planted, 'gitdir'), `${join(tree, '.git')}\n`);
      writeFileSync(join(tree, '.git'), `gitdir: \u00a0${real}\n`);

      // Node would resolve the real entry here; git resolves the planted one.
      expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    "takes git's answer unedited, trailing NBSP and all",
    () => {
      // The trap the ASK GIT fix walked back into: `.trim()` on git's stdout
      // removes U+00A0 too, so an entry whose directory NAME ends in one is
      // resolved by git with it and judged here without it — and a twin of
      // that name minus the character, symlinked outside the mount, is what
      // the judgment then lands on. Only the terminator may be stripped.
      const { repo, tree, mount } = pipelineTree();
      const twin = join(repo, '.qwen', 'tmp', 'entry');
      // The twin points OUTSIDE the mount; trimming the NBSP lands here.
      symlinkSync(repo, twin);
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', 'entry\u00a0'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );

      expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    "takes git's answer unedited, trailing CR and all",
    () => {
      // The NBSP trap's sibling, one regex character away: `/\r?\n$/` also
      // removes a `\r` that is the LAST BYTE OF THE PATH ITSELF, and git
      // plumbing terminates with `\n` on every platform — so the plant
      // `entry\r` was judged at its twin `entry`, symlinked outside the
      // mount, and admitted while every gated command resolved through the
      // plant. The gitfile's trailing `/` is load-bearing: git trims C-locale
      // whitespace off a gitdir line, which would eat the `\r` first.
      const { repo, tree, mount } = pipelineTree();
      const planted = join(repo, '.qwen', 'tmp', 'entry\r');
      // The twin points OUTSIDE the mount; stripping the CR lands here.
      symlinkSync(repo, join(repo, '.qwen', 'tmp', 'entry'));
      plantAdminEntry(planted, adminEntryOf(tree), tree, join(repo, '.git'));
      overwriteGitfile(join(tree, '.git'), `gitdir: ${planted}/\n`);

      expect(untrustedGitfile(tree, mount)).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    'lets a SUBDIRECTORY of a mounted checkout resolve the way git does',
    () => {
      // The geometry my own checkout hid: a review running inside a review
      // worktree launches from, say, `<tree>/packages/cli`, which has no
      // `.git` of its own — git walks up. Demanding one there refused every
      // worktree creation in that geometry, and a repository NOT under
      // `.qwen/tmp` (mine) never reaches the question at all, so the suite
      // stayed green while the pipeline's own dogfood lane broke.
      const { tree, mount } = pipelineTree();
      const sub = join(tree, 'packages', 'cli');
      mkdirSync(sub, { recursive: true });
      expect(untrustedRepositoryFrom(sub, mount)).toBeNull();
    },
  );

  itWhereContainmentExists(
    'refuses a launch directory git could not be run in, and passes one that is no repository',
    () => {
      // A directory that genuinely is no repository keeps passing through —
      // refusing there would answer a question nobody asked, and the caller's
      // own error path owns it. Asserted BEFORE the shim, which cannot tell
      // the two apart.
      const nowhere = join(tmp(), 'nowhere');
      mkdirSync(nowhere, { recursive: true });
      expect(untrustedRepositoryFrom(nowhere, () => nowhere)).toBeNull();

      // Every OTHER null used to pass through as that same "not a repository":
      // a timeout, a spawn failure, any other fatal. This gate's budget is a
      // quarter of the protected commands' (`GIT_TIMEOUT_MS` in lib/git.ts), so
      // a planted config sized to parse between the two left the gate silent
      // while the command resolved through the pointer it never judged —
      // `untrustedGitfile` fails closed on the same null, which is what made
      // the asymmetry visible. Only `--absolute-git-dir` is broken here.
      const { tree, mount } = pipelineTree();
      const shim = mkdtempSync(join(tmpdir(), 'qwen-git-shim-'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shim, 'git'),
        `#!/bin/sh\nfor a in "$@"; do\n  [ "$a" = --absolute-git-dir ] && { echo "fatal: simulated config parse failure" >&2; exit 128; }\ndone\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${shim}:${savedPath}`;
      try {
        expect(untrustedRepositoryFrom(tree, mount)).toContain(
          'could not resolve its own git dir',
        );
      } finally {
        process.env['PATH'] = savedPath;
      }
    },
  );

  itWhereContainmentExists(
    'works where `realpathSync` carries no `.native`',
    () => {
      // A suite that mocks `node:fs.realpathSync` as a bare `vi.fn` gives it
      // no `.native`, and reaching through it threw a TypeError into the
      // fail-closed catch — refusing every worktree creation in any checkout
      // sitting under `.qwen/tmp`. Deleting the property here asks that shape
      // directly, because the suite that HAS the mock never reaches this gate
      // from an unmounted checkout.
      const { tree, mount } = pipelineTree();
      const holder = realpathSync as unknown as { native?: unknown };
      const saved = holder.native;
      delete holder.native;
      try {
        expect(untrustedGitfile(tree, mount)).toBeNull();
      } finally {
        holder.native = saved;
      }
    },
  );

  itWhereContainmentExists(
    'refuses a gitfile rewritten to the repository own common dir',
    () => {
      // The shape the location question cannot see: `gitdir: <repo>/.git`
      // resolves OUTSIDE the mount, so every gate that asked only where the
      // answer lives admitted it and then acted on the MAIN repository
      // through it. Measured at this head: `status` rewrote the main index and
      // `rev-parse HEAD` answered the main head, so the reads a review treats
      // as fact came from a tree nobody verified. No `worktree add` writes
      // that pointer — a linked worktree's admin entry is always
      // `<common>/worktrees/<id>` — which is what makes it answerable.
      const { repo, tree, mount } = pipelineTree();
      overwriteGitfile(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);

      expect(untrustedGitfile(tree, mount)).toContain('common dir');
      expect(untrustedRepositoryFrom(tree, mount)).toContain('common dir');
      // The residue probe is the route that was measured rewriting the main
      // index: `status` refreshes it, and a refresh runs the clean filter.
      expect(worktreeResidue(tree, 12).unmeasured).toContain('common dir');
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

  itWhereContainmentExists(
    'REFUSES a tree whose mount was refused — a refusal is not "nothing to police"',
    () => {
      // `mountRootFor`'s null is overloaded: "outside any temp dir" and
      // "inside one but REFUSED" were the same value, and every gate read
      // both as "nothing to police" — the fail-open inversion, measured
      // end-to-end with a symlinked `.qwen/tmp`. Lexically inside plus no
      // mount root is fail-closed, at each gate that consumes the mount.
      // Asked with the REAL `mountRootFor`, because an injected root can
      // only ever answer one of the two nulls.
      const { repo, tree } = pipelineTree();
      const elsewhere = join(repo, 'elsewhere');
      renameSync(join(repo, '.qwen', 'tmp'), elsewhere);
      symlinkSync(elsewhere, join(repo, '.qwen', 'tmp'));
      // The tree still resolves — through the link the mount refuses.
      expect(existsSync(tree)).toBe(true);
      expect(mountRootFor(tree)).toBeNull();
      expect(mountNullKind(tree)).toBe('refused');

      expect(untrustedGitfile(tree)).toContain('review temp dir');
      expect(untrustedRepositoryFrom(tree)).toContain('review temp dir');
      const residue = worktreeResidue(tree);
      expect(residue.paths).toEqual([]);
      expect(residue.unmeasured).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    'refuses a launch directory that no longer exists at its spelling inside the review temp dir',
    () => {
      // The rename attack's other half: `mv .qwen .qwen-real` from inside the
      // outer mount leaves the stale spelling matching lexically while the
      // directory is gone. "No objection" there is what the launch-dir memo
      // recorded TRUSTED over, so inside the spelling a non-existent cwd is
      // a refusal — while outside it absence stays the caller's own error
      // path, exactly as before.
      const { repo, mount } = pipelineTree();
      const gone = join(repo, '.qwen', 'tmp', 'review-pr-2');
      expect(untrustedRepositoryFrom(gone, mount)).toContain(
        'no directory exists',
      );
      expect(
        untrustedRepositoryFrom(join(repo, 'gone'), () => repo),
      ).toBeNull();
    },
  );

  itWhereContainmentExists(
    'stays SILENT where containment cannot exist — an unmountable spelling is not a refusal (R26-3)',
    () => {
      // A colon in a POSIX path is legal and rare; on Windows EVERY absolute
      // path carries one (a drive letter), which is why this fixture is the
      // Windows shape on a filesystem that can build it. The mount cannot be
      // spelled either way, so containment never existed there and the mount
      // is not a trust boundary: the review's phases ran as the host user all
      // along. The gates promise "nothing at all where containment cannot
      // exist" — reading this null as a refusal made every location gate
      // refuse unconditionally on Windows (measured: 43 red tests in the
      // scratch-tree and revert-hunk suites under the Windows model), with a
      // message byte-identical for honest and planted trees.
      const { tree } = pipelineTree(join(tmp(), 'my:checkout', 'repo'));
      expect(mountRootFor(tree)).toBeNull();
      expect(mountNullKind(tree)).toBe('unmountable');
      expect(mountNullKind(join(tmp(), 'nowhere'))).toBe('outside');

      // Silent from the real provider, and silent from an injected provider
      // answering null for the same unmountable spelling — the finding's own
      // acceptance shape.
      expect(untrustedGitfile(tree)).toBeNull();
      expect(untrustedGitfile(tree, () => null)).toBeNull();
      expect(untrustedRepositoryFrom(tree)).toBeNull();
      // And the probe measures the honest tree rather than reporting it
      // unmeasured forever.
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tree,
        encoding: 'utf8',
      }).trim();
      expect(worktreeResidue(tree, 12, head)).toEqual({ paths: [], total: 0 });
    },
  );

  itWhereContainmentExists(
    'judges the mount root the entrance observed — asked once, not re-asked mid-gate (R19-2)',
    () => {
      // `untrustedPointer` used to re-ask the mount question and read the
      // second null as "nothing to police": the identical filesystem state
      // was refused when steady and ADMITTED when the answer changed between
      // the two asks (measured: a mount that stops answering mid-gate turned
      // the refusal into an admission). The root the entrance observed is
      // threaded through now, so the flip is invisible to the gate — and the
      // single evaluation is asserted, because the re-ask was also a second
      // lstat walk per gate call.
      const { repo, tree, mount } = pipelineTree();
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );
      let calls = 0;
      const stopsAnswering = (_d: string) => {
        calls++;
        return calls === 1 ? mount() : null;
      };
      expect(untrustedGitfile(tree, stopsAnswering)).toContain(
        'review temp dir',
      );
      expect(calls).toBe(1);
    },
  );

  itWhereContainmentExists(
    'refuses when the mount is flipped to a redirect between the observation and the pointer check (R30-49)',
    () => {
      // The TOCTOU the threading closes: the entrance observes a healthy
      // root, and before the pointer check runs the outer mount's writer
      // renames `.qwen/tmp` away and stands a link up at its spelling. A
      // re-asked mount question answers null there, and a null read as
      // "nothing to police" admitted the planted entry the entrance had just
      // refused (measured: `status` through it ran the plant's clean
      // filter).
      const { repo, tree } = pipelineTree();
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );
      let flipped = false;
      const flippingMidCall = (d: string) => {
        const answer = mountRootFor(d);
        if (!flipped) {
          flipped = true;
          renameSync(
            join(repo, '.qwen', 'tmp'),
            join(repo, '.qwen', 'tmp-real'),
          );
          symlinkSync(
            join(repo, '.qwen', 'tmp-real'),
            join(repo, '.qwen', 'tmp'),
          );
        }
        return answer;
      };
      expect(untrustedGitfile(tree, flippingMidCall)).toContain(
        'review temp dir',
      );
    },
  );

  itWhereContainmentExists(
    'refuses a borrowed entry whose owner path resolves through a link planted inside the mount (R28-14)',
    () => {
      // The round trip canonicalised BOTH sides, so replacing the borrowed
      // sibling's tree with a link to THIS tree made the two agree — the
      // entry passed while every command through it wrote the sibling's
      // index (measured). The owner path lives inside the mount for every
      // tree this pipeline builds, so a symlink on the way to it is the
      // plant; it is refused before anything resolves through it.
      const { repo, tree, mount } = pipelineTree();
      const sibling = join(repo, '.qwen', 'tmp', 'review-pr-2');
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', sibling, 'HEAD'],
        {
          cwd: repo,
        },
      );
      const admin = adminEntryOf(sibling);
      rmSync(sibling, { recursive: true, force: true });
      symlinkSync(tree, sibling);
      overwriteGitfile(join(tree, '.git'), `gitdir: ${admin}\n`);
      // The fixture is the shape the finding measured: git still resolves
      // through the borrowed entry, so the gate — not git — is what refuses.
      expect(untrustedGitfile(tree, mount)).toContain(
        "a different tree's admin entry",
      );
      expect(untrustedRepositoryFrom(tree, mount)).toContain(
        "a different tree's admin entry",
      );
    },
  );

  itWhereContainmentExists(
    'refuses a borrowed entry whose owner tree is gone — an unresolvable backpointer fails closed (R30-48)',
    () => {
      // The round trip's other fail-open outcome: the borrowed sibling's
      // tree DELETED, so the owner the backpointer names cannot be resolved,
      // and the swallow returned "no objection" — while git keeps answering
      // through the entry (its index, its HEAD) with the owner gone
      // (measured). An owner that cannot be resolved does not point back at
      // this tree, the same decision the residue probe makes for the shape.
      const { repo, tree, mount } = pipelineTree();
      const sibling = join(repo, '.qwen', 'tmp', 'review-pr-2');
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', sibling, 'HEAD'],
        {
          cwd: repo,
        },
      );
      const admin = adminEntryOf(sibling);
      rmSync(sibling, { recursive: true, force: true });
      overwriteGitfile(join(tree, '.git'), `gitdir: ${admin}\n`);
      expect(untrustedGitfile(tree, mount)).toContain('does not point back');
      expect(untrustedRepositoryFrom(tree, mount)).toContain(
        'does not point back',
      );
    },
  );

  itWhereContainmentExists(
    'refuses a borrowed entry whose owner is relinked one LAYER UP in the nested geometry (R32-10)',
    () => {
      // R28-14's shape, moved one layer out. The containment test that gates
      // the `redirectedAncestor` walk was bounded by the DEEPEST review temp
      // root — the one `mountRootFor` cut the mount at — while the location
      // question two above is deliberately widened to the OUTERMOST. So a
      // sibling of the OUTER worktree, replaced by a link to this tree, sat
      // outside the containment test, the walk never ran, and the realpath
      // round trip agreed with the link and admitted the entry. The writer is
      // the one the widening exists for: the outer review's containerized
      // phase held the outer `.qwen/tmp` read-write.
      const { repo, tree: outer } = pipelineTree();
      const inner = join(outer, '.qwen', 'tmp', 'review-pr-2');
      mkdirSync(dirname(inner), { recursive: true });
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', inner, 'HEAD'],
        { cwd: outer },
      );
      // The mount root is the INNER layer's, which is what `mountRootFor`
      // answers for this tree — injected so the case is about the gate and
      // not the platform's mount arithmetic.
      const innerMount = () => join(outer, '.qwen', 'tmp');
      // The honest nested layout admits — without this control a gate that
      // refuses everything passes too.
      expect(untrustedGitfile(inner, innerMount)).toBeNull();

      // The sibling lives one layer UP, beside the OUTER worktree, and its
      // admin entry is legitimate.
      const upSibling = join(repo, '.qwen', 'tmp', 'review-pr-up');
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', upSibling, 'HEAD'],
        { cwd: repo },
      );
      const borrowed = adminEntryOf(upSibling);
      rmSync(upSibling, { recursive: true, force: true });
      symlinkSync(inner, upSibling);
      overwriteGitfile(join(inner, '.git'), `gitdir: ${borrowed}\n`);

      expect(untrustedGitfile(inner, innerMount)).toContain(
        "a different tree's admin entry",
      );
      expect(untrustedRepositoryFrom(inner, innerMount)).toContain(
        "a different tree's admin entry",
      );
    },
  );

  itWhereContainmentExists(
    'refuses when git cannot answer the common-dir question at all (R33-3)',
    () => {
      // Question 2 is the ONLY one of the three that sees `gitdir:
      // <repo>/.git`: question 1 passes (the entry is outside the mount) and
      // question 3 passes (a main repository has no `gitdir` backpointer to
      // read). Flattening the `RevParse` taxonomy made every no-answer from
      // that one spawn — a timeout, a spawn failure, a git too old for
      // `--path-format` — read as "no objection", so the pointer this
      // question exists to refuse was certified whenever git went quiet.
      const { repo, tree, mount } = pipelineTree();
      overwriteGitfile(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);
      // With git answering, the shape is refused by name.
      expect(untrustedGitfile(tree, mount)).toContain('own common dir');

      // The same pointer, with `--path-format` rejected the way git < 2.31
      // rejects it. `--absolute-git-dir` still answers, so question 1 runs
      // exactly as before and only question 2 goes quiet.
      const shimDir = join(repo, 'git-shim-old');
      mkdirSync(shimDir, { recursive: true });
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\n` +
          `for a in "$@"; do\n` +
          `  case "$a" in --path-format=*)\n` +
          `    echo "error: unknown option \\\`$a'" >&2; exit 129;; esac\n` +
          `done\n` +
          `exec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const savedPath = process.env['PATH'];
      try {
        process.env['PATH'] = `${shimDir}:${savedPath}`;
        // The premise, pinned rather than assumed: the shim really does
        // reject the one spawn while the other still answers — otherwise
        // this case would be green for the wrong reason.
        const askCommonDir = spawnSync(
          'git',
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          { cwd: tree, encoding: 'utf8' },
        );
        expect(askCommonDir.status).toBe(129);
        const askGitDir = spawnSync(
          'git',
          ['rev-parse', '--absolute-git-dir'],
          { cwd: tree, encoding: 'utf8' },
        );
        expect(askGitDir.status).toBe(0);
        expect(untrustedGitfile(tree, mount)).toContain(
          'could not resolve its own common dir',
        );
        expect(untrustedRepositoryFrom(tree, mount)).toContain(
          'could not resolve its own common dir',
        );
      } finally {
        process.env['PATH'] = savedPath;
      }
    },
  );

  itWhereContainmentExists(
    "refuses a gitfile borrowing the ENCLOSING review worktree's admin entry (R30-5)",
    () => {
      // The nested/dogfood geometry: the outer review worktree is an
      // ANCESTOR of the inner one, and the round trip's ancestor-tolerant
      // comparison admitted the inner tree's gitfile rewritten to the
      // outer's entry — after which every read answered out of the OUTER
      // tree's index (measured: a staged-only-in-outer file reported as the
      // inner tree's status). The comparison is exact now, against the tree
      // root `untrustedGitfile` knows and against git's own
      // `--show-toplevel` for a launch directory — which prints the tree the
      // gitfile sits in even through the borrow (measured), the one answer
      // the borrow cannot bring into agreement.
      const { tree: outer } = pipelineTree();
      const inner = join(outer, '.qwen', 'tmp', 'review-pr-2');
      mkdirSync(dirname(inner), { recursive: true });
      execFileSync(
        'git',
        ['worktree', 'add', '-q', '--detach', inner, 'HEAD'],
        {
          cwd: outer,
        },
      );
      // Injected roots, so the case is about the GATE and not the platform's
      // mount arithmetic — the nested real-root admit is the canary's.
      const outerMount = () => join(outer, '.qwen', 'tmp');
      // The honest nested layout admits — the control without which a
      // refuse-everything gate passes this test too.
      expect(untrustedGitfile(inner, outerMount)).toBeNull();
      expect(untrustedRepositoryFrom(inner, outerMount)).toBeNull();

      overwriteGitfile(join(inner, '.git'), `gitdir: ${adminEntryOf(outer)}\n`);
      expect(untrustedGitfile(inner, outerMount)).toContain(
        "a different tree's admin entry",
      );
      expect(untrustedRepositoryFrom(inner, outerMount)).toContain(
        "a different tree's admin entry",
      );
    },
  );
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
      adminEntryInsideReviewTmp(planted, join(repo, '.qwen', 'tmp'), tree),
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
    expect(adminEntryInsideReviewTmp(mount, mount, tree)).toBe(true);
    expect(adminEntryInsideReviewTmp(oddly, mount, tree)).toBe(true);
    // ...while a genuine sibling of the mount is still outside.
    const outside = join(repo, '.qwen', 'review-leases');
    mkdirSync(outside, { recursive: true });
    expect(adminEntryInsideReviewTmp(outside, mount, tree)).toBe(false);
  });

  it('admits the real admin entry, which lives under the repository git dir', () => {
    const repo = tmp();
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1-probe');
    const real = join(repo, '.git', 'worktrees', 'review-pr-1-probe');
    mkdirSync(tree, { recursive: true });
    mkdirSync(real, { recursive: true });
    expect(
      adminEntryInsideReviewTmp(real, join(repo, '.qwen', 'tmp'), tree),
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
        join(repo, '.qwen', 'tmp'),
        tree,
      ),
    ).toBe(true);
  });

  it('has nothing to say about a tree outside any mounted directory', () => {
    // A local checkout is never mounted, so there is no writable surface for
    // this question to be about — and answering `true` there would refuse
    // every ordinary repository.
    const repo = tmp();
    expect(adminEntryInsideReviewTmp(repo, null, repo)).toBe(false);
  });

  itWhereContainmentExists(
    'fails closed on a REFUSED mount root, and stays silent on an unmountable one',
    () => {
      // The threaded null is the entrance's observation, and its kind decides
      // (R19-2): a redirect the entrance failed closed on is not "nothing to
      // police" here either — but where containment cannot exist (the
      // colon-bearing spelling standing in for Windows, which NTFS could not
      // even create — hence the block gate) the mount is no trust boundary,
      // and the question stays silent. The refused arm is a REAL refused
      // mount — a link stood up at `.qwen/tmp` — because the kind is
      // re-derived from the filesystem, not from the null alone.
      const repo = tmp();
      const tree = join(repo, '.qwen', 'tmp', 'review-pr-1-probe');
      mkdirSync(tree, { recursive: true });
      // A REAL refused mount: `.qwen/tmp` renamed aside and re-stood-up as a
      // link — the refusal kind survives a colon-bearing TMPDIR, where a
      // plain fixture would read as unmountable instead.
      renameSync(join(repo, '.qwen', 'tmp'), join(repo, '.qwen', 'tmp-real'));
      symlinkSync(join(repo, '.qwen', 'tmp-real'), join(repo, '.qwen', 'tmp'));
      expect(adminEntryInsideReviewTmp(repo, null, tree)).toBe(true);
      const colon = join(tmp(), 'my:checkout');
      const colonTree = join(colon, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(colonTree, { recursive: true });
      expect(adminEntryInsideReviewTmp(repo, null, colonTree)).toBe(false);
    },
  );
});

describe('unmountableRootSpelling', () => {
  it('refuses the drive-letter colon AND the colon-less UNC shape, and mounts a POSIX root', () => {
    // Pure cases, because a UNC path cannot be constructed off Windows and a
    // colon in a repository name is legal but rare: the refusal class is
    // pinned arm by arm here. Removing the colon arm turns the first and
    // third cases red; removing the UNC arm turns the second.
    expect(unmountableRootSpelling('C:\\repo\\.qwen\\tmp')).toBe(true);
    expect(unmountableRootSpelling('\\\\server\\share\\repo\\.qwen\\tmp')).toBe(
      true,
    );
    expect(unmountableRootSpelling('/repo/my:checkout/.qwen/tmp')).toBe(true);
    expect(unmountableRootSpelling('/repo/.qwen/tmp')).toBe(false);
  });
});

describe('insideReviewTmpLexically', () => {
  it('answers containment from the spelling alone, for a path nothing created', () => {
    // NO filesystem access is the whole point: the gates pair this with
    // `mountRootFor`'s overloaded null to tell "outside any temp dir" from
    // "inside one, but refused" without paying a syscall outside.
    const base = join(tmpdir(), 'qwen-lexical-no-such');
    expect(insideReviewTmpLexically(join(base, '.qwen', 'tmp', 'wt'))).toBe(
      true,
    );
    // The review temp dir ITSELF is inside, matching `mountRootFor`'s
    // `+ sep`.
    expect(insideReviewTmpLexically(join(base, '.qwen', 'tmp'))).toBe(true);
    expect(insideReviewTmpLexically(join(base, 'checkout'))).toBe(false);
    // A marker that is not a whole component is not containment.
    expect(insideReviewTmpLexically(join(base, '.qwen', 'tmpl'))).toBe(false);
  });
});

describe('mountRootFor — the walk bound is geometry-aware', () => {
  const made: string[] = [];
  const tmp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-bound-')));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  itWhereContainmentExists(
    'mounts nothing — and refuses — when `.qwen` links at a directory with no `tmp` inside',
    () => {
      // The walk's old blanket catch read a leaf ENOENT as "nothing above to
      // redirect through": with `.qwen` a symlink to a directory lacking
      // `tmp`, lstatSync('<repo>/.qwen/tmp') throws before `.qwen` itself is
      // ever lstat'd, so the walk answered null — and everything built under
      // the link's target (mkdirSync through it, the checkout into it) was
      // the fetch-pr R27-9 gate's exact prey. The walk now keeps climbing on
      // a nonexistent component.
      const anchor = tmp();
      const elsewhere = tmp(); // a real directory WITHOUT `tmp` inside
      const repo = join(anchor, 'repo');
      mkdirSync(repo);
      symlinkSync(elsewhere, join(repo, '.qwen'));
      expect(redirectedAncestor(join(repo, '.qwen', 'tmp'))).toBe(
        join(repo, '.qwen'),
      );
      expect(
        mountRootFor(join(repo, '.qwen', 'tmp', 'review-pr-1')),
      ).toBeNull();
    },
  );

  itWhereContainmentExists(
    'mounts a checkout whose DIRECT parent is a symlink',
    () => {
      // The bound used to sit one component ABOVE the checkout, and
      // `redirectedAncestor` lstats the stop directory before the stop test
      // fires — so a link at the checkout's direct parent (a checkout one
      // hop below a linked directory) was read as a redirect in a path the
      // pipeline owns, and `--sandbox=auto` silently degraded to unsandboxed
      // execution over the false refusal. Bounded at `.qwen`, the walk never
      // looks at the checkout's own spelling or the user's layout above it.
      const anchor = tmp();
      const realParent = tmp();
      symlinkSync(realParent, join(anchor, 'link'));
      const repo = join(anchor, 'link', 'repo');
      const tree = join(repo, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(tree, { recursive: true });
      expect(mountRootFor(tree)).toBe(realpathSync(join(repo, '.qwen', 'tmp')));
    },
  );

  itWhereContainmentExists(
    'mounts a checkout whose OWN directory is a symlink — the link-spelled --tree',
    () => {
      // One component closer than the case above: the checkout ITSELF is the
      // link (a `current -> release-N` layout, a shell's logical $PWD), and a
      // `--tree` argument typed through it keeps the spelling — `resolve` is
      // purely lexical, so nothing canonicalises it away. `redirectedAncestor`
      // lstats the stop directory before the stop test fires, so a bound AT
      // the repository root read the checkout's own link as a redirect and
      // refused every healthy tree addressed through it (measured: the same
      // input applied on the base and refused on the PR). The mount answer is
      // canonicalised by `realpathSync`, so the link redirects nothing the
      // mount trusts — the bound stops one component below the checkout, and
      // `.qwen` stays inside the walk.
      const anchor = tmp();
      const real = join(anchor, 'repo');
      const tree = join(real, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(tree, { recursive: true });
      symlinkSync(real, join(anchor, 'qwen-link'));
      const spelled = join(anchor, 'qwen-link', '.qwen', 'tmp', 'review-pr-1');
      expect(mountRootFor(spelled)).toBe(
        realpathSync(join(real, '.qwen', 'tmp')),
      );
      // ...and a link AT `.qwen` through the same spelling still refuses:
      // the narrowing stops at the checkout, not below it.
      const second = join(anchor, 'repo2');
      mkdirSync(join(second, '.qwen'), { recursive: true });
      const elsewhere = tmp();
      symlinkSync(elsewhere, join(second, '.qwen', 'tmp'));
      expect(
        mountRootFor(join(second, '.qwen', 'tmp', 'review-pr-1')),
      ).toBeNull();
    },
  );

  itWhereContainmentExists(
    'still refuses a NESTED root whose OUTER review temp dir is a symlink',
    () => {
      // The nested bound is the outermost enclosing review temp root, and it
      // stays INSIDE the walk: the outer review's containerized phase held
      // that directory read-write, so a link planted there is a redirect in
      // a writable surface, not the user's own layout.
      const anchor = tmp();
      const elsewhere = tmp();
      mkdirSync(join(elsewhere, 'tmp', 'outer-wt', '.qwen', 'tmp', 'wt2'), {
        recursive: true,
      });
      const repo = join(anchor, 'repo');
      mkdirSync(join(repo, '.qwen'), { recursive: true });
      symlinkSync(join(elsewhere, 'tmp'), join(repo, '.qwen', 'tmp'));
      const inner = join(repo, '.qwen', 'tmp', 'outer-wt', '.qwen', 'tmp');
      expect(mountRootFor(join(inner, 'wt2'))).toBeNull();

      // ...and the same nested shape without the link mounts at the DEEPEST
      // temp dir, so the refusal is about the redirect and not the geometry.
      const honest = tmp();
      const honestInner = join(
        honest,
        '.qwen',
        'tmp',
        'outer-wt',
        '.qwen',
        'tmp',
      );
      mkdirSync(join(honestInner, 'wt2'), { recursive: true });
      expect(mountRootFor(join(honestInner, 'wt2'))).toBe(
        realpathSync(honestInner),
      );
    },
  );
});
