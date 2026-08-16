/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Disposable sibling worktrees, and the steps their users need.
//
// `test-efficacy` runs its mutants in one; `base-tree` builds the merge-base in
// another; `scratch-tree` hands a third to each Step 4 verifier. All three add a
// tree beside the review worktree, all must survive a leftover from a crashed
// run, and all need the sweep's stderr to explain a subsequent `add` failure —
// so the step lives here rather than three times.
//
// The residue probe below is the same subject seen from the other side: the
// reason those trees exist is that the SHARED review worktree must stay exactly
// as the PR left it while other agents read it.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readWorkspacePackages } from './workspaces.js';

export type SweepResult = ReturnType<typeof spawnSync>;

/**
 * Free a disposable worktree's path: unregister it, then remove what is left.
 *
 * `git worktree remove --force` only clears a tree git still tracks. A directory
 * left at the path after metadata loss or a partial cleanup is reported "not a
 * working tree" and left in place — and a *non-empty* one then makes
 * `git worktree add` fail `already exists`, wedging every later run until
 * someone clears it by hand. So the unregister is followed by a plain remove of
 * whatever dir remains. `rmSync` unlinks a symlink rather than following it, so
 * a tampered leftover cannot redirect the delete outside `tree`.
 *
 * This is `releaseWorktree`'s two-step, and deliberately NOT a call to it:
 * `releaseWorktree` runs git from the process cwd, which need not be this
 * worktree's repo, and it discards the sweep's stderr — which is usually the
 * only thing that explains a subsequent `add` failure. Every caller here needs
 * `cwd` and that stderr.
 *
 * Best-effort by design: a clean path is the normal case, so the unregister does
 * not throw on a non-zero status. `rmSync` still can (`force` suppresses ENOENT
 * but not EPERM/EBUSY) — callers decide what that means.
 */
export function discardWorktree(cwd: string, tree: string): SweepResult {
  let sweep = spawnSync('git', ['worktree', 'remove', '--force', tree], {
    cwd,
    encoding: 'utf8',
  });
  if (sweep.status !== 0) {
    // A LOCKED admin entry is the one leftover neither `remove --force` nor
    // `prune` can clear, and probe code has a shell inside these trees: one
    // `touch` in the admin dir the tree's own gitfile names is enough. Every
    // later `worktree add` at that path then fatals "missing but locked", for
    // every disposable tree of that review, until a human intervenes. `unlock`
    // + the second `--force` is what git documents for exactly this.
    spawnSync('git', ['worktree', 'unlock', tree], { cwd, encoding: 'utf8' });
    sweep = spawnSync(
      'git',
      ['worktree', 'remove', '--force', '--force', tree],
      { cwd, encoding: 'utf8' },
    );
  }
  rmSync(tree, { recursive: true, force: true });
  // And clear the ADMIN entry the two steps above can leave behind — but only
  // THIS path's. A tree whose `.git` gitfile is broken makes `worktree remove`
  // fail; `rmSync` then takes the directory, and `.git/worktrees/<name>`
  // survives, so the next `worktree add` here refuses "missing but already
  // registered". A repo-wide `git worktree prune` clears that and much more: it
  // deregisters ANY entry whose directory is momentarily absent — another
  // shard's `worktree add` mid-flight (this pipeline runs discards and adds
  // concurrently against one common dir), or the user's own worktree on a
  // volume that happens to be unmounted. So the entry is found by its own
  // `gitdir` file and removed alone.
  dropWorktreeRegistration(cwd, tree);
  return sweep;
}

