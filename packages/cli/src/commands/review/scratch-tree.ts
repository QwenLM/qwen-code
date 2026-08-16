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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  discardWorktree,
  exposeDependencies,
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
   * standing. `null` when no farm could be built at all — the review worktree
   * has no `node_modules`, or the linking failed — and the note says WHICH,
   * because the two want opposite things done about them.
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
 * that holds no hooks is the whole fix for OUR invocations; what a probe does
 * with its own shell is the probe's business, and the report says plainly that
 * the common dir is shared rather than isolated.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null/no-hooks'];

function gitOut(cwd: string, ...args: string[]): string {
  // `ls-files -v` prints a line per tracked file and `clean` a line per removal;
  // both pass the default 1 MiB buffer on a large repo, and `spawnSync` answers
  // that by killing the child — which this function reads as a git failure and
  // the reset reads as "rebuild", permanently, for every call.
  const r = spawnSync('git', [...NO_HOOKS, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
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
 * `clean -ffd` removes the probe files, nested repositories a probe cloned or
 * `git init`-ed included; ignored paths are deliberately spared,
 * because that is where the dependency farm lives and rebuilding it every call
 * is the whole cost this reuse path exists to avoid.
 */
function resetScratchTree(tree: string, headSha: string): boolean {
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
  try {
    git(tree, 'checkout', '--force', '--detach', headSha);
    // `-ff`, not `-f`: a single `-f` refuses to delete a nested git repository,
    // so a probe that cloned or `git init`-ed a fixture inside the scratch tree
    // survives the reset while the report says the tree is pristine. `-x` is
    // deliberately NOT passed — ignored paths are where the dependency farm
    // lives, and rebuilding it every call is the cost this reuse path exists to
    // avoid.
    git(tree, 'clean', '-ffd');
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
    return gitOut(tree, 'rev-parse', 'HEAD') === headSha;
  } catch {
    // A tree too broken to reset is not a tree to probe in. The caller
    // discards and rebuilds it rather than handing back a half-known state.
    return false;
  }
}

export function runScratchTree(args: ScratchTreeArgs): ScratchTreeReport {
  const unavailable = (note: string): ScratchTreeReport => ({
    available: false,
    reused: false,
    dependencies: null,
    sharedTreeResidue: [],
    sharedTreeResidueTotal: 0,
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

  let headSha: string;
  try {
    headSha = gitOut(worktree, 'rev-parse', 'HEAD');
  } catch (err) {
    return unavailable(
      `cannot read HEAD in ${worktree}: ${(err as Error).message}`,
    );
  }

  // Read BEFORE the tree is created, so it describes the shared tree as this
  // call found it and can never be confused with anything this call did.
  const residue = worktreeResidue(worktree);
  const sharedTreeResidue = residue.paths;
  const residueNote = residue.unmeasured
    ? ` NOTE: whether the shared review worktree is clean could not be measured (git status ` +
      `failed: ${residue.unmeasured}). An unmeasured tree is not a clean one — if a later read ` +
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
        '. Other agents are reading that tree right now and will take those lines for the ' +
        "PR's own code. Restore it before you do anything else, by shape: " +
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
  if (existsSync(tree) && resetScratchTree(tree, headSha)) {
    // The reset spares ignored paths — that is what keeps the farm cheap — and
    // `node_modules` is exactly where a probe is told it may install. So the
    // farm is the one ignored path that does NOT survive a reuse: anything a
    // previous probe added there would otherwise resolve as a dependency for
    // every later probe in this shard, which is a wrong verdict carrying a
    // deterministic source tag. Re-linking costs a second; trusting it costs a
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
        '(reusing the one an earlier call created — every tracked file is back at ' +
        'the commit and every untracked file you wrote is gone; GITIGNORED paths ' +
        'are deliberately spared, which is what keeps the dependency farm, so a ' +
        'build cache or a `dist/` from your last probe is still there).' +
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
        `${worktreeCreateFailureDetail('scratch', e, String(sweep?.stderr ?? ''))}. ` +
        'Do NOT fall back to probing in the review worktree — other agents are ' +
        'reading it. A probe you cannot isolate is inconclusive, and the ' +
        'finding keeps the reading-based verdict and its low-confidence floor.' +
        residueNote,
    };
  }

  const dependencies = farmDependencies(tree, worktree);
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
 * and reads are all that leave the scratch tree.)
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
    // Two different states reach `{0, 0}`, and the honest sentence differs:
    // the farm was already standing (a second call for the same shard), or the
    // source had nothing linkable at all (the shape a killed `npm install`
    // leaves: a `node_modules` holding only a lockfile).
    return farm.alreadyPresent
      ? ' Its `node_modules` was already in place.'
      : " The review worktree's `node_modules` held nothing linkable, so a JS " +
          'unit harness will not start here — install in the SCRATCH tree if ' +
          'you need one, never in the review worktree.';
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
