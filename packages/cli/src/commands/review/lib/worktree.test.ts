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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isolateHostGitConfig } from './test-utils.js';

// Every spawnSync argv + options, recorded: the pinned discard's spawns must
// carry the pipeline deadline, and a refactor that drops one re-opens the
// wedge class this round closes while every behavioural shape stays green.
// The wrapper is a pure pass-through.
const spawnLog = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; options: unknown }>,
}));
// Child-process wedge probes resolve the module under test from the package
// root, the way the screen's FIFO probe does.
const moduleRequire = createRequire(import.meta.url);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const realSpawnSync = actual.spawnSync;
  const wrapper = (...callArgs: Parameters<typeof realSpawnSync>) => {
    const args = callArgs[1];
    if (Array.isArray(args)) {
      spawnLog.calls.push({ args: args.map(String), options: callArgs[2] });
    }
    return realSpawnSync(...callArgs);
  };
  return {
    ...actual,
    // `default` is load-bearing: CJS-interop imports of the builtin resolve
    // through it (the same shape scratch-tree.test.ts uses), and without it
    // the transitive modules silently keep the real spawnSync.
    default: { ...actual, spawnSync: wrapper },
    spawnSync: wrapper,
  };
});
import {
  discardWorktree,
  exposeDependencies,
  localFilterCommands,
  samePath,
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
    const got = worktreeResidue(tree);
    expect(got.paths).toEqual([]);
    expect(got.total).toBe(0);
    expect(got.unmeasured).toBeUndefined();
    // The identity the gate verified rides with a measured tree: the
    // caller that CREATES from it runs the creation under this entry,
    // never re-discovering through the writable gitfile.
    expect(got.verifiedGitDir).toBe(
      realpathSync(git('rev-parse', '--path-format=absolute', '--git-dir')),
    );
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
    const got = worktreeResidue(tree);
    expect(got.paths).toEqual([]);
    expect(got.total).toBe(0);
  });

  it('never executes core.fsmonitor in the attribution spawns — the measurement must not become the execution', () => {
    // The residue probe empties `core.fsmonitor` on its measurement spawns,
    // but the two reconciliation spawns it edits — `check-ignore` and the
    // tracked-source `ls-files` — run against the same writable config, and
    // git executes the monitor for both commands (measured). Extras are
    // non-empty in the ordinary case — this repo's own healthy runs carry
    // thousands — so a probe with any residue fired the plant once per spawn
    // on essentially every healthy run. Plant a monitor, force the
    // attribution path with an ignored extra, and count fires.
    const marker = join(repo, 'fsmonitor-fired');
    gitRepo('config', 'core.fsmonitor', `touch ${marker}`);
    // An ignored extra whose rule the tree carries as an EDIT: the
    // `check-ignore` attribution names a RELATIVE source, which is what
    // sends the tracked-source `ls-files` spawn — the second execution site
    // — down the same path.
    appendFileSync(join(tree, '.gitignore'), '*.log\n');
    writeFileSync(join(tree, 'artifact.log'), 'build output\n');

    const got = worktreeResidue(tree);

    expect(existsSync(marker)).toBe(false);
    // The verdict is unchanged by the neutrality: the extra hidden by an
    // edited ignore rule is still reported, not silently dropped.
    expect(got.paths).toContain('artifact.log');
    expect(got.unmeasured).toBeUndefined();
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
    expect(worktreeResidue(tree, undefined, 3).paths).toHaveLength(3);
    expect(worktreeResidue(tree, undefined, 3).total).toBe(20);
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

  it('measures the same residue when the caller anchors the recorded admin entry', () => {
    // The anchor is an OPT-IN third check: callers that hold the admin entry
    // the tree was created under hand it in, and healthy trees measure
    // byte-identically with and without it — a wrong pin would be worse than
    // none, so the healthy path is the one that must not move.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');
    const expected = git('rev-parse', '--path-format=absolute', '--git-dir');
    const got = worktreeResidue(tree, { adminDir: expected });
    expect(got.paths.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(got.unmeasured).toBeUndefined();
  });

  it('says UNMEASURED for a gitfile swapped at a repo that answers for this path', () => {
    // The identity gate reads `--show-toplevel`, which prints the directory the
    // `.git` FILE sits in — whatever that file points at. A repository whose
    // `core.worktree` names this tree answers with this path, so the gate saw
    // itself while every command after it measured the plant's index, which
    // already holds the contamination as committed content. Measured: through
    // discovery the swap reports a clean tree with the mutant on disk.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    // Genuine first, so the fixture is known to be measurable at all.
    expect(worktreeResidue(tree).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    const forge = join(repo, 'forge');
    mkdirSync(forge);
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
        { cwd: forge, encoding: 'utf8' },
      );
    fgit('init', '-q', '-b', 'main', '--template=', '.');
    writeFileSync(join(forge, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(forge, '__probe__.test.ts'), 'probe');
    fgit('add', '-A');
    fgit(
      'commit',
      '-qm',
      'the mutant, as if it were the commit',
      '--no-verify',
    );
    fgit('config', 'core.worktree', tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(forge, '.git')}\n`);

    const got = worktreeResidue(tree);

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('does not point back');
    // The flag `runScratchTree` branches on: an identity refusal must not
    // read like an ordinary unmeasured failure, or the creation it gates
    // descends from the very identity the probe just refused.
    expect(got.identityRefused).toBe(true);
  });

  it('says UNMEASURED for a forge that fabricates its own admin backpointer', () => {
    // The round-trip proves only that two files the swapper controls agree
    // with each other: a forge holding the contamination as committed content
    // writes its own admin `gitdir` file naming this tree, and the round-trip
    // reads self-consistent — `--show-toplevel` answers this tree, the
    // backpointer names it back, and the pin then locks every measurement to
    // the forge. Measured at the pre-fix gate: the probe answers
    // `{paths: [], total: 0}` — certified clean — with the mutant on disk.
    // The out-of-band anchor is the check a forge cannot pass: the gitfile
    // names an entry other than the one recorded for this tree.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const expected = git('rev-parse', '--path-format=absolute', '--git-dir');
    // Genuine first, anchored, so the fixture is known to measure at all.
    expect(worktreeResidue(tree, { adminDir: expected }).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    const forge = join(repo, 'forge');
    mkdirSync(forge);
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
        { cwd: forge, encoding: 'utf8' },
      );
    fgit('init', '-q', '-b', 'main', '--template=', '.');
    writeFileSync(join(forge, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(forge, '__probe__.test.ts'), 'probe');
    fgit('add', '-A');
    fgit(
      'commit',
      '-qm',
      'the mutant, as if it were the commit',
      '--no-verify',
    );
    fgit('config', 'core.worktree', tree);
    // The fabrication: an admin backpointer of the forge's own making. A
    // single write, and the round-trip has nothing left to disagree with.
    writeFileSync(join(forge, '.git', 'gitdir'), `${join(tree, '.git')}\n`);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(forge, '.git')}\n`);

    const got = worktreeResidue(tree, { adminDir: expected });

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('other than the one recorded');
    expect(got.identityRefused).toBe(true);
    // The mutant is still on disk: the refusal withholds the certificate, it
    // does not touch the tree.
    expect(readFileSync(join(tree, 'a.ts'), 'utf8')).toContain('MUTANT');
  });

  it('says UNMEASURED for a forge whose admin entry lives INSIDE the creating repository', () => {
    // The fabricated-backpointer forge's sibling, one step closer to home:
    // the admin entry the swapped gitfile names is a REAL registration under
    // the creating repository's own common dir — a second worktree added
    // there, holding the contamination as committed content, its `gitdir`
    // backpointer rewritten to name this tree. A common-dir anchor admits it
    // (it resolves inside the creating repository), the round-trip reads
    // self-consistent (one writer authored both sides), and the pin then
    // locks every measurement to the forge's committed-clean index. Measured
    // at the pre-fix gate: `{paths: [], total: 0}` — certified clean — with
    // the mutant on disk. The anchor must name the tree's OWN admin entry,
    // not the common dir that contains it.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const expected = git('rev-parse', '--path-format=absolute', '--git-dir');
    // Genuine first, anchored, so the fixture is known to measure at all.
    expect(worktreeResidue(tree, { adminDir: expected }).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);

    const forge = join(repo, 'forge');
    gitRepo('worktree', 'add', '--detach', '-q', forge, 'HEAD');
    writeFileSync(join(forge, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(forge, '__probe__.test.ts'), 'probe');
    gitRepo('-C', forge, 'add', '-A');
    gitRepo(
      '-C',
      forge,
      'commit',
      '-qm',
      'the mutant, as if it were the commit',
    );
    const forgeAdmin = gitRepo(
      '-C',
      forge,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    // The swap: the forge entry's backpointer names this tree, and this
    // tree's gitfile names the forge entry. Both files, one writer.
    writeFileSync(join(forgeAdmin, 'gitdir'), `${join(tree, '.git')}\n`);
    writeFileSync(join(tree, '.git'), `gitdir: ${forgeAdmin}\n`);

    const got = worktreeResidue(tree, { adminDir: expected });

    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain('other than the one recorded');
    expect(got.identityRefused).toBe(true);
    expect(readFileSync(join(tree, 'a.ts'), 'utf8')).toContain('MUTANT');
  });

  it('says UNMEASURED when the recorded admin entry is REPLACED where it stands', () => {
    // Both operands of the anchor's path comparison resolve at PROBE time,
    // against a filesystem the contaminator writes — so replacing what the
    // recorded name points at passes the comparison, the round-trip and the
    // pin with no gitfile swap. Here the entry is retargeted with a symlink
    // (`cp -a` over it and in-place HEAD/index rewrites are siblings): the
    // forge holds the contamination as committed content, `core.worktree`
    // names this tree, and its fabricated backpointer round-trips. Measured
    // at the pre-fix gate: `{paths: [], total: 0}` — certified clean — with
    // the mutant on disk. The anchor's recorded dev:ino refuses it: an
    // attacker chooses paths, not the inode a replacement directory lands on.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const expected = git('rev-parse', '--path-format=absolute', '--git-dir');
    const entry = statSync(expected);
    const anchor = {
      adminDir: expected,
      devIno: `${entry.dev}:${entry.ino}`,
    };
    // Genuine first, with the full anchor, so the fixture is known to measure.
    expect(worktreeResidue(tree, anchor).paths.sort()).toEqual([
      '__probe__.test.ts',
      'a.ts',
    ]);
    expect(worktreeResidue(tree, anchor).identityRefused).toBeUndefined();

    const forge = join(repo, 'forge');
    mkdirSync(forge);
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
        { cwd: forge, encoding: 'utf8' },
      );
    fgit('init', '-q', '-b', 'main', '--template=', '.');
    writeFileSync(join(forge, 'a.ts'), 'export const x = 2; // MUTANT\n');
    writeFileSync(join(forge, '__probe__.test.ts'), 'probe');
    // Everything else the tree holds too — a forge that omitted a committed
    // file would leak it as residue and fail for the wrong reason.
    writeFileSync(
      join(forge, '.gitignore'),
      readFileSync(join(tree, '.gitignore')),
    );
    fgit('add', '-A');
    fgit(
      'commit',
      '-qm',
      'the mutant, as if it were the commit',
      '--no-verify',
    );
    fgit('config', 'core.worktree', tree);
    writeFileSync(join(forge, '.git', 'gitdir'), `${join(tree, '.git')}\n`);
    // The swap: the RECORDED entry is retargeted at the forge. The tree's
    // gitfile is untouched — it still names the recorded path.
    rmSync(expected, { recursive: true, force: true });
    symlinkSync(join(forge, '.git'), expected);

    const got = worktreeResidue(tree, anchor);

    expect(got.paths).toEqual([]);
    expect(got.identityRefused).toBe(true);
    expect(got.unmeasured).toContain('filesystem identity changed');
    // The mutant is still on disk: the refusal withholds the certificate.
    expect(readFileSync(join(tree, 'a.ts'), 'utf8')).toContain('MUTANT');
    // The honest limit, disclosed: the same forge still passes a PATH-only
    // anchor — both of its operands resolve through the replacement. The
    // dev:ino check raises the bar; it does not close the class.
    expect(worktreeResidue(tree, { adminDir: expected }).paths).toEqual([]);
  });

  it('treats an EMPTY recorded devIno as absent — degrades, never refuses', () => {
    // A bare CLI flag hands over the empty string. It can never equal a
    // real `dev:ino`, and refusing a healthy tree with the tamper
    // diagnosis sends an operator hunting for repository tampering that is
    // not there — the documented degradation for an absent devIno is the
    // path comparison alone.
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const own = git('rev-parse', '--path-format=absolute', '--git-dir');
    const got = worktreeResidue(tree, { adminDir: own, devIno: '' });
    expect(got.identityRefused).toBeUndefined();
    expect(got.paths).toEqual(['__probe__.test.ts']);
  });

  it('says UNMEASURED when the recorded admin entry does not resolve on disk', () => {
    // The anchor is a record, and records go stale — a plan surviving a
    // cleanup, a tampered one. Measuring unanchored after the anchor failed
    // to resolve would be exactly the probe the anchor exists to prevent, so
    // the refusal names the recorded side specifically: an operator following
    // the message knows to inspect the fetch record.
    writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
    const got = worktreeResidue(tree, {
      adminDir: join(repo, 'nonexistent', 'wt-id'),
    });
    expect(got.paths).toEqual([]);
    expect(got.unmeasured).toContain(
      'the admin entry recorded for this tree does not resolve',
    );
    expect(got.identityRefused).toBe(true);
  });

  // Invalid-UTF-8 filenames cannot be created on Windows; the shape pinned
  // here (git resolving a byte path Node's fs APIs cannot follow) needs one.
  it.skipIf(process.platform === 'win32')(
    'names the GITFILE side when that operand does not resolve',
    () => {
      // The two anchor operands resolve separately because they fail for
      // different reasons: the recorded side is the fetch record, the
      // discovered side is whatever the gitfile names. A swapped gitfile can
      // name a path Node's fs APIs cannot follow — an invalid UTF-8 byte is
      // the limit this function's own doc comment acknowledges: git resolves
      // it byte-wise and prints it, `encoding: 'utf8'` renders U+FFFD, and
      // no string spelling of the name resolves. The refusal must say WHICH
      // side failed; blaming the record sends the operator inspecting a
      // fetch record that is fine while the gitfile side goes unnamed.
      const expected = git('rev-parse', '--path-format=absolute', '--git-dir');
      writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
      execFileSync('sh', [
        '-c',
        `set -e
bad="$(printf '${repo}/forge\\377')"
mkdir -p "$bad"
git init -q -b main --template= "$bad"
git -C "$bad" config core.worktree '${tree}'
printf 'gitdir: %s/.git\\n' "$bad" > '${tree}/.git'`,
      ]);

      const got = worktreeResidue(tree, { adminDir: expected });

      expect(got.paths).toEqual([]);
      expect(got.unmeasured).toContain(
        'the .git gitfile names an admin entry that does not',
      );
      expect(got.unmeasured).not.toContain('recorded for this tree');
      expect(got.identityRefused).toBe(true);
    },
  );

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
    expect(got.identityRefused).toBe(true);
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
    expect(got.paths).toEqual([]);
    expect(got.total).toBe(0);
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

  // A shim again — a shell script, so Windows skips it (see the oracle test
  // above); the behaviour pinned is platform-independent.
  it.skipIf(process.platform === 'win32')(
    'still measures the residue when the gitfile is swapped after the gate',
    () => {
      // The pin is what closes the window between the gate's reads and the
      // commands that follow it: this shim rewrites `tree/.git` to a
      // committed-clean plant the moment it is invoked with `status` —
      // strictly AFTER the gate, no race — and every anchored spawn ignores
      // the swap because it names the verified admin entry outright. Drop the
      // anchor spreads and the plant answers a clean status for this dirty
      // tree: the mutant certified clean, deterministically. The shim also
      // RECORDS every argv: the residue verdict alone discriminates only the
      // two spawns whose answers change the result (`status`, `ls-files
      // --others` — the plant mirrors the disk), so the recorded argv is what
      // proves the pin rides the other four as well. Measured by mutation:
      // dropping any one of the six anchor spreads fails an assertion here.
      //
      // One ignore rule the COMMIT carries, and the file it hides: that is
      // what makes the reconciliation spawns run at all — `check-ignore` and
      // the tracked-source `ls-files` fire only when `status` hides something
      // the raw listing shows, and an anchored probe must still come back
      // with exactly the two residue paths.
      writeFileSync(
        join(repo, '.gitignore'),
        'node_modules\ndist\nhidden.txt\n',
      );
      gitRepo('add', '-A');
      gitRepo('commit', '-qm', 'ignore the hidden file');
      git('checkout', '--detach', 'main');
      writeFileSync(join(tree, 'a.ts'), 'export const x = 2; // MUTANT\n');
      writeFileSync(join(tree, '__probe__.test.ts'), 'probe');
      writeFileSync(join(tree, 'hidden.txt'), 'the file the commit hides');
      const expected = git('rev-parse', '--path-format=absolute', '--git-dir');

      // The plant: the contamination committed, `core.worktree` answering for
      // this tree — a clean `status` for the dirty tree, if a spawn ever
      // re-discovers through the swapped gitfile.
      const plant = join(repo, 'plant');
      mkdirSync(plant);
      const pgit = (...args: string[]) =>
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
          { cwd: plant, encoding: 'utf8' },
        );
      pgit('init', '-q', '-b', 'main', '--template=', '.');
      writeFileSync(join(plant, 'a.ts'), 'export const x = 2; // MUTANT\n');
      writeFileSync(join(plant, '__probe__.test.ts'), 'probe');
      pgit('add', '-A');
      pgit('commit', '-qm', 'the contamination, committed', '--no-verify');
      pgit('config', 'core.worktree', tree);

      const shim = mkdtempSync(join(tmpdir(), 'qwen-git-shim-'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shim, 'git'),
        `#!/bin/sh\nsep=$(printf '\\037')\nout=""\ns=""\nfor a in "$@"; do\n  out="$out$s$a"\n  s="$sep"\ndone\nprintf '%s\\n' "$out" >> '${shim}/calls.log'\nfor a in "$@"; do\n  if [ "$a" = status ]; then\n    printf 'gitdir: ${plant}/.git\\n' > '${tree}/.git'\n    break\n  fi\ndone\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      process.env['PATH'] = `${shim}:${realPath}`;

      const got = worktreeResidue(tree, { adminDir: expected });

      // The swap DID land — the shim fired, the gitfile names the plant — and
      // the measurement ignored it.
      expect(readFileSync(join(tree, '.git'), 'utf8')).toContain(
        join(plant, '.git'),
      );
      expect(got.paths.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
      expect(got.unmeasured).toBeUndefined();

      // The pin rides EVERY measurement spawn — status, ls-files --others,
      // check-ignore, the tracked-source ls-files, ls-files -s and ls-files
      // -v. A future edit that loses one of the anchor spreads (a helper
      // refactor, a new spawn added without the prefix) fails here even when
      // the plant cannot tell the answers apart.
      const calls = readFileSync(join(shim, 'calls.log'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('\u001f'));
      const measurements = calls.filter((argv) =>
        ['status', 'ls-files', 'check-ignore'].some((sub) =>
          argv.includes(sub),
        ),
      );
      expect(measurements.length).toBeGreaterThanOrEqual(6);
      for (const argv of measurements) {
        expect(argv).toContain(`--git-dir=${realpathSync(expected)}`);
        expect(argv).toContain(`--work-tree=${realpathSync(tree)}`);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses — fast — when the entry backpointer is not a regular file; it does not hang',
    () => {
      // The gate round-trips through the entry's `gitdir` file — anchored
      // and unanchored probes alike. A planted FIFO there blocks an
      // unbounded readFileSync in open() forever, hanging EVERY residue
      // probe until a human removes it (measured: both probes wedged at the
      // deadline while the base arm answered instantly with the same plant).
      // The bounded read refuses like any other entry that does not point
      // back.
      //
      // The probe runs in a CHILD process under a hard deadline, because a
      // synchronous wedge blocks the event loop — the pre-fix shape — and no
      // in-process timer can fire while it does. The deadline turns "hangs"
      // into "fails" on the pre-fix code and measures the bounded answer on
      // the fixed one (the same discipline as the screen's FIFO test).
      const entry = readFileSync(join(tree, '.git'), 'utf8')
        .trim()
        .replace(/^gitdir:\s*/, '');
      const modulePath = join(
        process.cwd(),
        'src',
        'commands',
        'review',
        'lib',
        'worktree.js',
      );
      rmSync(join(entry, 'gitdir'));
      execFileSync('mkfifo', [join(entry, 'gitdir')]);
      const script = join(repo, 'backpointer-probe.mts');
      writeFileSync(
        script,
        `import { worktreeResidue } from ${JSON.stringify(modulePath)};\n` +
          'const got = worktreeResidue(process.argv[2]);\n' +
          'process.stdout.write(JSON.stringify(got));\n',
      );
      const tsxCli = moduleRequire.resolve('tsx/cli');
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [tsxCli, script, tree], {
          encoding: 'utf8',
          timeout: 10_000,
        });
      } catch (err) {
        // Killed at the deadline: the gate wedged instead of refusing.
        throw new Error(
          `the identity gate wedged instead of answering unmeasurable: ${(err as Error).message}`,
        );
      }
      const got = JSON.parse(stdout) as ReturnType<typeof worktreeResidue>;
      expect(got.identityRefused).toBe(true);
      expect(got.unmeasured).toContain('does not point back');
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

  it('the pinned discard drops only the pinned entry — a rewritten backpointer never reaches a live sibling', () => {
    // The pinned branch used to sweep the pinned common dir for entries whose
    // backpointer CONTENT names the discarded path, liveness-checking the
    // name the backpointer itself claims — so an entry whose backpointer was
    // rewritten to name the just-discarded path was deleted while its REAL
    // worktree was alive: its gitfile left dangling, every git command in it
    // failing until a human repairs it (measured live through this very
    // function). The pinned discard drops the pinned entry alone — a foreign
    // entry survives and is loud at the next add.
    const mine = join(repo, 'mine');
    const victim = join(repo, 'victim');
    git(repo, 'worktree', 'add', '--detach', '-q', mine, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '-q', victim, 'HEAD');
    const common = git(
      repo,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    // mine's entry — the pin the caller's gate verified — and the
    // victim's, whose survival is asserted on the DIRECTORY and on git
    // still working in the tree: with the tamper in place the entry's own
    // backpointer claims mine's path, so `worktree list` no longer names
    // the victim either way.
    const mineEntry = readFileSync(join(mine, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    const victimEntry = readFileSync(join(victim, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    // Rewrite the VICTIM's backpointer to name mine's path, the tamper shape.
    for (const id of readdirSync(join(common, 'worktrees'))) {
      const gitdirFile = join(common, 'worktrees', id, 'gitdir');
      if (readFileSync(gitdirFile, 'utf8').includes('victim')) {
        writeFileSync(gitdirFile, `${mine}/.git\n`);
      }
    }
    // Corrupt mine's gitfile so `worktree remove` fails and the registration
    // drop actually runs — the shape the sweep existed for.
    rmSync(join(mine, '.git'));

    discardWorktree(repo, mine, mineEntry);

    // mine is gone — path and registration both.
    expect(existsSync(mine)).toBe(false);
    // The victim's registration SURVIVED the tampering: its entry still
    // stands and git still works in the tree, which neither does with a
    // deleted entry and a dangling gitfile.
    expect(existsSync(victimEntry)).toBe(true);
    expect(git(victim, 'rev-parse', 'HEAD')).toBeTruthy();
  });

  it('the pinned discard spawns carry the pipeline deadline — a wedge must end', () => {
    // The pinned discard's spawns read admin files the contaminator writes; a
    // planted FIFO in one blocks them in open() forever, and a spawn without
    // a timeout hangs the whole review CLI until a human removes the plant —
    // the wedge class this PR's own `localFilterCommands` deadline closed
    // elsewhere. Every pinned spawn must carry the deadline.
    const mine = join(repo, 'mine');
    git(repo, 'worktree', 'add', '--detach', '-q', mine, 'HEAD');
    const mineEntry = readFileSync(join(mine, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    spawnLog.calls.length = 0;

    discardWorktree(repo, mine, mineEntry);

    const pinned = spawnLog.calls.filter((c) =>
      c.args.includes(`--git-dir=${mineEntry}`),
    );
    expect(pinned.length).toBeGreaterThan(0);
    for (const call of pinned) {
      expect(typeof (call.options as { timeout?: unknown }).timeout).toBe(
        'number',
      );
    }
  });

  it.skipIf(process.platform === 'win32')(
    'the registration sweep skips a backpointer that is not a regular file — it does not hang on it',
    () => {
      // The sweep reads every entry's `gitdir` backpointer — one planted
      // FIFO blocks an unbounded readFileSync in open() forever (measured:
      // the FIFO arm killed at the deadline, the control instant). A
      // backpointer that is not a regular file is an unreadable entry:
      // skipped, left for the next add to name. Witnessed directly rather
      // than through `discardWorktree`: reaching the sweep through it first
      // drives git's own `worktree remove` past the same plant — git reads
      // every backpointer resolving a corrupt gitfile — spending the spawn
      // deadline three times over before the sweep even runs.
      const mine = join(repo, 'mine');
      git(repo, 'worktree', 'add', '--detach', '-q', mine, 'HEAD');
      const common = git(
        repo,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      );
      const worktreesDir = join(common, 'worktrees');
      const entries = readdirSync(worktreesDir);
      expect(entries.length).toBeGreaterThan(0);
      for (const id of entries) {
        const gitdirFile = join(worktreesDir, id, 'gitdir');
        rmSync(gitdirFile);
        execFileSync('mkfifo', [gitdirFile]);
      }
      // Child process under a hard deadline, the same discipline as the
      // screen's FIFO test: the pre-fix readFileSync wedges the event loop,
      // so no in-process timer can fire while it blocks.
      const modulePath = join(
        process.cwd(),
        'src',
        'commands',
        'review',
        'lib',
        'worktree.js',
      );
      const script = join(repo, 'sweep-probe.mts');
      writeFileSync(
        script,
        `import { sweepEntriesFor } from ${JSON.stringify(modulePath)};\n` +
          'sweepEntriesFor(process.argv[2], process.argv[3]);\n' +
          "process.stdout.write('done');\n",
      );
      const tsxCli = moduleRequire.resolve('tsx/cli');
      let stdout = '';
      try {
        stdout = execFileSync(
          process.execPath,
          [tsxCli, script, worktreesDir, mine],
          { encoding: 'utf8', timeout: 10_000 },
        );
      } catch (err) {
        throw new Error(
          `the registration sweep wedged instead of skipping the plant: ${(err as Error).message}`,
        );
      }
      expect(stdout).toBe('done');

      // Every FIFO'd entry was skipped, not read — all of them still stand.
      for (const id of entries) {
        expect(existsSync(join(worktreesDir, id))).toBe(true);
      }
    },
  );
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
  // The screen is tested against a REAL repository: the planting shapes it
  // exists to catch are git's own config semantics, and a mock of the spawn
  // would be testing the test.
  const moduleRequire = createRequire(import.meta.url);
  let repo: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

  const gitRepo = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'qwen-filter-screen-'));
    gitRepo('init', '-q', '-b', 'main');
    gitRepo('config', 'user.email', 't@t.t');
    gitRepo('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'x\n');
    gitRepo('add', '-A');
    gitRepo('commit', '-qm', 'head');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  it('detects the long-running filter.<name>.process form — smudge|clean is not the whole surface', () => {
    // `filter.<name>.process` is the modern long-running filter form and
    // executes on the same checkouts; the pre-fix regex never matched it, so
    // the screen answered clean while the authorised checkout ran the plant
    // (measured).
    gitRepo('config', 'filter.evil.process', 'touch /tmp/qwen-never');
    expect(localFilterCommands(repo)).toEqual(['filter.evil.process']);
  });

  it('detects a filter planted behind include.path', () => {
    // An `include.path` directive pulls the filter definition from a file
    // the scan never names; without `--includes`, `git config --file` does
    // not honor it, and the plant stayed invisible while the checkout ran it
    // (measured).
    const inc = join(repo, 'included-config');
    writeFileSync(inc, '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n');
    gitRepo('config', 'include.path', inc);
    expect(localFilterCommands(repo)).toEqual(['filter.evil.smudge']);
  });

  it.skipIf(process.platform === 'win32')(
    'answers unmeasurable — not clean — when a candidate read wedges',
    () => {
      // A FIFO planted at a scanned path blocks `git config --file` in
      // open() waiting for a writer that never comes; the pre-fix spawn had
      // no timeout, so one mkfifo wedged every run with no output and no
      // refusal until a human removed it (measured). The bounded spawn ends
      // the hang, and a read that cannot finish is a refusal upstream, never
      // a clean verdict.
      //
      // The screen runs in a CHILD process under a hard deadline, because a
      // synchronous wedge blocks the event loop — the pre-fix shape — and no
      // in-process timer can fire while it does. The deadline turns "hangs"
      // into "fails" on the pre-fix code and measures the bounded answer on
      // the fixed one.
      mkdirSync(join(repo, '.git', 'worktrees', 'evil'), { recursive: true });
      execFileSync('mkfifo', [
        join(repo, '.git', 'worktrees', 'evil', 'config.worktree'),
      ]);
      // Suites run from the package root; the module under test lives at a
      // fixed path below it (vitest rewrites `import.meta.url`, so it is not
      // a file URL here).
      const modulePath = join(
        process.cwd(),
        'src',
        'commands',
        'review',
        'lib',
        'worktree.js',
      );
      const script = join(repo, 'screen-probe.mts');
      writeFileSync(
        script,
        `import { localFilterCommands } from ${JSON.stringify(modulePath)};\n` +
          'const got = localFilterCommands(process.argv[2], undefined, 500);\n' +
          'process.stdout.write(JSON.stringify(got));\n',
      );
      const tsxCli = moduleRequire.resolve('tsx/cli');
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [tsxCli, script, repo], {
          encoding: 'utf8',
          timeout: 10_000,
        });
      } catch (err) {
        // Killed at the deadline: the screen hung instead of refusing.
        throw new Error(
          `the filter screen wedged instead of answering unmeasurable: ${(err as Error).message}`,
        );
      }
      expect(JSON.parse(stdout)).toBeNull();
    },
  );

  it("screens the common dir's config.worktree in the PINNED form — the hardened path screened strictly less", () => {
    // The pinned form answered the COMMON dir and swept the entries under
    // it, but never named `<common>/config.worktree` — the MAIN worktree's
    // per-worktree config, honored by the checkout the screen authorises
    // once `extensions.worktreeConfig` is on (which the attacker
    // self-enables with one plain write the filter regex ignores). Measured:
    // the pinned screen answered [] while the pinned add fired the plant —
    // the degraded UNPINNED path saw it. Unconditional now.
    const common = gitRepo(
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    writeFileSync(
      join(common, 'config.worktree'),
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );
    expect(localFilterCommands(repo, join(repo, '.git'))).toEqual([
      'filter.evil.smudge',
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'answers unmeasurable — not clean — when a candidate read cannot complete',
    () => {
      // A candidate git cannot open is a candidate whose content could not be
      // screened; the pre-fix loop `continue`-d past it to a clean verdict.
      const entry = join(repo, '.git', 'worktrees', 'locked');
      mkdirSync(entry, { recursive: true });
      const cfg = join(entry, 'config.worktree');
      writeFileSync(cfg, '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n');
      chmodSync(cfg, 0o000);
      try {
        expect(localFilterCommands(repo)).toBeNull();
      } finally {
        chmodSync(cfg, 0o644);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'answers unmeasurable — not clean — when the worktrees dir cannot be listed',
    () => {
      // A no-read directory (mode w+x) makes readdirSync throw EACCES while
      // git's checkout still reaches the entries' config.worktree files by
      // direct path — traversal needs execute, not read. The pre-fix catch
      // read ABSENT and UNREADABLE alike, so the screen lost its only
      // per-entry candidate class to a clean verdict while the authorised
      // checkout honored the plant (measured live: the screen answered
      // clean before and after a chmod that direct-path reads survived).
      const entry = join(repo, '.git', 'worktrees', 'evil');
      mkdirSync(entry, { recursive: true });
      writeFileSync(
        join(entry, 'config.worktree'),
        '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
      );
      const worktreesDir = join(repo, '.git', 'worktrees');
      chmodSync(worktreesDir, 0o311);
      try {
        expect(localFilterCommands(repo)).toBeNull();
      } finally {
        chmodSync(worktreesDir, 0o755);
      }
    },
  );
});

describe('admin entry backpointer format', () => {
  // The identity machinery reads the admin entry's `gitdir` file in four
  // places — the probe's points-back check, the leftover sweep, the cleanup
  // round-trip and fetch-pr's anchor recording. git writes a BARE path
  // there; the `gitdir: ` prefix belongs to the other direction, the tree's
  // `.git` file naming the entry. The recording once demanded the prefix
  // while the fixture planted it, so the suite stayed green while every
  // production fetch degraded to the unanchored gate (R7-5). This oracle
  // pins the shape real `git worktree add` writes, so the two formats
  // cannot be confused again.
  it('git writes the admin-entry gitdir file as a bare path — the prefix rides the other direction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-backptr-'));
    const gitIsolation = isolateHostGitConfig();
    try {
      const run = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      run('init', '-q', '-b', 'main');
      run('config', 'user.email', 't@t.t');
      run('config', 'user.name', 't');
      writeFileSync(join(dir, 'a.ts'), 'x\n');
      run('add', '-A');
      run('commit', '-qm', 'head');
      const wt = join(dir, 'wt');
      run('worktree', 'add', '--detach', '-q', wt, 'HEAD');
      const entry = join(dir, '.git', 'worktrees', 'wt');
      const raw = readFileSync(join(entry, 'gitdir'), 'utf8').trim();
      expect(raw.startsWith('gitdir:')).toBe(false);
      // And the bare content is the round-trip's operand: resolved relative
      // to the entry it lands on the tree's `.git` file, the way pointsBack
      // and the recording's cross-check consume it.
      expect(samePath(dirname(resolve(entry, raw)))).toBe(samePath(wt));
      const pointer = readFileSync(join(wt, '.git'), 'utf8').trim();
      expect(pointer.startsWith('gitdir: ')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      gitIsolation.dispose();
    }
  });
});
