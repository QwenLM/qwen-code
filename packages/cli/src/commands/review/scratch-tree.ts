/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review scratch-tree`: a private copy of the PR head for one verifier to
// mutate, so the tree everyone else is READING stays exactly as the PR left it.
//
// Step 4's verifier was the last review step still writing into the shared tree
// (Agent 7's efficacy probe has had a disposable sibling since #6832): it
// writes a probe, runs it, applies the one-line fix the finding implies to show
// the probe flips, and restores. Until now it did all of that in the shared
// review worktree — the tree `working_dir` pins every other agent to as well.
//
// That is a race, and the pipeline's own shape is what makes it structural
// rather than unlucky: round k's verifiers are launched in the SAME response as
// round k+1's reverse auditors ("Verification rides alongside the next round"),
// so a verifier's probe is live in the tree precisely while auditors read it.
// Measured on a real review (#9207): a round-5 auditor read `compose-review.ts`
// carrying a probe's mutant plus a leftover `__probe__.test.ts`, and came within
// a step of filing a Critical against code no commit contains. It recovered by
// improvising `git show HEAD:` — a fallback no brief mentions. Two other agents
// in the same run reported the residue.
//
// "Leave the tree as you found it" — which the verifier brief has always said,
// and which verifiers do obey — cannot close this: the exposure window is DURING
// the probe, not after it. The only fix that removes the window is a tree of
// one's own, which is the pattern this pipeline already uses twice: the
// test-efficacy probe's `-probe` sibling (#6832) and the A/B's `-base` sibling.
// This is the third, and the last mutating step that lacked one.
//
// What it deliberately does NOT do: run anything. Like `base-tree`, it owns the
// fiddly half — a detached add at the right SHA, a leftover from a crashed run,
// a dependency farm so a unit harness can actually start — and hands back a
// path. WHAT to probe is the verifier's question, and no fixed scenario fits it.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  assertWritableOutPath,
  inertPath,
  scratchLabel,
  scratchWorktreePath,
} from './lib/paths.js';
import { shellQuotePath } from './lib/shell-quote.js';
import {
  RESIDUE_PATH_CAP,
  discardWorktree,
  exposeDependencies,
  localFilterCommands,
  redirectedAncestor,
  sanitizedGitEnv,
  screenKeyList,
  screenStopDetail,
  worktreeCreateFailureDetail,
  worktreeResidue,
  type DependencyFarm,
  type SweepResult,
} from './lib/worktree.js';

export interface ScratchTreeReport {
  /** True when a tree stands at `path`, checked out at the commit under review. */
  available: boolean;
  /** Absolute path to this agent's scratch worktree, when one was created. */
  path?: string;
  /** The commit it holds — the review worktree's HEAD, i.e. the PR head. */
  headSha?: string;
  /**
   * True when an earlier call had already created it and this one restored it
   * to `headSha` instead of rebuilding it. Disclosed because it is the answer
   * to "where did my probe file go" — every call hands back a PRISTINE tree.
   */
  reused: boolean;
  /**
   * The `node_modules` farm: how many packages were symlinked in from the
   * review worktree, how many could not be, and whether a farm was already
   * standing. `null` means only one thing: the review worktree has no
   * `node_modules` to link from. A linking FAILURE arrives as
   * `{linked: 0, failed: N}` instead, because `exposeDependencies` guards every
   * fs call it makes and counts what went wrong rather than throwing.
   */
  dependencies: DependencyFarm | null;
  /**
   * Paths the SHARED review worktree carries that its HEAD does not, at the
   * moment of this call. Normally empty. Non-empty means residue is in the tree
   * the other agents are reading right now — most likely this verifier's own,
   * from before it had a scratch tree to work in — and the note says to restore
   * it. This is the cleanliness check the fix is incomplete without: isolation
   * removes the source, and this catches the case where something wrote to the
   * shared tree anyway.
   */
  sharedTreeResidue: string[];
  /**
   * How many dirty paths the tree actually holds. Greater than
   * `sharedTreeResidue.length` means the list above was capped — a capped list
   * read as the complete one is a verifier restoring what it was shown and
   * leaving the rest in the tree the next round reads.
   */
  sharedTreeResidueTotal: number;
  /**
   * Set when the residue check could not run at all. An empty
   * `sharedTreeResidue` means "clean" only while this is absent — a `git status`
   * that died on a tree too dirty for its buffer answers with the same empty
   * list a pristine tree does.
   */
  sharedTreeUnmeasured?: string;
  /** What happened, in one line. Rendered to the verifier verbatim. */
  note: string;
}

export interface ScratchTreeArgs {
  worktree: string;
  label: string;
  /**
   * The commit the worktree must hold — fetch-pr's record from the plan,
   * welded into the verifier's command. The residue probe's identity anchor:
   * with it a healthy shared tree measures clean; without it the
   * measurement is refused rather than certified. Malformed, or disagreeing
   * with the worktree's own HEAD, the command refuses before creating or
   * resetting anything: a scratch tree may only stand at the reviewed head.
   */
  fetchedSha?: string;
  out?: string;
}

/**
 * `git`, with the user's hooks out of the way.
 *
 * A scratch tree is a LINKED worktree, so its hooks resolve to the common dir —
 * the user's own `.git/hooks`. `git worktree add` and `checkout` both fire
 * `post-checkout` from there, which means this command would run whatever hooks
 * that repository has (and whatever a probe managed to write into it) as a side
 * effect of creating or resetting a tree. Pointing `core.hooksPath` at a path
 * that holds no hooks covers the HOOKS; it does not cover content FILTERS —
 * `filter.<name>.smudge|clean` commands are config-driven, and a checkout runs
 * whichever ones an attributes file selects. `runScratchTree` detects that
 * surface in the repository's own config and refuses rather than run it (see
 * `localFilterCommands`). What a probe does with its own shell is the probe's
 * business, and the report says plainly that the common dir is shared rather
 * than isolated.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null/no-hooks'];

function gitOut(cwd: string, ...args: string[]): string {
  // `ls-files -v` prints a line per tracked file and `clean` a line per removal;
  // both pass the default 1 MiB buffer on a large repo, and `spawnSync` answers
  // that by killing the child — which this function reads as a git failure and
  // the reset reads as "rebuild", permanently, for every call.
  // Sanitized env: an inherited GIT_DIR overrides repository discovery for
  // the ENTIRE identity gate at once — both sides of every comparison see the
  // same override, so no check can detect it — and the head sha itself comes
  // back from the wrong repository.
  const r = spawnSync('git', [...NO_HOOKS, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

function git(cwd: string, ...args: string[]): void {
  gitOut(cwd, ...args);
}

/**
 * Put an existing scratch tree back at `headSha`, or say why it could not be.
 *
 * Every call hands back the PR head, not "the PR head plus whatever the last
 * probe left" — a mutant surviving into the next finding's probe is a wrong
 * verdict with a deterministic source tag on it, which is the worst failure
 * this command could have. `checkout --force` reverts the tracked edits and
 * `clean -ffdx` removes the probe files — nested repositories a probe cloned
 * or `git init`-ed included — and the IGNORED state too: a probe's own
 * `node_modules` at any depth, its build caches, a `dist/` it rebuilt. The
 * dependency farm lives in that ignored state, so the caller re-links it
 * afterwards; sparing it to save the second would sell the guarantee.
 */
function resetScratchTree(
  tree: string,
  headSha: string,
  worktree: string,
): boolean {
  // The gate that makes the rest of this function safe to run. A LINKED
  // worktree has a `.git` file pointing at the common dir; a bare directory
  // left by a crashed `worktree add` (or by a cleanup whose `rmSync` failed)
  // has nothing — and git, finding nothing, walks UP. The scratch path sits
  // inside the user's own checkout, so `checkout --force --detach <sha>` would
  // then run against THAT: the user's uncommitted tracked work discarded, their
  // HEAD detached onto the PR's commit, and `rev-parse HEAD` returning the very
  // sha that makes this function report success (measured on a real repo). The
  // caller's discard-and-rebuild path handles the bare directory correctly;
  // this one must never touch it.
  if (!existsSync(join(tree, '.git'))) return false;
  // And the tree must BE the tree: a symlink at the scratch path, or a `.git`
  // naming another repository, would aim everything below at whatever it
  // resolves to. Discard-and-rebuild is the correct answer to all of it —
  // `discardWorktree`'s `rmSync` unlinks a symlink rather than following it.
  try {
    if (!lstatSync(tree).isDirectory()) return false;
    // A genuine linked worktree carries its `.git` as a FILE naming its admin
    // entry, and its gitdir is `<common>/worktrees/<name>`. A tree claiming
    // to be the MAIN checkout — gitdir === commondir, reached by a `.git`
    // symlinked or hand-edited to name the common dir — passed every other
    // check here (measured live: `--show-toplevel` names this directory, the
    // common dirs compare equal) while `checkout --force` detached the user's
    // MAIN HEAD onto the PR sha and rewrote the main index. The reset below
    // must never land there.
    if (
      realpathSync(gitOut(tree, 'rev-parse', '--show-toplevel')) !==
      realpathSync(tree)
    ) {
      return false;
    }
    // And it must be a worktree of THIS repository. `--show-toplevel` prints
    // the directory the `.git` file sits in, whatever that file points at, so a
    // gitfile naming another repository — or a whole repo planted at the
    // predictable scratch path — passes the check above while every command
    // below runs against someone else's objects, refs, hooks and config.
    const commonOf = (dir: string) =>
      realpathSync(
        gitOut(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      );
    if (commonOf(tree) !== commonOf(worktree)) return false;
    // EVERY ancestor, not just the parent. The first cut lstat'd `dirname(tree)`
    // on the stated premise that `.qwen/tmp` is the one component above the leaf
    // anything here can replace — which is false one hop higher: a link at
    // `.qwen` redirects the whole path, and then every check in this gate agrees
    // with every other because they all resolve THROUGH it (measured: toplevel
    // self-equality, common-dir equality, gitdir ≠ commondir and even the
    // backpointer round-trip all pass, because the entry's own lexical path
    // resolves through the same link). The walk is bounded at the repository the
    // common dir belongs to — above that is the user's own layout, and `/var` is
    // a symlink on every macOS box.
    if (
      redirectedAncestor(dirname(resolve(tree)), dirname(commonOf(worktree)))
    ) {
      return false;
    }
    const gitdir = realpathSync(
      gitOut(tree, 'rev-parse', '--path-format=absolute', '--git-dir'),
    );
    if (gitdir === commonOf(worktree)) return false;
    // The admin entry must point back at THIS tree. A planted gitfile naming
    // a SIBLING worktree's admin entry passes every check above — directory,
    // gitfile, toplevel resolving to itself, common dirs comparing equal,
    // gitdir distinct from the commondir — while the reset below detaches the
    // sibling's HEAD onto the PR sha and wipes its staged index. The entry's
    // `gitdir` file names the `.git` file inside the tree it belongs to; a
    // borrowed entry names the sibling's, and the mismatch sends this shape
    // down discard-and-rebuild.
    const backpointer = readFileSync(join(gitdir, 'gitdir'), 'utf8').trim();
    if (
      realpathSync(dirname(resolve(gitdir, backpointer))) !== realpathSync(tree)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    // Re-read the leaf immediately before the mutation. The gate above is a
    // handful of spawns long, and what it authorises is a `checkout --force`
    // and a `clean -ffdx`: a link swapped in during that window aims both at
    // whatever it names. The window cannot be closed from here — this narrows
    // it to one syscall, which is the same trade the hunk probe's pre-write
    // re-check makes.
    if (lstatSync(tree).isSymbolicLink()) return false;
    git(tree, 'checkout', '--force', '--detach', headSha);
    // `-ff` because a single `-f` refuses to delete a nested git repository, so
    // a probe that cloned or `git init`-ed a fixture would survive a reset the
    // report calls pristine — and `-x` because IGNORED paths are where the rest
    // of a probe's state lives: its own `node_modules` at any depth, a
    // `.tsbuildinfo`, a `dist/` it built and then mutated. Sparing them to keep
    // the dependency farm cheap bought a second and sold the guarantee; the
    // farm is re-linked by the caller instead.
    git(tree, 'clean', '-ffdx');
    // `checkout --force` silently skips a file carrying the skip-worktree bit,
    // and `clean` never touches tracked files — so a probe that set the bit
    // (directly, or via `git sparse-checkout`) and then edited the file leaves
    // a mutant that survives the reset with `git status` reading empty. The
    // sha check cannot see it. Refusing here sends the caller down the
    // discard-and-rebuild path, which is guaranteed clean.
    const hidden = gitOut(tree, 'ls-files', '-v')
      .split('\n')
      .some((line) => /^[a-zS]/.test(line));
    if (hidden) return false;
    // Nor does any of it reach INSIDE a submodule: `checkout --force` without
    // `--recurse-submodules` leaves its working tree alone, `clean` never
    // touches a tracked gitlink, and `rev-parse HEAD` is the superproject's. A
    // probe that initialized one (to build) and mutated a file in it would
    // hand the next probe that mutant under a pristine report — and reading
    // `submodule status` is not enough to notice, because `git submodule
    // deinit` restores the uninitialized-looking `-` line while leaving the
    // submodule's gitdir (its hooks, its config, its objects) standing under
    // the common dir, where the next `submodule update --init` resurrects it.
    // So the presence of ANY gitlink in the commit sends this tree down the
    // rebuild path: a fresh `worktree add` starts them uninitialized, and a
    // repo with submodules pays a rebuild per call rather than a wrong verdict.
    const hasSubmodules = gitOut(tree, 'ls-files', '-s')
      .split('\n')
      .some((line) => line.startsWith('160000'));
    if (hasSubmodules) return false;
    return gitOut(tree, 'rev-parse', 'HEAD') === headSha;
  } catch {
    // A tree too broken to reset is not a tree to probe in. The caller
    // discards and rebuilds it rather than handing back a half-known state.
    return false;
  }
}