/** The residue probe's answer: what to name, and how much it left unnamed. */
export interface WorktreeResidue {
  /** The dirty paths, capped — every one of them safe to interpolate. */
  paths: string[];
  /**
   * How many the tree actually holds. `total > paths.length` means the cap bit,
   * and both renderers say so: a capped list presented as the complete one is a
   * verifier restoring twelve paths and leaving the thirteenth in the tree the
   * next round reads.
   */
  total: number;
  /**
   * Why the check could not run, when it could not. An empty list means "clean"
   * ONLY when this is absent: a `git status` that died — ENOBUFS on a tree so
   * dirty its output passed the buffer, a repository git refused to read — used
   * to be indistinguishable from a pristine tree, and the overload case is
   * exactly the one where the answer matters. Both renderers say "could not be
   * measured" instead of "clean" when this is set.
   */
  unmeasured?: string;
}

/**
 * Remove the admin entry that names `tree`, and nothing else.
 *
 * `<common>/worktrees/<id>/gitdir` holds the path of the `.git` FILE inside the
 * working tree, so the entry for a given path is identifiable without asking
 * git to sweep. Best-effort throughout: a leftover admin entry costs the next
 * `worktree add` at this path, which the caller reports; guessing wider costs
 * somebody else's worktree.
 */
function dropWorktreeRegistration(cwd: string, tree: string): void {
  const common = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8' },
  );
  if (common.status !== 0 || typeof common.stdout !== 'string') return;
  const dir = join(common.stdout.trim(), 'worktrees');
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return; // No linked worktrees at all.
  }
  const wanted = samePath(tree);
  for (const id of ids) {
    try {
      const gitdir = readFileSync(join(dir, id, 'gitdir'), 'utf8').trim();
      // `gitdir` names `<tree>/.git`; compare the tree it belongs to.
      if (samePath(dirname(gitdir)) !== wanted) continue;
      rmSync(join(dir, id), { recursive: true, force: true });
    } catch {
      // Unreadable entry: leave it. The next `add` will say so.
    }
  }
}

/**
 * A path in the one spelling both sides of that comparison can produce.
 *
 * git records the entry's path as git resolved it, and this code holds the path
 * as the caller spelled it — on macOS that is `/private/var/…` against
 * `/var/…`, and the entry then matches nothing. The PARENT is resolved rather
 * than the path itself, because the tree is usually already deleted by the time
 * this runs.
 */
