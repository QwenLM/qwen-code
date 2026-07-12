/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Capture the working tree's diff for a local /review — staged, unstaged, AND
// untracked.
//
// Why the third one is not a nicety: `git diff HEAD` reports changes to files
// git already tracks. A file the user created and has not `git add`ed is in
// neither the index nor HEAD, so it appears in **no** `git diff` output at all.
// The review therefore skipped brand-new files entirely — a new payment path, a
// new auth middleware, the whole file invisible — and when the new file was the
// *only* change, /review reported "no changes to review" and stopped.
//
// The fix must not fix it by staging things. `git add -N` would make untracked
// files show up in `git diff HEAD`, and it would do so by **writing to the
// user's index** — the same class of side effect the mandatory-worktree rule
// exists to prevent. Every new file would silently become a tracked, staged
// path in the user's repo because they asked for a code review. So each
// untracked file is diffed against `/dev/null` with `--no-index`, which touches
// nothing, and the sections are concatenated onto the tracked diff. A unified
// diff is a concatenation of per-file sections; the result parses exactly like
// any other.

import { lstatSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import {
  NULL_DEVICE,
  PINNED_DIFF_CONFIG,
  PINNED_DIFF_FLAGS,
} from './diff-flags.js';
import { git, gitRaw, gitRawTolerateDiff, refExists } from './git.js';

/**
 * Untracked files above this size are named but not diffed.
 *
 * An untracked file is whatever the user happened to leave in the tree, and
 * `--exclude-standard` only filters what `.gitignore` covers. A 200 MB core
 * dump, a captured pcap, a vendored tarball that nobody ignored: inlining one
 * into the review diff buys nothing and pushes every real hunk past the chunk
 * planner's budget. They are reported to the caller instead of dropped in
 * silence — a review that quietly skipped a file is the bug this module exists
 * to fix, and re-introducing it one size class up would be a poor trade.
 */
export const MAX_UNTRACKED_BYTES = 1_000_000;

/**
 * Ceilings on the untracked pass as a whole.
 *
 * `MAX_UNTRACKED_BYTES` bounds any one file; nothing bounded the *set*, and each
 * untracked file costs one synchronous `git` spawn. A working tree whose
 * `.gitignore` does not yet cover `node_modules` — `git init` followed by
 * `npm install`, which is a normal Tuesday — offers tens of thousands of
 * untracked files, and the capture would sit there spawning `git` once per file
 * for minutes before the review began. The old bug made `/review` show nothing;
 * an unbounded fix would make it hang, which is not obviously an improvement.
 *
 * A count this far above any real change (500 new files in one review is already
 * extraordinary; `node_modules` is a hundred times that) means the tree's ignore
 * rules are broken, not that the user wrote a lot of code. So the pass is
 * abandoned wholesale rather than reviewing an arbitrary alphabetical prefix of
 * a build directory — and, being checked before the loop, it costs zero spawns.
 * The user is told, loudly, in the one place that can act on it.
 */
export const MAX_UNTRACKED_FILES = 500;
export const MAX_UNTRACKED_TOTAL_BYTES = 10_000_000;

/** An untracked file the capture did not review, and why. Never dropped mutely. */
export interface SkippedFile {
  path: string;
  /** Size in bytes, or null when the file could not be stat-ed at all. */
  bytes: number | null;
  reason: string;
}

export interface LocalDiffCapture {
  /** The captured diff: tracked sections first, then untracked ones. */
  diff: Buffer;
  /** Untracked files whose full contents were added to the diff. */
  untracked: string[];
  /** Untracked files that were NOT reviewed. Report every one of them. */
  skipped: SkippedFile[];
  /** True when HEAD does not exist yet (a repo with no commits). */
  unbornHead: boolean;
}

/**
 * The empty tree, in this repository's object format.
 *
 * `git diff <empty-tree>` is what "everything is new" means to git, and it is
 * what an unborn HEAD needs — `git diff HEAD` in a repo with no commits fails
 * outright ("fatal: bad revision 'HEAD'") rather than treating everything as
 * new. The famous `4b825dc…` is the SHA-**1** empty tree and is simply not an
 * object in a SHA-256 repository, so hardcoding it trades one hard failure for
 * a rarer one. Ask git instead; `hash-object` without `-w` computes and writes
 * nothing.
 */
function emptyTree(repoRoot: string): string {
  return git('-C', repoRoot, 'hash-object', '-t', 'tree', NULL_DEVICE);
}

/**
 * Why git will not be able to diff this entry as a file, or null if it will.
 *
 * `ls-files --others` names three kinds of thing — regular files, symlinks, and
 * directories (it silently ignores FIFOs, sockets and device nodes, so those
 * never arrive here). Directories are the problem, and git's `--no-index`
 * decides what an argument *is* from its **resolved** type:
 *
 * - An **embedded git repository** arrives as `nested/`. Git will not recurse
 *   into another repo, so it hands back the directory itself; `--no-index` then
 *   switches to directory-diff semantics and joins the other operand into it
 *   (`error: Could not access 'nested/null'`).
 * - A **symlink to a directory** arrives as a plain name and resolves the same
 *   way, which is why `lstat` alone cannot judge it and this follows the link
 *   before deciding.
 * - A **symlink to a file** is diffable and must pass: git renders the *link
 *   text* at mode 120000. A **dangling** symlink is diffable for the same reason
 *   — the link text does not depend on the target existing — and it is worth
 *   reviewing precisely *because* it points nowhere, so a failed `stat` here
 *   means "let git have it", not "skip".
 *
 * Anything unforeseen still fails closed: git either errors or produces nothing,
 * and the caller records it as unreviewed rather than as reviewed.
 */
function describeUndiffable(abs: string, st: Stats): string | null {
  if (st.isDirectory()) {
    return (
      'is a directory (an embedded git repository, most likely) — git cannot ' +
      'diff it as a file'
    );
  }
  if (st.isSymbolicLink()) {
    try {
      return statSync(abs).isDirectory()
        ? 'is a symlink to a directory — git cannot diff it as a file'
        : null;
    } catch {
      return null; // Dangling. Git diffs the link text; let it.
    }
  }
  return null;
}

/** Repo-root-relative paths of untracked, non-ignored files. */
function listUntracked(repoRoot: string, file?: string): string[] {
  const args = [
    '-C',
    repoRoot,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--full-name',
    '-z',
  ];
  // `--` separates paths from options, so a file named `--cached` cannot be
  // read as a flag.
  if (file) args.push('--', file);
  const out = gitRaw(...args).toString('utf8');
  // `-z` because a filename may legally contain a newline. Splitting on '\n'
  // would turn one such file into two nonexistent ones.
  return out.split('\0').filter((p) => p !== '');
}

/**
 * Diff one untracked file against `/dev/null`.
 *
 * Runs from the repo root with a root-relative path, so the `+++ b/<path>`
 * header git writes matches what `git diff HEAD --no-relative` writes for
 * tracked files. Without that, a capture started from a subdirectory would
 * label tracked files from the repo root and untracked ones from the cwd, and
 * two names for one directory tree is how an anchor stops matching.
 */
function diffUntracked(repoRoot: string, path: string): Buffer {
  return gitRawTolerateDiff(
    '-C',
    repoRoot,
    ...PINNED_DIFF_CONFIG,
    'diff',
    '--no-index',
    ...PINNED_DIFF_FLAGS,
    '--',
    NULL_DEVICE,
    path,
  );
}

/**
 * Capture staged + unstaged + untracked changes as one unified diff.
 *
 * `file` scopes the capture to a single path (a `/review <file-path>` target).
 * Nothing here writes to the index, the worktree, or any ref.
 */
export function captureLocalDiff(opts: {
  file?: string;
  includeUntracked?: boolean;
}): LocalDiffCapture {
  const { file, includeUntracked = true } = opts;
  // Everything below runs against the repo *root*, not the process's cwd. A
  // capture started from a subdirectory must still see the whole working tree —
  // and, more subtly, must label its files the same way `git diff --no-relative`
  // does, or the tracked and untracked halves of one diff would name the same
  // directory tree two different ways.
  const repoRoot = git('rev-parse', '--show-toplevel');

  // A repo with no commits has no HEAD to diff against, and `git diff HEAD`
  // there fails outright ("fatal: bad revision 'HEAD'") rather than treating
  // everything as new. Diff against the empty tree instead, which is what
  // "everything is new" means to git.
  const unbornHead = !refExists('HEAD');
  const base = unbornHead ? emptyTree(repoRoot) : 'HEAD';

  // `git diff HEAD` is what covers the whole tracked scope: a bare `git diff`
  // omits staged changes.
  const trackedArgs = [
    '-C',
    repoRoot,
    ...PINNED_DIFF_CONFIG,
    'diff',
    ...PINNED_DIFF_FLAGS,
    base,
  ];
  if (file) trackedArgs.push('--', file);
  const parts: Buffer[] = [gitRaw(...trackedArgs)];

  const untracked: string[] = [];
  const skipped: SkippedFile[] = [];

  if (includeUntracked) {
    const candidates = listUntracked(repoRoot, file);

    if (candidates.length > MAX_UNTRACKED_FILES) {
      // Checked before the loop: the whole point is to spend zero spawns on a
      // tree whose ignore rules are broken.
      skipped.push({
        path: `${candidates.length} untracked files`,
        bytes: null,
        reason:
          `${candidates.length} untracked files exceeds the ` +
          `${MAX_UNTRACKED_FILES}-file cap, so NONE of them were reviewed. ` +
          `A count this size usually means .gitignore does not cover a build ` +
          `or dependency directory. Ignore them, or stage the ones you want ` +
          `reviewed, or re-run with untracked capture off.`,
      });
    } else {
      let budget = MAX_UNTRACKED_TOTAL_BYTES;
      for (const path of candidates) {
        let bytes: number;
        try {
          // `lstat`, not `stat`. Two things turn on it.
          //
          // `ls-files --others` names directory-shaped entries: an embedded git
          // repo comes out as `nested/`, and a symlink to a directory as a plain
          // name. `stat` follows the link and succeeds on both, and git then
          // fails to diff them — quietly, because it fails by exiting 1 with no
          // output, which used to read as "an empty diff". The path was recorded
          // as reviewed and nobody had looked at it: the exact lie this module
          // exists to prevent, and worse than the old bug, which at least never
          // claimed otherwise. A FIFO is worse still — git *blocks* reading it,
          // and the review hangs until the git timeout fires.
          //
          // And a symlink to a 5 MB file is 20 bytes of link text to git, not
          // 5 MB, so `stat`'s size would skip it against the wrong number.
          const abs = join(repoRoot, path);
          const st = lstatSync(abs);
          const kind = describeUndiffable(abs, st);
          if (kind) {
            skipped.push({ path, bytes: null, reason: kind });
            continue;
          }
          bytes = st.size;
        } catch (err) {
          // A path `ls-files` just named can still be unreachable: a build
          // script's scratch file removed underneath us, or a name whose bytes
          // do not survive the round-trip through a JS string on this platform.
          // Skipping it must not take the whole capture down — but it must not
          // be silent either.
          skipped.push({
            path,
            bytes: null,
            reason: `could not be read (${(err as Error).message})`,
          });
          continue;
        }

        if (bytes > MAX_UNTRACKED_BYTES) {
          skipped.push({
            path,
            bytes,
            reason: `${Math.round(bytes / 1000)} kB exceeds the ${Math.round(
              MAX_UNTRACKED_BYTES / 1000,
            )} kB untracked-file cap`,
          });
          continue;
        }
        if (bytes > budget) {
          skipped.push({
            path,
            bytes,
            reason:
              `the untracked capture reached its ` +
              `${Math.round(MAX_UNTRACKED_TOTAL_BYTES / 1_000_000)} MB total cap`,
          });
          continue;
        }

        let section: Buffer;
        try {
          section = diffUntracked(repoRoot, path);
        } catch (err) {
          // Fail closed. Whatever git could not render — a special file that
          // slipped the lstat gate, a permissions wall, a name it will not take
          // — is a file nobody reviewed, and it says so rather than joining
          // `untracked`, which claims the opposite.
          skipped.push({
            path,
            bytes,
            reason: `git could not diff it (${(err as Error).message.trim()})`,
          });
          continue;
        }

        budget -= bytes;
        parts.push(section);
        untracked.push(path);
      }
    }
  }

  return { diff: Buffer.concat(parts), untracked, skipped, unbornHead };
}