export function runScratchTree(args: ScratchTreeArgs): ScratchTreeReport {
  // Every refusal that fires before the residue is measured says so, rather
  // than answering with the empty list a MEASURED-clean tree produces: a
  // consumer reading `sharedTreeResidue: []` cannot otherwise tell "the tree is
  // clean" from "this call never looked".
  const unavailable = (note: string): ScratchTreeReport => ({
    available: false,
    reused: false,
    dependencies: null,
    sharedTreeResidue: [],
    sharedTreeResidueTotal: 0,
    sharedTreeUnmeasured:
      'the command refused before it measured the shared worktree',
    note,
  });

  const worktree = resolve(args.worktree);
  if (!existsSync(worktree)) {
    return unavailable(`the review worktree ${worktree} does not exist`);
  }
  // The label is what keeps concurrent verifier shards out of each other's
  // trees, so a missing one is refused rather than defaulted: a default is a
  // shared tree by another name, and it would reintroduce the very race this
  // command exists to remove — one shard editing the file another is measuring.
  // The check is on the SANITIZED form, because that is what names the tree: a
  // label of `???` and a label of `!!!` are two different non-empty strings
  // that flatten to nothing, and a fallback would put both shards in one tree.
  const label = scratchLabel(args.label ?? '');
  if (!label) {
    return unavailable(
      '--label is required, and must keep at least one of `A-Za-z0-9._-` once ' +
        'flattened for a path: it is what gives each verifier shard its own ' +
        'tree, and shards of one round run concurrently. Pass the record key ' +
        'from your launch block.',
    );
  }

  // The directory alone is not identity enough for what follows: with the
  // `.git` file gone — a crash mid-`worktree add`, a cleanup whose `rmSync`
  // failed — every git call walks UP into the user's checkout: HEAD resolves
  // to the user's branch, the residue probe names the user's own dirty paths,
  // and the restore recipe is aimed at them. The reuse gate cannot catch it —
  // both sides of its common-dir comparison resolve to the user's repo, so
  // the equality holds over the WRONG repository. The same `--show-toplevel`
  // comparison the reset applies to the scratch tree, applied to the trusted
  // argument side.
  try {
    if (
      realpathSync(gitOut(worktree, 'rev-parse', '--show-toplevel')) !==
      realpathSync(worktree)
    ) {
      return unavailable(
        `the review worktree ${worktree} is not a git worktree — repository ` +
          'discovery walks up into the enclosing checkout; check its .git file',
      );
    }
  } catch (err) {
    return unavailable(
      `cannot read HEAD in ${worktree}: ${inertPath((err as Error).message)}`,
    );
  }

  let headSha: string;
  try {
    headSha = gitOut(worktree, 'rev-parse', 'HEAD');
  } catch (err) {
    return unavailable(
      `cannot read HEAD in ${worktree}: ${inertPath((err as Error).message)}`,
    );
  }

  // The record the caller welded in, validated BEFORE any reset or creation:
  // both paths check a commit out, and the tree a verifier probes must hold
  // the reviewed head. A record that is not a full object ID cannot anchor
  // the residue pin, and one the shared tree does not answer means the tree
  // is at some other commit — either way a scratch tree created now would
  // hold code other than the reviewed head, so none is created or reset.
  // Matched, the record and the tree spell the same commit, and the
  // checkout below proceeds at git's own canonical rendering of it — the
  // comparison folds case on both sides, exactly as the residue pin does.
  if (args.fetchedSha !== undefined) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(args.fetchedSha)) {
      return unavailable(
        `--fetched-sha ${inertPath(args.fetchedSha)} is not a full Git ` +
          'object ID (40 or 64 hex), and no scratch tree is safe to create ' +
          'or reset against a record the residue pin cannot anchor',
      );
    }
    if (args.fetchedSha.toLowerCase() !== headSha.toLowerCase()) {
      return unavailable(
        `the review worktree is checked out at ${headSha.slice(0, 9)}, not the ` +
          `fetched PR head ${inertPath(args.fetchedSha)} — a scratch tree ` +
          'created now would hold code other than the reviewed head, so ' +
          'none is created or reset until the shared tree is back at its ' +
          'record',
      );
    }
  }

  // BEFORE any checkout runs — the reuse path's reset and the rebuild path's
  // `worktree add` both execute configured content filters.
  const filters = localFilterCommands(worktree);
  if (filters.stopped) {
    return unavailable(
      `the screen could not clear this repository: ${screenStopDetail(filters)}. ` +
        'A screen that did not finish is not a clean result — the checkouts ' +
        'below would EXECUTE any content filter it failed to see.',
    );
  }
  if (filters.keys.length > 0) {
    return unavailable(
      `the repository's local config defines content filter(s) ${screenKeyList(
        filters,
      )} — ` +
        'the checkouts this command runs would EXECUTE them (hooks are disabled, ' +
        'filters are config-driven), and two plain writes into the common dir are ' +
        'enough to plant both the filter and the attributes that select it. Remove ' +
        'the filter config — or the attributes file that uses it — if it is not ' +
        'yours; until then no scratch tree is safe to create or reset.',
    );
  }

  // Read BEFORE the tree is created, so it describes the shared tree as this
  // call found it and can never be confused with anything this call did. The
  // fetched sha, when the caller brought it, is the probe's identity anchor:
  // with it a healthy tree measures clean, and a forged pair is refused at
  // the pin (see worktreeResidue).
  const residue = worktreeResidue(worktree, RESIDUE_PATH_CAP, args.fetchedSha);
  const sharedTreeResidue = residue.paths;
  const residueNote = residue.unmeasured
    ? ` NOTE: whether the shared review worktree is clean could not be measured ` +
      `(reason: ${inertPath(residue.unmeasured)}). An unmeasured tree is not a clean one — if a later read ` +
      'of it surprises you, check the path against `git show HEAD:<path>` before believing it.'
    : sharedTreeResidue.length > 0
      ? ` WARNING: the shared review worktree is NOT clean — ${sharedTreeResidue
          .map((path) => shellQuotePath(inertPath(path)))
          .join(', ')} ` +
        `${sharedTreeResidue.length === 1 ? 'is' : 'are'} not in ${headSha.slice(0, 9)}` +
        (residue.total > sharedTreeResidue.length
          ? `, and ${residue.total - sharedTreeResidue.length} more paths not listed here ` +
            '(run `git status --porcelain --untracked-files=all` in that worktree for the ' +
            'full set — without that flag it collapses a whole probe directory to one entry)'
          : '') +
        '. The names are flattened for display (a filename can carry control or ' +
        'invisible characters); `git status --porcelain --untracked-files=all` in that ' +
        'worktree has the exact bytes if one does not match. Other agents are reading ' +
        "that tree right now and will take those lines for the PR's own code. Restore it before you do anything else, by shape: " +
        '`git checkout HEAD -- <path>` for a tracked file (plain `git checkout --` restores ' +
        'from the INDEX, so it leaves STAGED residue in place); `rm -rf <path>` for anything ' +
        'untracked, including a directory entry (git reports an untracked directory that ' +
        'holds its own `.git` as one `dir/` entry it will not recurse into); and for a path ' +
        'STAGED as new (`A` in `git status`), `git checkout HEAD --` cannot match it at ' +
        'all — `git rm --cached <path>` first, then delete it. A staged RENAME is listed ' +
        'under both of its names and they take opposite commands: the new name is the ' +
        'staged-new case above, while the original is tracked in HEAD and comes back with ' +
        '`git checkout HEAD -- <original>` (`git rm --cached` on it would stage a deletion ' +
        'instead of clearing one).'
      : '';

  const tree = scratchWorktreePath(worktree, label);
  if (existsSync(tree) && resetScratchTree(tree, headSha, worktree)) {
    // The reset clears the ignored state too, so the farm went with it: this
    // re-links it. `rebuild` rather than trusting a marker, because
    // `node_modules` is where a probe is told it may install, and anything a
    // previous probe left there would otherwise resolve as a dependency for
    // every later probe in this shard — a wrong verdict carrying a
    // deterministic source tag. Re-linking costs a second; trusting costs a
    // verdict.
    // `rebuild` rather than deleting the root farm here: this tree also carries
    // a farm per workspace member, and those are ignored paths too — wiping
    // only the root left `<tree>/packages/<member>/node_modules` standing and
    // certified, which is the same hole one level down (Node resolves a
    // member's imports from the member's own `node_modules` first).
    const dependencies = farmDependencies(tree, worktree, { rebuild: true });
    return {
      available: true,
      path: tree,
      headSha,
      reused: true,
      dependencies,
      sharedTreeResidue,
      sharedTreeResidueTotal: residue.total,
      sharedTreeUnmeasured: residue.unmeasured,
      note:
        `your scratch tree is at ${shellQuotePath(tree)}, restored to ${headSha.slice(0, 9)} ` +
        '(reusing the one an earlier call created — everything that is not in the ' +
        'commit is gone: tracked files restored, untracked and IGNORED files ' +
        'deleted, build caches included, and the dependency farm re-linked from ' +
        'the review worktree).' +
        dependencyNote(dependencies) +
        residueNote,
    };
  }

  let sweep: SweepResult | undefined;
  try {
    // Clears both a leftover from a crashed run and a tree the reset above
    // could not rescue; either would fail `add` with `already exists`.
    sweep = discardWorktree(worktree, tree);
    git(worktree, 'worktree', 'add', '--detach', tree, headSha);
  } catch (e) {
    // Not `unavailable()`: the residue was already measured, and a report whose
    // note names contaminated paths while its `sharedTreeResidue` field says
    // `[]` would tell a reader and a script two different things.
    return {
      available: false,
      reused: false,
      dependencies: null,
      sharedTreeResidue,
      sharedTreeResidueTotal: residue.total,
      sharedTreeUnmeasured: residue.unmeasured,
      note:
        `${inertPath(worktreeCreateFailureDetail('scratch', e, String(sweep?.stderr ?? '')))}. ` +
        'Do NOT fall back to probing in the review worktree — other agents are ' +
        'reading it. A probe you cannot isolate is inconclusive, and the ' +
        'finding keeps the reading-based verdict and its low-confidence floor.' +
        residueNote,
    };
  }

  // `rebuild` on the FRESH path too: `node_modules` is gitignored by convention,
  // not by rule, so a pull request can commit one — marker and all — and
  // `git worktree add` checks it out. Nothing a PR ships is the farm.
  const dependencies = farmDependencies(tree, worktree, { rebuild: true });
  return {
    available: true,
    path: tree,
    headSha,
    reused: false,
    dependencies,
    sharedTreeResidue,
    sharedTreeResidueTotal: residue.total,
    sharedTreeUnmeasured: residue.unmeasured,
    note:
      `your scratch tree is at ${shellQuotePath(tree)}, checked out at ${headSha.slice(0, 9)}. ` +
      'Write your probe there, mutate there, apply the candidate fix there; the ' +
      'review worktree stays read-only. `cleanup` sweeps this at the end of the ' +
      'review. It is a LINKED worktree, so its working tree is yours alone but ' +
      "the repository state behind it — hooks, config, refs — is the user's own " +
      'repository: this command runs its own git with hooks disabled, and you ' +
      'should treat anything under `git rev-parse --git-common-dir` as shared, ' +
      'not scratch.' +
      dependencyNote(dependencies) +
      residueNote,
  };
}

