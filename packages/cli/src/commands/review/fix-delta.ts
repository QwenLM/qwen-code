/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review fix-delta`: what `--fix` actually changed, as a diff — the fix
// auditor's input (Step 6B).
//
// The question the audit asks is about the EDIT, not the diff under review: a
// local review's tree already carries the user's uncommitted change, and the
// fixer's hunks land on top of it, so `git diff HEAD` after the edits is the
// user's change and the fix together, indistinguishable. The edit is the
// difference between two states of the same working tree — before the first
// `edit` call and after the last — so this command records the first state and
// diffs the second against it.
//
// The record is a git tree object, written through a THROWAWAY index: read
// HEAD into it, `add -A` the working tree, `write-tree`. The user's own index
// is never written (a `--fix` review runs in their checkout, and their staging
// state is theirs), the stash stack is never touched (it is shared across
// worktrees and other sessions), and nothing is checked out or reset. The tree
// object is unreferenced garbage after the review — the same thing `git stash
// create` leaves behind — and `add -A` is what decides what counts: modified,
// deleted and untracked-unignored files, which is exactly the set a fix's test
// file lands in.
//
// The review's own side files are excluded from the diff by pathspec, not by
// hoping they are ignored: the ledger, the artifact and the snapshot itself are
// written between the two states, and a hunks file that carried them would
// hand the auditor its own bookkeeping as an edit to audit.

import type { CommandModule } from 'yargs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, gitRaw, gitWithEnv } from './lib/git.js';

/** What `--snapshot` writes and `--since` reads back. */
export interface FixSnapshot {
  /** The repository root the tree was taken in — a snapshot is not portable. */
  root: string;
  /** The tree object recording the working tree at snapshot time. */
  tree: string;
  /**
   * Submodules already holding invisible edits at snapshot time. Dirt that
   * predates the fix is not the fix's doing: a no-op fix in such a repository
   * must still hear "nothing was applied", not a claim that invisible edits
   * exist.
   */
  dirtySubmodules: string[];
}

/**
 * Review-owned directories that change between the two states and are never
 * a fix. Matched at any depth: the review writes them under the directory it
 * was run from, which is the repository root in the common case and a
 * subdirectory otherwise.
 */
export const FIX_DELTA_EXCLUDES = [
  '.qwen/tmp',
  '.qwen/reviews',
  '.qwen/review-cache',
] as const;

/**
 * The git directory's path relative to `root` when it sits INSIDE the
 * worktree, otherwise null. A checkout normally cannot see its git dir — git
 * never records the conventional `.git` — but `git init --separate-git-dir`
 * and `.git` files that redirect into the tree make it ordinary capturable
 * content there: without an exclusion the snapshot trees would carry the
 * whole git dir, and the loose objects `write-tree` creates between the two
 * states would flood the hunks with object churn.
 */
function inTreeGitDir(root: string): string | null {
  const gitDir = git('-C', root, 'rev-parse', '--absolute-git-dir');
  const rel = relative(root, gitDir);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  return rel;
}

/**
 * Record the working tree under `root` as a tree object and return its sha.
 * Runs through a throwaway index so the user's index is untouched.
 */