function samePath(p: string): string {
  const abs = resolve(p);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/**
 * The residue probe's build-artifact exclusion, enforced by the PIPELINE
 * rather than borrowed from the commit: `core.excludesFile` applies whether
 * or not the HEAD `.gitignore` covers these names (see worktreeResidue).
 * Writing the repository's own `info/exclude` is not an option: from a linked
 * worktree it resolves to the user's COMMON repository.
 */
let pipelineExcludesFile: string | null = null;
function pipelineExcludeArgs(): string[] {
  if (pipelineExcludesFile === null) {
    try {
      // Forward slashes: git's config parser reads backslashes as escapes.
      const file = join(tmpdir(), 'qwen-review-residue-excludes')
        .split(sep)
        .join('/');
      writeFileSync(file, 'node_modules/\ndist/\n');
      pipelineExcludesFile = file;
    } catch {
      // No tmp file: fall back to the commit's own ignore rules, which cover
      // the ordinary repo.
      pipelineExcludesFile = '';
    }
  }
  return pipelineExcludesFile === ''
    ? []
    : ['-c', `core.excludesFile=${pipelineExcludesFile}`];
}

/**
 * The paths a tree carries that its HEAD commit does not — probe residue, seen
 * from the reading side (#9207).
 *
 * A review worktree is a pristine detached checkout of the PR head, and every
 * build artifact the review produces there is gitignored, so in a healthy run
 * this is empty. What it catches is the one thing that is neither: a file some
 * agent wrote into the shared tree, or a line it edited there, while the
 * pipelined loop had another agent reading the same tree. Named paths, not a
 * boolean — "the tree is dirty" tells a reader nothing it can act on, whereas
 * "these three paths are not in the commit" tells it exactly which of its
 * evidence to distrust.
 *
 * Three flags decide whether the names are usable, and every one of them was
 * wrong in the first cut:
 *
 * - `-z` because the names become COMMANDS. Porcelain's rendered form quotes a
 *   path with spaces or non-ASCII bytes (`"caf\303\251.ts"`) and writes a
 *   rename as `orig -> new`, so a file literally named `a -> b.ts` parsed to
 *   `b.ts"` — a name matching nothing on disk, handed to an agent as the path
 *   to run `git show HEAD:` against. The NUL format is unquoted and puts a
 *   rename's original path in its own record.
 * - `--untracked-files=all` because `normal` collapses a new directory to one
 *   `probe_dir/` entry, and every recovery this pipeline prints — `git show
 *   HEAD:`, `git checkout HEAD --` — fails on a directory. The contamination
 *   shape this exists to catch (an agent dropping probe files into a new
 *   folder) is exactly the shape `normal` renders unactionable. One directory
 *   shape survives the flag: git will not recurse into an untracked directory
 *   that holds its own `.git`, so a cloned fixture still arrives as a single
 *   `dir/` entry — detected and disclosed, but recoverable only by `rm -rf`,
 *   which is what both renderers tell the reader to use for untracked residue.
 * - `maxBuffer` because the default is 1 MB and `spawnSync` answers ENOBUFS by
 *   returning no stdout — which this function would have read as "clean". The
 *   overload case is the one where the tree is dirtiest.
 *
 * Ignored files are excluded, and the pipeline's own build artifacts
 * (`node_modules`, `dist`) are excluded even when the COMMIT under review
 * does not ignore them: the review builds in this tree, and a PR whose
 * `.gitignore` does not cover its install used to turn that install into
 * residue — every verifier's first act aimed at deleting the very tree its
 * farm borrows from.
 *
 * The tree's identity is checked before its state: git's repository discovery
 * walks UP, so a directory whose `.git` file is gone answers `git status`
 * with the enclosing user checkout's dirty state — the wrong tree, measured
 * silently, and the restore recipe this probe triggers aimed at the user's
 * own files. That shape fails closed instead.
 *
 * Empty on any git failure: this is a diagnostic, and a diagnostic that throws
 * would fail the build it is only commenting on.
 *
 * One limit the NUL format does not remove: `encoding: 'utf8'` maps an invalid
 * UTF-8 byte in a filename to U+FFFD, so such a path is reported but no longer
 * resolves on disk. No string form of it can — Node's fs API takes strings here
 * — so the name is disclosed as git rendered it rather than silently dropped.
 */
export function worktreeResidue(cwd: string, cap = 12): WorktreeResidue {
  // git's discovery WALKS UP: with the `.git` file gone — a crash mid-`worktree
  // add`, a cleanup whose `rmSync` failed — `status` exits 0 against the
  // enclosing user checkout: the wrong tree's dirty state answered as this
  // one's. Fail closed the way a loud git failure below does.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  let isWorktree = false;
  try {
    isWorktree =
      !top.error &&
      top.status === 0 &&
      typeof top.stdout === 'string' &&
      realpathSync(top.stdout.trim()) === realpathSync(cwd);
  } catch {
    // A cwd that no longer resolves is not a tree this probe can measure.
  }
  if (!isWorktree) {
    return {
      paths: [],
      total: 0,
      unmeasured:
        'the path is not a git worktree (repository discovery walks up into ' +
        'the enclosing checkout)',
    };
  }
  const r = spawnSync(
    'git',
    [
      ...pipelineExcludeArgs(),
      'status',
      '--porcelain',
      '--untracked-files=all',
      '-z',
    ],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    const why = r.error
      ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message)
      : `git status exited ${r.status}`;
    return { paths: [], total: 0, unmeasured: why };
  }
  const records = r.stdout.split('\0').filter((rec) => rec.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // `XY <path>` — the status letters are noise to a reader; the path is what
    // it has to act on. A rename or copy spends a SECOND record on the ORIGINAL
    // path, and both names are reported: the destination is what sits in the
    // tree, and the original is what is missing from it, so a restore needs
    // both. Reporting only the destination left the reader with a `D <orig>`
    // it had never been given the name of.
    const status = rec.slice(0, 2);
    paths.push(rec.slice(3));
    if (
      (status.includes('R') || status.includes('C')) &&
      i + 1 < records.length
    ) {
      paths.push(records[++i]);
    }
  }
  return { paths: paths.slice(0, cap), total: paths.length };
}