/**
 * Link the review worktree's `node_modules` into the scratch tree, so a unit
 * harness starts without a per-tree install.
 *
 * The same farm the test-efficacy probe builds, and shared with it for the same
 * reason: an install per probe would cost minutes the verifier does not have,
 * and a scratch tree a probe cannot run in is a scratch tree nobody uses. The
 * review worktree is the source because that is the tree Agent 7 installed and
 * built — workspace packages resolve through it to code the PR head produced.
 * (Those links point OUT of the scratch tree, which is why a cross-package
 * mutation is one this isolation cannot show flipping. Reads are unaffected,
 * and a write through one of those links lands in the review worktree, which
 * is why the verifier's block says to replace a link with a copy before
 * modifying a dependency.)
 */
function farmDependencies(
  tree: string,
  worktree: string,
  opts: { rebuild?: boolean } = {},
): DependencyFarm | null {
  if (!existsSync(resolve(worktree, 'node_modules'))) return null;
  // No try/catch: `exposeDependencies` guards every fs call it makes and counts
  // what failed, so a link failure arrives as `{linked: 0, failed: N}` — which
  // is the honest note — rather than as a throw this would have to translate.
  // A catch here would be unreachable code pretending to be a safety net.
  return exposeDependencies(tree, worktree, opts);
}