export function snapshotWorkingTree(root: string): string {
  // The scratch index must live OUTSIDE anything the snapshot can capture:
  // os.tmpdir() honours TMPDIR, and a hermetic sandbox pointing it inside the
  // worktree made `add -A` record the scratch directory itself into the
  // trees — the command's own temp files reported as fix edits. The git dir
  // is the usual such place, and the rare repository whose git dir sits
  // inside its worktree is covered by the git-dir exclusion in
  // `excludePathspec`, which keeps the scratch dir out of the trees with it.
  const gitDir = git('-C', root, 'rev-parse', '--absolute-git-dir');
  const scratch = mkdtempSync(join(gitDir, 'qwen-fix-delta-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    // An unborn HEAD (a repo with no commit yet) has no tree to seed from —
    // start empty, and `add -A` records everything as added.
    // Probed IN `root`, not in the process cwd: every other call here carries
    // `-C root`, and a bare `rev-parse HEAD` answers for whatever repository
    // the process happens to sit in.
    if (
      gitOpt('-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD') !== null
    ) {
      gitWithEnv(env, ['-C', root, 'read-tree', 'HEAD']);
    } else {
      gitWithEnv(env, ['-C', root, 'read-tree', '--empty']);
    }
    // `--sparse`: in a sparse-checkout repository `add` refuses to run once
    // ANY untracked file — e.g. this command's own side file — sits outside
    // the cone. Out-of-cone tracked entries drop identically from both trees,
    // so the delta is unaffected, and the flag is a no-op elsewhere.
    gitWithEnv(env, [
      '-C',
      root,
      'add',
      '-A',
      '--sparse',
      '--',
      ...excludePathspec(root),
    ]);
    return gitWithEnv(env, ['-C', root, 'write-tree']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The pathspec half of every capture and tree comparison: review side files
 * excluded, and — in the rare repository whose git dir sits inside its
 * worktree — the git dir with them.
 */
function excludePathspec(root: string): string[] {
  const specs = [
    '.',
    ...FIX_DELTA_EXCLUDES.map((p) => `:(glob,exclude)**/${p}/**`),
  ];
  const gitDir = inTreeGitDir(root);
  if (gitDir !== null) {
    specs.push(`:(exclude)${gitDir}`);
  }
  return specs;
}

/** The patch between two trees of this repository, review side files excluded. */
function patchBetweenTrees(
  root: string,
  fromTree: string,
  toTree: string,
): string {
  return gitRaw(
    '-C',
    root,
    'diff-tree',
    '-r',
    '-p',
    '-M',
    '--no-color',
    '--no-ext-diff',
    fromTree,
    toTree,
    '--',
    ...excludePathspec(root),
  ).toString('utf8');
}

/**
 * The files that differ between two trees, taken from git's own listing.
 * Re-parsing the rendered patch instead miscounts and mangles: with default
 * `core.quotePath` a non-ASCII path renders quoted (`"a/src/\346…"`) and
 * drops out of an anchored header regex, and a path containing a space
 * matches but yields a garbled name. `-z` prints raw NUL-separated names —
 * one per file, a rename counted once, under its new name.
 */
function filesBetweenTrees(
  root: string,
  fromTree: string,
  toTree: string,
): string[] {
  const raw = gitRaw(
    '-C',
    root,
    'diff-tree',
    '-r',
    '--name-only',
    '-z',
    '-M',
    fromTree,
    toTree,
    '--',
    ...excludePathspec(root),
  ).toString('utf8');
  return raw.split('\0').filter((name) => name !== '');
}

/**
 * Whether a nested repository's own status shows uncommitted content. A probe
 * that cannot run answers dirty: the failure direction over-warns, it never
 * silences a blind spot.
 */
function nestedRepoIsDirty(absPath: string): boolean {
  const inner = gitOpt(
    '-C',
    absPath,
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--ignore-submodules=none',
  );
  return inner === null || inner !== '';
}

/**
 * Paths holding edits a superproject tree cannot record: submodule checkouts
 * and nested git repositories. Either enters the tree as its gitlink alone —
 * an edit inside that is not committed there moves no gitlink, so both
 * snapshots stay byte-identical while the fix is on disk. Porcelain-v2 names
 * them across several entry classes, and the triggers are checkout states a
 * fix can land on top of without creating, so the probe parses them all:
 *
 * - `1` entries carry a 4-char sub token — `S` plus a new-commits flag, a
 *   modified-content flag and an untracked-content flag, `.` where none
 *   (probed shapes: `SC..`, `S.M.`, `SCMU`, `S..U`) — and the last two flags
 *   are the invisible content. A new-commits flag alone is visible (the
 *   gitlink moved) and is not reported. The mode fields are NOT pinned: the
 *   interim `submodule add` state prints a 000000 HEAD slot, a staged
 *   deletion prints `160000 000000 000000`.
 * - `2` entries — a staged gitlink rename: the score is space-separated, the
 *   new path ends the record, and the original path follows as its own NUL
 *   element — consumed, never reported.
 * - `u` entries — an unmerged gitlink: four mode fields, three hashes, the
 *   path last.
 * - `?` entries collapsed to a directory — under `showUntrackedFiles=all`
 *   only a nested git repository survives unexpanded, and `add -A` records
 *   its gitlink all the same. The same line names a staged-deleted gitlink,
 *   whose `1 D. S...` twin carries no dirt flags for git to compute. A `?`
 *   entry carries NO dirt flag of its own, so the branch probes inside and
 *   counts only a repository with uncommitted content — stamping a clean one
 *   dirty would print a false pre-existing note on a no-op run, and would
 *   filter a fix's real interior edit out of the baseline into a false
 *   all-clear.
 *
 * The status runs with `-z`: entries are NUL-terminated and paths RAW. The
 * rendered form C-quotes any name that needs it (a non-ASCII name under
 * default `core.quotePath`, a tab, a quote or a backslash), and a quoted
 * `? ` path neither ends in '/' nor resolves — the repository would be
 * skipped silently while invisible edits land inside it.
 */
function dirtySubmodulePaths(root: string): string[] {
  // `--no-optional-locks`: plain `status` opportunistically rewrites the
  // user's index to refresh its stat cache — a write this command promises
  // never to make. `-c status.showUntrackedFiles=all`: the untracked-content
  // flag is computed by a status run INSIDE each submodule reading the user's
  // config; with `showUntrackedFiles=no` there, a submodule whose only
  // invisible edit is untracked content emits no entry at all, and only a
  // `-c` override (not `--untracked-files`) propagates to that inner run.
  const status = gitRaw(
    '-C',
    root,
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--ignore-submodules=none',
    '-z',
  ).toString('utf8');
  const dirty = new Set<string>();
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith('? ')) {
      const path = entry.slice(2);
      if (
        path.endsWith('/') &&
        existsSync(join(root, path, '.git')) &&
        nestedRepoIsDirty(join(root, path.slice(0, -1)))
      ) {
        dirty.add(path.slice(0, -1));
      }
      continue;
    }
    const fields = entry.split(' ');
    const kind = fields[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    const sub = fields[2];
    if (sub.length !== 4 || !sub.startsWith('S')) continue;
    // Modified-content or untracked-content flag: the invisible content.
    if (sub[2] === '.' && sub[3] === '.') continue;
    // A rename's original path rides the next NUL element.
    if (kind === '2') i++;
    dirty.add(
      kind === '1'
        ? fields.slice(8).join(' ')
        : kind === 'u'
          ? fields.slice(10).join(' ')
          : fields.slice(9).join(' '),
    );
  }
  return [...dirty];
}

/** The blind-spot warning, phrased for an empty or an under-reporting hunks file. */
function submoduleBlindSpot(dirty: string[], hunksEmpty: boolean): string {
  const one = dirty.length === 1;
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${dirty.join(', ')} ` +
    `${one ? 'holds' : 'hold'} uncommitted edits this command cannot see — ` +
    'a snapshot records only the superproject tree, and a submodule enters ' +
    'it as its gitlink alone, so edits inside a submodule are outside this ' +
    'model until they are committed there. ' +
    (hunksEmpty
      ? 'The hunks file stays empty; the audit cannot see the edit.'
      : 'The hunks file does not show them; the audit cannot see those edits.')
  );
}

/** Pre-existing submodule dirt, named so the silence is not read as oversight. */
function preExistingDirtNote(dirty: string[]): string {
  const one = dirty.length === 1;
  const them = one ? 'it' : 'them';
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${dirty.join(', ')} ` +
    'already held uncommitted content at snapshot time — pre-existing dirt, ' +
    `not reported as a blind spot because nothing newly dirtied ${them}. ` +
    `Edits inside ${them} since remain invisible to this command.`
  );
}

/** Snapshot-time dirt that vanished: content changed between the two states. */
function cleanedSubmoduleNote(cleaned: string[]): string {
  const one = cleaned.length === 1;
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${cleaned.join(', ')} ` +
    'held uncommitted content at snapshot time that is gone now — content ' +
    `inside ${one ? 'it' : 'them'} changed between the two states, ` +
    'invisible to this command.'
  );
}

export interface FixDeltaArgs {
  snapshot: boolean;
  since?: string;
  out: string;
}

export function runFixDelta(args: FixDeltaArgs): void {
  if (args.snapshot === Boolean(args.since)) {
    throw new Error(
      'fix-delta: pass exactly one of --snapshot (record the tree before the ' +
        'first edit) or --since <snapshot.json> (diff the tree now against it).',
    );
  }
  const root = git('rev-parse', '--show-toplevel');
  mkdirSync(dirname(resolve(args.out)), { recursive: true });

  if (args.snapshot) {
    const tree = snapshotWorkingTree(root);
    const snapshot: FixSnapshot = {
      root,
      tree,
      dirtySubmodules: dirtySubmodulePaths(root),
    };
    writeFileSync(resolve(args.out), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeStderrLine(`fix-delta: snapshot ${tree.slice(0, 12)} of ${root}`);
    return;
  }

  let snapshot: FixSnapshot;
  try {
    const raw = JSON.parse(readFileSync(args.since as string, 'utf8')) as {
      root?: unknown;
      tree?: unknown;
      dirtySubmodules?: unknown;
    };
    if (
      typeof raw.root !== 'string' ||
      !/^[0-9a-f]{40,64}$/.test(String(raw.tree))
    ) {
      throw new Error('not a fix-delta snapshot ({root, tree})');
    }
    snapshot = {
      root: raw.root,
      tree: raw.tree as string,
      dirtySubmodules: Array.isArray(raw.dirtySubmodules)
        ? raw.dirtySubmodules.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch (err) {
    throw new Error(
      `fix-delta: cannot read the snapshot ${args.since}: ${(err as Error).message}. ` +
        'Pass the file `fix-delta --snapshot --out <file>` wrote before the edits.',
    );
  }
  if (resolve(snapshot.root) !== resolve(root)) {
    throw new Error(
      `fix-delta: the snapshot was taken in ${snapshot.root}, but this is ${root}. ` +
        'A snapshot diffs only against the tree it recorded.',
    );
  }
  if (
    gitOpt('-C', root, 'cat-file', '-e', `${snapshot.tree}^{tree}`) === null
  ) {
    throw new Error(
      `fix-delta: the snapshot tree ${snapshot.tree.slice(0, 12)} is not in this ` +
        'repository. Take the snapshot in the same checkout the edits are applied in.',
    );
  }

  const now = snapshotWorkingTree(root);
  const diff =
    now === snapshot.tree ? '' : patchBetweenTrees(root, snapshot.tree, now);
  writeFileSync(resolve(args.out), diff);
  // Edits inside a submodule never move its gitlink, so the tree comparison
  // is blind to them whether or not the superproject diff is empty — probe
  // in both cases. Dirt recorded at snapshot time is not the fix's doing;
  // only NEW dirt names a blind spot.
  const dirtyNow = dirtySubmodulePaths(root);
  const freshDirt = dirtyNow.filter(
    (p) => !snapshot.dirtySubmodules.includes(p),
  );
  const preExisting = dirtyNow.filter((p) =>
    snapshot.dirtySubmodules.includes(p),
  );
  // The third transition the baseline can see: dirt at snapshot time that is
  // GONE now necessarily changed on disk between the two states — a clean
  // submodule emits no status entry and the gitlink never moved, so without
  // this the "nothing was applied" claim would be provably false.
  const cleaned = snapshot.dirtySubmodules.filter((p) => !dirtyNow.includes(p));
  if (diff.trim() === '') {
    if (preExisting.length > 0) {
      writeStderrLine(preExistingDirtNote(preExisting));
    }
    if (freshDirt.length > 0) {
      writeStderrLine(submoduleBlindSpot(freshDirt, true));
    }
    if (cleaned.length > 0) {
      writeStderrLine(cleanedSubmoduleNote(cleaned));
    }
    if (freshDirt.length === 0 && cleaned.length === 0) {
      writeStderrLine(
        'fix-delta: the tree is unchanged since the snapshot — nothing was applied ' +
          '(or the snapshot was taken after the edits).',
      );
    }
    return;
  }
  const files = filesBetweenTrees(root, snapshot.tree, now);
  const shown = files.slice(0, 8).join(', ');
  writeStderrLine(
    `fix-delta: ${files.length} file(s) changed since the snapshot — ${shown}` +
      (files.length > 8 ? `, and ${files.length - 8} more` : ''),
  );
  if (preExisting.length > 0) {
    writeStderrLine(preExistingDirtNote(preExisting));
  }
  if (freshDirt.length > 0) {
    writeStderrLine(submoduleBlindSpot(freshDirt, false));
  }
  if (cleaned.length > 0) {
    writeStderrLine(cleanedSubmoduleNote(cleaned));
  }
}

export const fixDeltaCommand: CommandModule = {
  command: 'fix-delta',
  describe:
    'Record the working tree before `--fix` edits it (--snapshot), then diff ' +
    'the tree against that record after the edits (--since): the hunks the fix ' +
    'applied, and nothing else, for the Step 6B fix audit. Never writes the ' +
    "user's index or the stash.",
  builder: (yargs) =>
    yargs
      .option('snapshot', {
        type: 'boolean',
        describe: 'Record the working tree now, as a tree object, into --out',
      })
      .option('since', {
        type: 'string',
        describe:
          'A snapshot file from --snapshot; writes the diff from it to the ' +
          'tree now into --out (review side files under .qwen/ excluded)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the snapshot (JSON) or the diff',
      }),
  handler: (argv) => {
    runFixDelta({
      snapshot: argv['snapshot'] === true,
      since: argv['since'] as string | undefined,
      out: argv['out'] as string,
    });
  },
};