/** What a dependency farm run did, and whether it found one already standing. */
export interface DependencyFarm {
  /** Packages symlinked in by THIS call. */
  linked: number;
  /** Packages this call could not link — disclosed, never silently dropped. */
  failed: number;
  /** True when a farm was already in place, so this call had nothing to link. */
  alreadyPresent: boolean;
  /**
   * How many of the linked packages are the repo's OWN workspace members
   * (`node_modules/@scope/pkg` → `../../packages/pkg`). Those links resolve
   * back into the dependency root, so a mutation made in the disposable tree is
   * invisible to any import that goes through the package NAME. Counted so the
   * callers can say so rather than leave it as a property of the layout.
   */
  selfLinked: number;
}

/**
 * Make the dependency root's installed packages resolvable from a disposable
 * tree, by symlinking each `node_modules` entry into it.
 *
 * A fresh `git worktree add` has no `node_modules`, and a per-tree `npm ci`
 * costs minutes that neither the efficacy probe's budget nor a verifier's
 * patience has. So the packages are borrowed rather than installed: the tree
 * holds the CODE under test and reads its dependencies out of the tree that
 * already installed them.
 *
 * The root farm is not the whole job in a monorepo. npm hoists what it can, but
 * a version conflict leaves packages installed under the MEMBER
 * (`packages/cli/node_modules`), and Node resolves those by walking up from the
 * importing file — so a tree with only the root farm fails to resolve exactly
 * the dependency that could not be hoisted. Measured on this repo: a scratch
 * tree with 1 560 root packages linked still could not resolve
 * `@testing-library/react` for a UI probe, because that copy lives under
 * `packages/cli`. Each workspace member's farm is therefore built too, for the
 * members the disposable tree actually contains.
 *
 * Best-effort per entry, and deliberately so: one locked or concurrently
 * unlinked package must not throw out of the run that asked for the farm (for
 * the probe, that would re-class every mutant `inconclusive`). What could not
 * be linked is counted and disclosed by the caller, never silently dropped.
 *
 * **The links are read-write, and they point OUT of the disposable tree.** A
 * probe that writes through one — `writeFileSync(require.resolve('dep/x.js'))`,
 * an `npm rebuild`, a package that writes into its own directory at runtime —
 * lands in the dependency root's copy, which is the shared review worktree, and
 * `node_modules` is gitignored so the residue probe cannot see it. Copying the
 * farm instead would cost the minutes the farm exists to save, so the contract
 * is stated rather than enforced: the tree's own files are yours, its
 * dependencies are borrowed, and a probe that needs to modify a dependency must
 * replace the LINK with a copy rather than write through it. The verifier's
 * brief says the same in the words it acts on.
 *
 * Shared by `test-efficacy`'s `-probe` tree and `scratch-tree`'s per-verifier
 * tree, which is why it sits here rather than in either of them.
 */