function dependencyNote(farm: DependencyFarm | null): string {
  if (farm === null) {
    return (
      ' The review worktree has no `node_modules`, so nothing was linked in and ' +
      'a JS unit harness will not start here — install in the SCRATCH tree if you ' +
      'need one, never in the review worktree.'
    );
  }
  if (farm.linked === 0 && farm.failed === 0) {
    // `alreadyPresent` cannot be true here — this command always rebuilds, so a
    // standing farm is never reused — which leaves exactly one reading: the
    // source had nothing linkable (the shape a killed `npm install` leaves, a
    // `node_modules` holding only a lockfile).
    return (
      " The review worktree's `node_modules` held nothing linkable, so a JS " +
      'unit harness will not start here — install in the SCRATCH tree if you ' +
      'need one, never in the review worktree.'
    );
  }
  return (
    ` ${farm.linked} dependencies linked in` +
    (farm.failed > 0
      ? `, ${farm.failed} could not be${farm.linked === 0 ? ' — so a JS unit harness may not start here' : ''}: a harness that cannot resolve a package is an environment gap, not a finding, and never a reason to probe in the review worktree instead.`
      : '.')
  );
}

export const scratchTreeCommand: CommandModule = {
  command: 'scratch-tree',
  describe:
    "Create this agent's own throwaway worktree at the commit under review, so " +
    'probes, mutants and candidate fixes never touch the shared review worktree ' +
    'other agents are reading',
  builder: (yargs) =>
    yargs
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe:
          'The PR worktree — the scratch tree is created beside it, at its HEAD',
      })
      .option('label', {
        type: 'string',
        demandOption: true,
        describe:
          'What makes this tree yours: pass the record key from your launch ' +
          'block. Two agents sharing a label share a tree, which is the race ' +
          'this command exists to remove.',
      })
      .option('fetched-sha', {
        type: 'string',
        describe:
          'The commit the worktree must hold, as fetch-pr recorded it in the ' +
          'plan: the shared-tree residue check pins the tree to it, so a ' +
          'healthy tree measures clean and a forged identity is refused. ' +
          'Without it an empty measurement is reported as unmeasured, never ' +
          'clean; malformed or disagreeing with the worktree HEAD, the ' +
          'command refuses before creating or resetting anything.',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      }),
  handler: (argv) => {
    const args = argv as unknown as ScratchTreeArgs;
    try {
      // BEFORE the worktree is created, like every sibling command: an empty or
      // directory `--out` otherwise survives to `writeFileSync`, dies EISDIR
      // after a tree and a 1 700-link farm already exist, and exit-codes as a
      // runtime failure instead of the repairable-invocation class.
      if (args.out !== undefined) assertWritableOutPath(args.out);
      const report = runScratchTree(args);
      // stdout FIRST: the report is the answer, and a caller scripting on it
      // should not lose a usable tree's path to a failed side-file write.
      writeStdoutLine(JSON.stringify(report, null, 2));
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStderrLine(`scratch-tree: ${report.note}`);
    } catch (err) {
      writeStderrLine(`scratch-tree: ${(err as Error).message}`);
      // 2 is the caller's "repair the invocation" signal; 1 is a runtime
      // failure it can only retry.
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
