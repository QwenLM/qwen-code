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
import type { Dirent } from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
   * Paths already holding invisible edits at snapshot time: submodule
   * checkouts and nested git repositories, including ones a symlink reaches
   * or an ignored directory hides. Dirt that predates the fix is not the
   * fix's doing: a no-op fix in such a repository must still hear "nothing
   * was applied", not a claim that invisible edits exist.
   */
  dirtySubmodules: string[];
}

/**
 * The review's own NAME families under `.qwen/tmp` — everything the flow
 * creates between the two states: the side files (`qwen-review-{target}-*`)
 * and the worktree family (`review-pr-*`). Keyed on the names the flow
 * itself writes, never on whole directories: content a user's repository
 * tracks under `.qwen/tmp` or `.qwen/reviews` is ordinary reviewable
 * content — a finding can anchor on it and `--fix` can edit it, and a
 * directory-wide exclusion dropped exactly that edit from both capture and
 * comparison.
 */
export const FIX_DELTA_EXCLUDES = [
  '.qwen/tmp/qwen-review-*',
  '.qwen/tmp/review-pr-*',
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
 * The exclusion is lexical — a symlink planted at an excluded directory
 * redirects every side-file write through it into a physical path no
 * pathspec matches, so the capture would report the review's own
 * bookkeeping (or an attacker's content) as fix edits. Refuse, the way
 * `releaseWorktree` refuses a redirected ancestor: the failure direction
 * stops the run, it never contaminates it.
 */
function assertNoRedirectedExcludes(root: string): void {
  const targets = new Set<string>();
  for (const chain of [join('.qwen', 'tmp'), inTreeGitDir(root) ?? '']) {
    let acc = '';
    for (const part of chain.split(sep)) {
      if (part === '') continue;
      acc = acc === '' ? part : join(acc, part);
      targets.add(acc);
    }
  }
  for (const rel of targets) {
    let link = false;
    try {
      link = lstatSync(join(root, rel)).isSymbolicLink();
    } catch {
      continue;
    }
    if (link) {
      throw new Error(
        `fix-delta: excluded directory ${rel} is a symlink; refusing to ` +
          'write side files outside the exclusion.',
      );
    }
  }
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
    try {
      gitWithEnv(env, [
        '-C',
        root,
        'add',
        '-A',
        '--sparse',
        '--ignore-errors',
        '--',
        ...excludePathspec(root),
      ]);
    } catch (err) {
      // A nested git repository with ZERO commits is the only tolerated
      // failure: git refuses `add` on it ("does not have a commit checked
      // out"), and `--ignore-errors` has recorded everything else. The repo
      // stays invisible in both trees — the same model as submodule content —
      // and the blind-spot probe names it. Any other failure re-throws: a
      // blanket tolerance would mask skipped paths, under-capture the tree,
      // and hand the audit a false all-clear.
      if (
        !String((err as Error)?.message ?? '').includes(
          'does not have a commit checked out',
        )
      ) {
        throw err;
      }
    }
    return gitWithEnv(env, ['-C', root, 'write-tree']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The pathspec half of every capture, tree comparison, and blind-spot
 * probe: the review's own name families excluded — once as a file match and
 * once as a deep-content match, because a glob `*` does not cross `/` — and,
 * in the rare repository whose git dir sits inside its worktree, the git dir
 * with them. `literal` there: the dir name is raw path text, and the default
 * wildcard matching reads `[]`/`*`/`?` in it as a glob that drops merely
 * matching tracked files from capture and comparison.
 */
function excludePathspec(root: string): string[] {
  const specs = ['.'];
  for (const family of FIX_DELTA_EXCLUDES) {
    specs.push(`:(glob,exclude)**/${family}`, `:(glob,exclude)**/${family}/**`);
  }
  const gitDir = inTreeGitDir(root);
  if (gitDir !== null) {
    specs.push(`:(exclude,literal)${gitDir}`);
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
 * The state of a nested repository's own uncommitted content.
 * `--ignored=matching` on top of the untracked view: a repository whose
 * only uncommitted content matches its OWN ignore rules emits nothing to a
 * plain status, and an edit inside would classify clean in both states.
 *
 * `failed` is a state of its own, not dirt: the caller decides what an
 * unanswerable probe means for the baseline and for the warning. A name
 * that is not valid UTF-8 cannot reach the child intact — spawn coerces
 * every channel through UTF-8 — so the probe fails for it, and the failure
 * direction over-warns, it never silences a blind spot.
 */
function probeNestedRepoState(absPath: Buffer): 'clean' | 'dirty' | 'failed' {
  const inner = gitOpt(
    '-C',
    absPath.toString(),
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--ignore-submodules=none',
    '--ignored=matching',
  );
  if (inner === null) return 'failed';
  return inner === '' ? 'clean' : 'dirty';
}

/** Join a relative path given as raw bytes onto an absolute path. */
function joinBytes(abs: Buffer, rel: Buffer): Buffer {
  return Buffer.concat([abs, Buffer.from(sep), rel]);
}

const DOT_GIT = Buffer.from('.git');

/**
 * Decode a raw path for reporting: UTF-8 when the bytes ARE UTF-8 (the
 * everyday case), latin1 otherwise — a byte-preserving reading, so a name
 * the decode cannot represent still reaches the disclosure line instead of
 * mangling to U+FFFD and failing every filesystem check under it.
 */
function decodePath(raw: Buffer): string {
  const utf8 = raw.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(raw) ? utf8 : raw.toString('latin1');
}

/** Split a `-z` buffer on NUL bytes without a lossy string roundtrip. */
function splitNul(raw: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (;;) {
    const idx = raw.indexOf(0, start);
    if (idx === -1) {
      parts.push(raw.subarray(start));
      return parts;
    }
    parts.push(raw.subarray(start, idx));
    start = idx + 1;
  }
}

/**
 * The path of a kind-1/2/u status entry: everything after the entry's fixed
 * ASCII field count, taken from the raw entry bytes — modes, hashes, flags
 * and scores are ASCII, so the Nth space byte is exact even when the path
 * itself is not valid UTF-8.
 */
function pathAfterSpaces(entry: Buffer, spaces: number): Buffer {
  let off = 0;
  for (let n = 0; n < spaces; n++) {
    const idx = entry.indexOf(0x20, off);
    if (idx === -1) return entry.subarray(entry.length);
    off = idx + 1;
  }
  return entry.subarray(off);
}

/**
 * The number of directory entries the ignored-directory walk visits before
 * declaring the directory unresolvable. A repository can ignore an
 * arbitrarily deep tree (`node_modules` is the everyday case), and the walk
 * is the only discovery for nested repos hiding inside one, so it has to
 * start; equally, it must not enumerate a whole package store on every
 * snapshot. Past the budget the caller names the directory itself — the
 * failure direction over-warns, it never silences a blind spot.
 */
const IGNORED_WALK_BUDGET = 100_000;

/**
 * The nested repositories inside a collapsed ignored directory, found by
 * walking it: status never enumerates under an ignored path and `add -A`
 * records nothing there, so an edit inside such a repository is invisible
 * to both the probe's entry list and the tree comparison. Symlinked
 * children are tested as repo candidates but never descended through — a
 * link loop inside an ignored directory must not wedge the walk.
 */
function reposUnder(
  dirAbs: Buffer,
  dirRel: Buffer,
): { repos: Array<{ abs: Buffer; rel: Buffer }>; exhausted: boolean } {
  const repos: Array<{ abs: Buffer; rel: Buffer }> = [];
  let left = IGNORED_WALK_BUDGET;
  const queue: Array<{ abs: Buffer; rel: Buffer }> = [
    { abs: dirAbs, rel: dirRel },
  ];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    let entries: Array<Dirent<Buffer>>;
    try {
      entries = readdirSync(cur.abs, {
        encoding: 'buffer',
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (left-- === 0) {
        return { repos, exhausted: true };
      }
      const name = e.name;
      const childAbs = joinBytes(cur.abs, name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      const childRel = joinBytes(cur.rel, name);
      if (existsSync(joinBytes(childAbs, DOT_GIT))) {
        repos.push({ abs: childAbs, rel: childRel });
      } else {
        queue.push({ abs: childAbs, rel: childRel });
      }
    }
  }
  return { repos, exhausted: false };
}

function probeNestedRepo(
  abs: Buffer,
  rel: Buffer,
  dirty: Set<string>,
  recordFailed: boolean,
): void {
  const state = probeNestedRepoState(abs);
  if (state === 'dirty' || (recordFailed && state === 'failed')) {
    dirty.add(decodePath(rel));
  }
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
 *   element — consumed for EVERY kind-`2` entry, even a skipped one, so it
 *   is never parsed as an entry itself.
 * - `u` entries — an unmerged gitlink: four mode fields, three hashes, the
 *   path last.
 * - `?` entries — under `showUntrackedFiles=all` only a nested git
 *   repository survives unexpanded as `? <dir>/`, and `add -A` records its
 *   gitlink all the same. The same collapsed line names a staged-deleted
 *   gitlink, whose `1 D. S...` twin carries no dirt flags for git to
 *   compute. A slashLESS `?` entry is probed too when it is a symlink: the
 *   link itself is what `add -A` records, so an edit through it into the
 *   repository it reaches is invisible the same way.
 * - `!` entries — `--ignored=matching` collapses an ignored directory to
 *   `! <dir>/`, and neither status nor `add -A` ever looks inside one, so
 *   nested repositories hidden there are discovered by walking the
 *   directory. A `?`/`!` entry carries NO dirt flag of its own, so every
 *   candidate is probed inside and only a repository with uncommitted
 *   content counts — stamping a clean one dirty would print a false
 *   pre-existing note on a no-op run, and would filter a fix's real
 *   interior edit out of the baseline into a false all-clear.
 *
 * The status runs with `-z` and is parsed as raw bytes: entries are
 * NUL-terminated and paths unquoted, and the rendered form C-quotes any name
 * that needs it (a non-ASCII name under default `core.quotePath`, a tab, a
 * quote or a backslash) — or cannot represent it at all when the bytes are
 * not valid UTF-8. A quoted or mangled path neither ends in '/' nor
 * resolves, so the repository would be skipped silently while invisible
 * edits land inside it.
 *
 * `recordFailed`: whether a nested-repo probe that CANNOT RUN counts as
 * dirty. `--since` passes true — an unanswerable probe beside the verdict
 * must over-warn, never fall silent. `--snapshot` passes false — the
 * baseline records only confirmed dirt, so an unprobed repository at
 * snapshot time still reads as NEW dirt once the fix lands inside it.
 */
function dirtySubmodulePaths(root: string, recordFailed: boolean): string[] {
  // `--no-optional-locks`: plain `status` opportunistically rewrites the
  // user's index to refresh its stat cache — a write this command promises
  // never to make. `-c status.showUntrackedFiles=all`: the untracked-content
  // flag is computed by a status run INSIDE each submodule reading the user's
  // config; with `showUntrackedFiles=no` there, a submodule whose only
  // invisible edit is untracked content emits no entry at all, and only a
  // `-c` override (not `--untracked-files`) propagates to that inner run.
  // The exclusion pathspec: capture and the tree comparisons apply it, so the
  // probe must too — otherwise the review's own worktrees and side files
  // under `.qwen/tmp` would be classified as blind-spot submodule dirt.
  const raw = gitRaw(
    '-C',
    root,
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--ignore-submodules=none',
    '--ignored=matching',
    '-z',
    '--',
    ...excludePathspec(root),
  );
  const rootBuf = Buffer.from(root);
  const dirty = new Set<string>();
  const entries = splitNul(raw);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 2) continue;
    const head = entry[0];
    if (head === 0x3f /* ? */ || head === 0x21 /* ! */) {
      const rel = entry.subarray(2);
      if (rel[rel.length - 1] === 0x2f /* / */) {
        const dirRel = rel.subarray(0, rel.length - 1);
        const dirAbs = joinBytes(rootBuf, dirRel);
        if (head === 0x21 && !existsSync(joinBytes(dirAbs, DOT_GIT))) {
          // Collapsed ignored directory that is not itself a repository:
          // the only way in is to walk it.
          const found = reposUnder(dirAbs, dirRel);
          for (const r of found.repos) {
            probeNestedRepo(r.abs, r.rel, dirty, recordFailed);
          }
          if (found.exhausted) {
            dirty.add(decodePath(dirRel));
          }
        } else {
          probeNestedRepo(dirAbs, dirRel, dirty, recordFailed);
        }
        continue;
      }
      // Slashless: a plain file, or a symlink that may reach a repository.
      let isLink = false;
      try {
        isLink = lstatSync(joinBytes(rootBuf, rel)).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) continue;
      const abs = joinBytes(rootBuf, rel);
      try {
        if (!statSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(joinBytes(abs, DOT_GIT))) continue;
      probeNestedRepo(abs, rel, dirty, recordFailed);
      continue;
    }
    const fields = entry.toString('utf8').split(' ');
    const kind = fields[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    // A rename's original path rides the next NUL element — consumed even
    // when the entry is skipped below, so it is never parsed as an entry
    // itself (a name like `u x` would re-enter the stream and die on a
    // missing field).
    if (kind === '2') i++;
    const sub = fields[2];
    if (sub.length !== 4 || !sub.startsWith('S')) continue;
    // Modified-content or untracked-content flag: the invisible content.
    if (sub[2] === '.' && sub[3] === '.') continue;
    dirty.add(
      decodePath(
        pathAfterSpaces(entry, kind === '1' ? 8 : kind === '2' ? 9 : 10),
      ),
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
  assertNoRedirectedExcludes(root);
  mkdirSync(dirname(resolve(args.out)), { recursive: true });

  if (args.snapshot) {
    const tree = snapshotWorkingTree(root);
    const snapshot: FixSnapshot = {
      root,
      tree,
      // `recordFailed` false: the baseline holds only CONFIRMED dirt. A
      // probe that cannot run is recorded at `--since` time (the failure
      // direction over-warns), but never as pre-existing — unconfirmed dirt
      // cannot be blamed on "already there", or a fix's real edit inside
      // would filter into a false all-clear.
      dirtySubmodules: dirtySubmodulePaths(root, false),
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
  const dirtyNow = dirtySubmodulePaths(root, true);
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