export function exposeDependencies(
  probeTree: string,
  dependencyRoot: string,
  opts: { rebuild?: boolean } = {},
): DependencyFarm {
  const done: DependencyFarm = {
    linked: 0,
    failed: 0,
    alreadyPresent: false,
    selfLinked: 0,
  };
  if (probeTree === dependencyRoot) return done;
  farmNodeModules(dependencyRoot, probeTree, done, opts.rebuild === true);
  let members: string[] = [];
  try {
    const graph = readWorkspacePackages(dependencyRoot);
    // `skipped` members are real directories npm links; the graph just cannot
    // model their ownership. Farming them costs one directory read each and
    // spares a probe an unresolvable import in a package that does exist.
    members = [...graph.packages.map((p) => p.dir), ...graph.skipped];
  } catch {
    // The workspace graph is an optimization on top of the root farm: a
    // manifest that will not read costs the tree its nested packages, never
    // the farm it already has.
  }
  for (const dir of members) {
    // The member list comes from the ROOT MANIFEST OF THE CODE UNDER REVIEW, and
    // this loop both deletes and creates at the paths it names — so it is
    // treated as the untrusted input it is. `workspaces: ["../.."]` resolves to
    // a directory outside both trees (a scratch tree is a sibling, so the same
    // one for source and target), and the farm's opening `rmSync` would take
    // that directory's `node_modules` — the reviewer's own, in the layout this
    // pipeline builds. `realpathSync` rather than string arithmetic because a
    // COMMITTED SYMLINK at a workspace path is fully contained as a string and
    // still lands the same delete outside the tree; `readWorkspacePackages`
    // deliberately follows such links, because npm does.
    const source = containedIn(dependencyRoot, dir);
    const target = containedIn(probeTree, dir);
    if (!source || !target) {
      // Only count it when the member exists at all — a workspace glob that
      // matches nothing is ordinary, an escape is not.
      if (existsSync(join(dependencyRoot, dir))) done.failed++;
      continue;
    }
    // Only for a member the disposable tree holds. A workspace the tree does
    // not contain has nothing to resolve FROM, and creating its directory just
    // to hang a `node_modules` off it would put a path in the tree that its
    // commit does not have.
    if (!existsSync(target)) continue;
    // Per member, not around the loop: one unreadable member used to abort the
    // walk, so every alphabetically later member silently went unfarmed while
    // `failed` stayed 0 and the caller reported success.
    try {
      farmNodeModules(source, target, done, opts.rebuild === true);
    } catch {
      done.failed++;
    }
  }
  return done;
}

/**
 * `<root>/<dir>` when it really is inside `<root>`, and null when it is not.
 *
 * Both halves are resolved through symlinks before the comparison, so neither a
 * `..` in the manifest's own string nor a committed symlink at the member path
 * can point the caller's `rmSync` outside the tree it was given. A directory
 * that does not exist yet resolves through its nearest existing ancestor, which
 * is the case a fresh probe tree hits for every member it does not contain.
 */
function containedIn(root: string, dir: string): string | null {
  try {
    const base = realpathSync(resolve(root));
    const full = resolve(base, dir);
    const real = existsSync(full) ? realpathSync(full) : full;
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The file a farm this code built leaves behind, so a later call can tell its
 * own work from anything else that happens to sit at that path.
 *
 * `node_modules` is gitignored, which is what lets a scratch tree's reset spare
 * it — and equally what lets a probe's own `npm install`, a killed install, or
 * a planted module stub survive that reset. Without a marker the reuse path
 * certified any non-empty directory as "the farm already in place", and every
 * later probe in that shard resolved its imports through whatever was there.
 */
const FARM_MARKER = '.qwen-review-farm';

/**
 * Was this farm built by this code, for this dependency root?
 *
 * Existence alone is not provenance: `node_modules` is gitignored by
 * convention, not by rule, so a pull request can force-add
 * `node_modules/.qwen-review-farm` beside its own module stubs and `git
 * worktree add` will check both out — PR CONTENT reaching the certification
 * path with no execution at all. The marker therefore records the dependency
 * root it was built from, and a marker that does not name this one is not ours.
 * (The callers that reuse a tree across probe runs pass `rebuild` and never
 * consult this at all.)
 */
/**
 * Does this `node_modules` entry lead back into the dependency root's own
 * source — an npm workspace SELF-link (`@scope/pkg` → `../../packages/pkg`)?
 *
 * Those are the links a disposable tree cannot make local: they resolve to the
 * dependency root's copy, which is the tree the caller is trying to stay out
 * of, so a mutation made in the disposable tree is invisible to any import that
 * goes through the package NAME rather than a relative path. Re-pointing them
 * at the disposable tree would break resolution outright for a package whose
 * entry point is a build artifact the fresh checkout does not have — so they
 * are counted and disclosed instead of silently mirrored.
 */
function resolvesInside(entry: string, root: string): boolean {
  try {
    const real = realpathSync(entry);
    const base = realpathSync(resolve(root));
    return (
      (real === base || real.startsWith(base + sep)) &&
      !real.startsWith(join(base, 'node_modules') + sep)
    );
  } catch {
    return false;
  }
}

function marksOurFarm(target: string, sourceDir: string): boolean {
  try {
    return (
      readFileSync(join(target, FARM_MARKER), 'utf8').trim() ===
      resolve(sourceDir)
    );
  } catch {
    return false;
  }
}

/**
 * One directory's `node_modules`, mirrored entry by entry.
 *
 * A directory that already has one is left alone only for callers that do NOT
 * pass `rebuild` — and that case is RECORDED rather than merely skipped:
 * `{linked: 0, failed: 0}` otherwise reads the same whether the farm was
 * already standing or the source had nothing to link (a killed `npm install`
 * leaves a `node_modules` holding one lockfile), and the two want opposite
 * things said to the verifier — "your harness is ready" versus "no harness
 * will start here". The production callers — scratch-tree's reuse path and
 * the probe suite — all pass `rebuild`, so a standing farm is wiped and
 * re-linked every time; the reuse branch is reachable only from tests.
 */
function farmNodeModules(
  sourceDir: string,
  targetDir: string,
  done: DependencyFarm,
  rebuild = false,
): void {
  const source = join(sourceDir, 'node_modules');
  const target = join(targetDir, 'node_modules');
  if (!existsSync(source)) {
    // With `rebuild`, the target is cleared even when there is nothing to link
    // from: the caller is resetting a tree it will hand to another probe, and a
    // farm the PREVIOUS probe installed there (a member whose source has no
    // `node_modules`, or a root the review worktree never installed) would
    // otherwise survive a reset the report calls pristine.
    if (rebuild) {
      // `lstatSync`, not `existsSync`: the latter follows links, so a DANGLING
      // symlink at the target read as absent and the wipe was skipped — while
      // the link itself stayed to redirect whatever wrote there next.
      try {
        lstatSync(target);
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') done.failed++;
      }
    }
    return;
  }
  // `existsSync` follows links, so a symlink at the dependency root's
  // `node_modules` would redirect every farm — every probe tree of every shard
  // — at whatever it points to. A real install is a directory.
  try {
    if (!lstatSync(source).isDirectory()) {
      done.failed++;
      return;
    }
  } catch {
    done.failed++;
    return;
  }
  // `lstatSync`, not `existsSync`: the latter follows links, so a DANGLING
  // symlink at the target reads as absent, the wipe below is skipped, and
  // `mkdirSync` dies EEXIST on every attempt. A PR can commit `node_modules`
  // as exactly that — force-add defeats gitignore — and `checkout --force` /
  // `clean -ffdx` both spare a TRACKED symlink, so every reset recreates the
  // shape. Same hazard, and same fix, as the no-source branch above.
  let targetPresent = true;
  try {
    lstatSync(target);
  } catch {
    targetPresent = false;
  }
  if (targetPresent) {
    // A standing farm counts only if THIS code built it: the marker is the
    // difference between "the packages I linked last time" and "whatever a
    // probe left in the one directory it is allowed to install into". Anything
    // else at that path is cleared and re-linked, because a probe's leftover
    // module resolving as a dependency is a wrong verdict with a deterministic
    // source tag on it. `rebuild` goes further and distrusts even a marked
    // farm — the caller that reuses a tree ACROSS probe runs cannot know what
    // ran in it, and re-linking costs a second where trusting costs a verdict.
    if (!rebuild && marksOurFarm(target, sourceDir)) {
      done.alreadyPresent = true;
      return;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Cannot clear it: leave it, and report nothing linked rather than
      // claiming a farm this code did not build.
      done.failed++;
      return;
    }
  }
  try {
    mkdirSync(target);
  } catch {
    // Same best-effort contract as the per-entry steps below: a farm that
    // cannot be created costs a harness, and must not throw out of the run
    // that asked for it.
    done.failed++;
    return;
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  let entries: Dirent[];
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    // The source is the SHARED review worktree: a concurrent `npm ci` there can
    // unlink it between the `existsSync` above and this read.
    done.failed++;
    return;
  }
  const before = done.linked;
  for (const entry of entries) {
    if (entry.name === '.vite' || entry.name === '.vite-temp') continue;
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    // Every per-entry step is guarded: this is best-effort, so one locked or
    // concurrently-unlinked entry must not throw out of the probe run (which
    // would mark every probe `inconclusive`). What cannot be linked is counted
    // and disclosed by the caller — never silently dropped.
    let sourceStats: Stats;
    try {
      sourceStats = lstatSync(sourceEntry);
    } catch {
      done.failed++;
      continue;
    }
    if (sourceStats.isSymbolicLink()) {
      try {
        if (!statSync(sourceEntry).isDirectory()) continue;
      } catch {
        // A DANGLING link is a package the tree will not resolve, and the
        // caller's whole contract is that what could not be linked is counted.
        done.failed++;
        continue;
      }
    } else if (!sourceStats.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith('@')) {
      let pkgs: string[];
      try {
        mkdirSync(targetEntry);
        pkgs = readdirSync(sourceEntry);
      } catch {
        done.failed++;
        continue;
      }
      for (const pkg of pkgs) {
        const scopedSource = join(sourceEntry, pkg);
        if (resolvesInside(scopedSource, sourceDir)) done.selfLinked++;
        // Same skip the top-level branch applies: a stray FILE under a scope
        // directory is not a package, and linking it as one is a link the
        // resolver will follow to something that cannot be imported.
        try {
          if (!statSync(scopedSource).isDirectory()) continue;
        } catch {
          done.failed++;
          continue;
        }
        try {
          symlinkSync(scopedSource, join(targetEntry, pkg), linkType);
          done.linked++;
        } catch {
          done.failed++;
        }
      }
    } else {
      if (resolvesInside(sourceEntry, sourceDir)) done.selfLinked++;
      try {
        symlinkSync(sourceEntry, targetEntry, linkType);
        done.linked++;
      } catch {
        done.failed++;
      }
    }
  }
  // Marked only when something was actually linked. A farm of zero packages is
  // not one a later call should reuse — the killed-install shape (a
  // `node_modules` holding one lockfile) produces exactly that, and certifying
  // it sends the verifier into a `vitest: not found` the note promised it had
  // avoided.
  if (done.linked > before) {
    try {
      writeFileSync(join(target, FARM_MARKER), `${resolve(sourceDir)}\n`);
    } catch {
      // No marker: the next call rebuilds the farm. Costly, never wrong.
    }
  }
}

/**
 * The reason a disposable worktree could not be created.
 *
 * The stale-sweep's stderr is folded in because it is usually the explanation:
 * when `add` fails on a leftover the sweep could not clear, the sweep is what
 * says why. Pure, and extracted for that reason — the branch it lives on fires
 * only when `git worktree add` fails, and there is no portable way to force that
 * in a real-git test (the one lever, making `.git/worktrees` unwritable, is
 * bypassed by root and behaves differently under CI's unprivileged user).
 */
export function worktreeCreateFailureDetail(
  label: string,
  err: unknown,
  sweepStderr: string,
): string {
  const sweepErr = sweepStderr.trim();
  return (
    `${label} worktree could not be created: ${err instanceof Error ? err.message : String(err)}` +
    (sweepErr ? ` (stale-tree sweep also reported: ${sweepErr})` : '')
  );
}
